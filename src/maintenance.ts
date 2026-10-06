import { readdir, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config';
import { dateBeforeDays, nowIso, type SqliteDatabase } from './db';
import { hashFile, resolveStoragePath } from './file-store';

interface ObjectRow {
  id: string;
  public_id?: string;
  sha256: string;
  size_bytes: number;
  storage_key: string;
  created_at: string;
  state: 'verified' | 'missing' | 'corrupt' | 'quarantined';
}

function gcCandidates(db: SqliteDatabase, cutoff: string, now: string, objectIds: string[], limit: number): ObjectRow[] {
  if (objectIds.length === 0) return [];
  const placeholders = objectIds.map(() => '?').join(', ');
  return db.prepare(`
    SELECT o.id, o.sha256, o.size_bytes, o.storage_key, o.created_at, o.state
    FROM objects o
    WHERE o.created_at <= ?
      AND (o.id IN (${placeholders}) OR o.public_id IN (${placeholders}))
      AND o.state <> 'quarantined'
      AND NOT EXISTS (SELECT 1 FROM object_bindings b WHERE b.object_id = o.id)
      AND NOT EXISTS (
        SELECT 1 FROM upload_sessions s
        WHERE s.state IN ('open', 'uploading') AND s.expires_at > ?
          AND (s.expected_sha256 IS NULL OR s.expected_sha256 = o.sha256)
      )
      AND NOT EXISTS (
        SELECT 1 FROM private_download_tokens t
        WHERE t.object_id = o.id AND t.expires_at > ?
      )
    ORDER BY o.created_at ASC, o.id ASC
    LIMIT ?
  `).all(cutoff, ...objectIds, ...objectIds, now, now, limit) as ObjectRow[];
}

export interface GcResult {
  run_id: string;
  candidates: number;
  bytes_reclaimable: number;
  deleted: number;
  skipped: number;
  failed: number;
  dry_run: boolean;
}

export interface GcOptions {
  dryRun: boolean;
  limit: number;
  objectIds: string[];
  confirm: boolean;
}

export async function runGarbageCollection(db: SqliteDatabase, config: AppConfig, options: GcOptions): Promise<GcResult> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new Error('GC limit must be between 1 and 100');
  if (options.objectIds.length === 0 || options.objectIds.length > 100) throw new Error('GC requires between 1 and 100 object IDs');
  if (new Set(options.objectIds).size !== options.objectIds.length) throw new Error('GC object IDs must be unique');
  if (!options.dryRun && !options.confirm) throw new Error('GC deletion requires explicit confirmation');
  const cutoff = dateBeforeDays(config.gcGraceDays);
  const now = nowIso();
  const runId = randomUUID();
  db.prepare(`
    INSERT INTO admin_gc_runs (id, created_at, status, dry_run, requested_limit, requested_object_ids)
    VALUES (?, ?, 'running', ?, ?, ?)
  `).run(runId, now, options.dryRun ? 1 : 0, options.limit, JSON.stringify(options.objectIds));
  try {
    const candidates = gcCandidates(db, cutoff, now, options.objectIds, options.limit);
    let bytesReclaimable = 0;
    for (const candidate of candidates) {
      try {
        const fileStat = await stat(resolveStoragePath(config.dataRoot, candidate.storage_key));
        if (fileStat.isFile()) bytesReclaimable += fileStat.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A missing file has no physical bytes to reclaim; the stale row is still collectible.
      }
      db.prepare(`
        INSERT INTO admin_gc_run_items (run_id, object_id, object_public_id, sha256, size_bytes, outcome, created_at)
        SELECT ?, id, public_id, sha256, size_bytes, 'eligible', ? FROM objects WHERE id = ?
      `).run(runId, nowIso(), candidate.id);
    }
    const result: GcResult = {
      run_id: runId,
      candidates: candidates.length,
      bytes_reclaimable: bytesReclaimable,
      deleted: 0,
      skipped: 0,
      failed: 0,
      dry_run: options.dryRun,
    };
    if (options.dryRun) {
      db.prepare(`UPDATE admin_gc_runs SET status = 'completed', completed_at = ?, candidates = ?, bytes_reclaimable = ? WHERE id = ?`)
        .run(nowIso(), result.candidates, result.bytes_reclaimable, runId);
      return result;
    }

    const deleteCandidate = db.transaction((candidate: ObjectRow): boolean => {
      const current = db.prepare(`
        SELECT o.id, o.sha256, o.size_bytes, o.storage_key, o.created_at, o.state
        FROM objects o
        WHERE o.id = ? AND o.created_at <= ? AND o.state <> 'quarantined'
          AND NOT EXISTS (SELECT 1 FROM object_bindings b WHERE b.object_id = o.id)
          AND NOT EXISTS (
            SELECT 1 FROM upload_sessions s WHERE s.state IN ('open', 'uploading')
              AND s.expires_at > ? AND (s.expected_sha256 IS NULL OR s.expected_sha256 = o.sha256)
          )
          AND NOT EXISTS (SELECT 1 FROM private_download_tokens t WHERE t.object_id = o.id AND t.expires_at > ?)
      `).get(candidate.id, cutoff, now, now) as ObjectRow | undefined;
      if (!current) {
        db.prepare("UPDATE admin_gc_run_items SET outcome = 'skipped' WHERE run_id = ? AND object_id = ?").run(runId, candidate.id);
        return false;
      }
      const filename = resolveStoragePath(config.dataRoot, current.storage_key);
      unlinkSyncSafe(filename);
      db.prepare('DELETE FROM objects WHERE id = ?').run(current.id);
      db.prepare("UPDATE admin_gc_run_items SET outcome = 'deleted' WHERE run_id = ? AND object_id = ?").run(runId, current.id);
      return true;
    });

    for (const candidate of candidates) {
      try {
        if (deleteCandidate.immediate(candidate)) result.deleted += 1;
        else result.skipped += 1;
      } catch (error) {
        if (!isExpectedFilesystemError(error)) throw error;
        db.prepare("UPDATE admin_gc_run_items SET outcome = 'failed' WHERE run_id = ? AND object_id = ?").run(runId, candidate.id);
        result.failed += 1;
      }
    }
    db.prepare(`
      UPDATE admin_gc_runs SET status = 'completed', completed_at = ?, candidates = ?, bytes_reclaimable = ?,
        deleted = ?, skipped = ?, failed = ? WHERE id = ?
    `).run(nowIso(), result.candidates, result.bytes_reclaimable, result.deleted, result.skipped, result.failed, runId);
    return result;
  } catch (error) {
    try {
      db.prepare(`UPDATE admin_gc_runs SET status = 'failed', completed_at = ?, failed = failed + 1 WHERE id = ? AND status = 'running'`)
        .run(nowIso(), runId);
    } catch {
      // Preserve the original maintenance failure; status update failures are visible through the service error.
    }
    throw error;
  }
}

