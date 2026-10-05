import { readdir, stat, unlink } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config';
import { dateBeforeDays, nowIso, type SqliteDatabase } from './db';
import { hashFile, resolveStoragePath } from './file-store';

interface ObjectRow {
  id: string;
  sha256: string;
  size_bytes: number;
  storage_key: string;
  created_at: string;
  state: 'verified' | 'missing' | 'corrupt' | 'quarantined';
}

function gcCandidates(db: SqliteDatabase, cutoff: string, now: string): ObjectRow[] {
  return db.prepare(`
    SELECT o.id, o.sha256, o.size_bytes, o.storage_key, o.created_at, o.state
    FROM objects o
    WHERE o.created_at <= ?
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
    ORDER BY o.created_at ASC
  `).all(cutoff, now, now) as ObjectRow[];
}

export interface GcResult {
  candidates: number;
  bytes_reclaimable: number;
  deleted: number;
  failed: number;
  dry_run: boolean;
}

export async function runGarbageCollection(db: SqliteDatabase, config: AppConfig, dryRun: boolean): Promise<GcResult> {
  const cutoff = dateBeforeDays(config.gcGraceDays);
  const now = nowIso();
  const candidates = gcCandidates(db, cutoff, now);
  let bytesReclaimable = 0;
  for (const candidate of candidates) {
    try {
      const fileStat = await stat(resolveStoragePath(config.dataRoot, candidate.storage_key));
      if (fileStat.isFile()) bytesReclaimable += fileStat.size;
    } catch {
      // A missing file has no physical bytes to reclaim; the stale row is still collectible.
    }
  }
  const result: GcResult = {
    candidates: candidates.length,
    bytes_reclaimable: bytesReclaimable,
    deleted: 0,
    failed: 0,
    dry_run: dryRun,
  };
  if (dryRun) return result;

  const deleteCandidate = db.transaction((candidate: ObjectRow) => {
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
    if (!current) return false;
    const filename = resolveStoragePath(config.dataRoot, current.storage_key);
    try {
      unlinkSyncSafe(filename);
    } catch (error) {
      throw error;
    }
    db.prepare('DELETE FROM objects WHERE id = ?').run(current.id);
    return true;
  });

  for (const candidate of candidates) {
    try {
      if (deleteCandidate(candidate)) result.deleted += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
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