function isExpectedFilesystemError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code !== undefined && ['EACCES', 'EBUSY', 'EIO', 'ENOTDIR', 'EPERM', 'EROFS'].includes(code);
}

export interface AdminObjectInventoryItem {
  public_id: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  original_filename: string;
  state: ObjectRow['state'];
  created_at: string;
  verified_at: string | null;
  binding_count: number;
}

export function listAdminObjectInventory(
  db: SqliteDatabase,
  options: { limit: number; after?: string; state?: ObjectRow['state'] },
): { items: AdminObjectInventoryItem[]; next_cursor: string | null } {
  const rows = db.prepare(`
    SELECT o.public_id, o.sha256, o.size_bytes, o.mime_type, o.original_filename, o.state, o.created_at, o.verified_at,
      (SELECT COUNT(*) FROM object_bindings b WHERE b.object_id = o.id) AS binding_count
    FROM objects o
    WHERE (? IS NULL OR o.public_id > ?)
      AND (? IS NULL OR o.state = ?)
    ORDER BY o.public_id ASC LIMIT ?
  `).all(options.after ?? null, options.after ?? null, options.state ?? null, options.state ?? null, options.limit + 1) as AdminObjectInventoryItem[];
  const hasMore = rows.length > options.limit;
  const items = rows.slice(0, options.limit);
  return { items, next_cursor: hasMore ? items.at(-1)?.public_id ?? null : null };
}

export interface AdminBindingInventoryItem {
  binding_id: string;
  object_public_id: string;
  sha256: string;
  size_bytes: number;
  object_state: ObjectRow['state'];
  namespace: string;
  owner_type: string;
  owner_id: string;
  visibility: 'public' | 'private';
  created_at: string;
}

export function listAdminBindingInventory(
  db: SqliteDatabase,
  options: { namespace: string; ownerType: string; limit: number; after?: string },
): { items: AdminBindingInventoryItem[]; next_cursor: string | null } {
  const rows = db.prepare(`
    SELECT b.id AS binding_id, o.public_id AS object_public_id, o.sha256, o.size_bytes, o.state AS object_state,
      b.namespace, b.owner_type, b.owner_id, b.visibility, b.created_at
    FROM object_bindings b JOIN objects o ON o.id = b.object_id
    WHERE b.namespace = ? AND b.owner_type = ? AND (? IS NULL OR b.id > ?)
    ORDER BY b.id ASC LIMIT ?
  `).all(options.namespace, options.ownerType, options.after ?? null, options.after ?? null, options.limit + 1) as AdminBindingInventoryItem[];
  const hasMore = rows.length > options.limit;
  const items = rows.slice(0, options.limit);
  return { items, next_cursor: hasMore ? items.at(-1)?.binding_id ?? null : null };
}

function unlinkSyncSafe(filename: string): void {
  try {
    unlinkSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export interface IntegrityResult {
  checked: number;
  healthy: number;
  missing: number;
  corrupt: number;
  failed: number;
}

export async function scanIntegrity(db: SqliteDatabase, config: AppConfig): Promise<IntegrityResult> {
  const rows = db.prepare(`
    SELECT id, sha256, size_bytes, storage_key, created_at, state FROM objects
    WHERE state <> 'quarantined' ORDER BY created_at ASC
  `).all() as ObjectRow[];
  const result: IntegrityResult = { checked: rows.length, healthy: 0, missing: 0, corrupt: 0, failed: 0 };
  const updateState = db.prepare("UPDATE objects SET state = ? WHERE id = ? AND state <> 'quarantined'");
  for (const row of rows) {
    let fileStat;
    try {
      fileStat = await stat(resolveStoragePath(config.dataRoot, row.storage_key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        updateState.run('missing', row.id);
        result.missing += 1;
      } else result.failed += 1;
      continue;
    }
    if (!fileStat.isFile() || fileStat.size !== row.size_bytes) {
      updateState.run('corrupt', row.id);
      result.corrupt += 1;
      continue;
    }
    try {
      const actual = await hashFile(resolveStoragePath(config.dataRoot, row.storage_key));
      if (actual.sha256 !== row.sha256 || actual.sizeBytes !== row.size_bytes) {
        updateState.run('corrupt', row.id);
        result.corrupt += 1;
      } else result.healthy += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

export function cleanupExpiredRows(db: SqliteDatabase, config: AppConfig): { accessLogs: number; uploads: number; privateTokens: number } {
  const now = nowIso();
  const logs = db.prepare('DELETE FROM access_logs WHERE created_at < ?').run(dateBeforeDays(config.accessLogRetentionDays));
  const tokens = db.prepare('DELETE FROM private_download_tokens WHERE expires_at <= ?').run(now);
  const uploads = db.prepare(`
    DELETE FROM upload_sessions
    WHERE expires_at < ? AND state IN ('completed', 'failed', 'expired', 'open', 'uploading')
  `).run(dateBeforeDays(30));
  return { accessLogs: logs.changes, uploads: uploads.changes, privateTokens: tokens.changes };
}

export async function cleanupOldTempFiles(db: SqliteDatabase, config: AppConfig): Promise<number> {
  const tempRoot = path.join(config.dataRoot, 'temp');
  let names: string[];
  try {
    names = await readdir(tempRoot);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let removed = 0;
  const active = db.prepare("SELECT 1 FROM upload_sessions WHERE public_id = ? AND state = 'uploading' AND expires_at > ?");
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]{8,80}--[0-9a-f-]{36}\.part$/.test(name)) continue;
    const fullPath = path.join(tempRoot, name);
    const fileSessionId = name.slice(0, name.indexOf('--'));
    if (active.get(fileSessionId, nowIso())) continue;
    try {
      if ((await stat(fullPath)).mtimeMs < cutoff) {
        await unlink(fullPath);
        removed += 1;
      }
    } catch {
      // A concurrently completed upload may already have removed this file.
    }
  }
  return removed;
}

export function startRetentionScheduler(db: SqliteDatabase, config: AppConfig): () => void {
  const run = () => {
    try {
      cleanupExpiredRows(db, config);
      void cleanupOldTempFiles(db, config).catch(() => undefined);
    } catch {
      // Retention work is best effort; the service remains available for the next pass.
    }
  };
  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
