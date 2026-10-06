import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config';

export type SqliteDatabase = Database.Database;

function findMigrationsDirectory(): string {
  const candidates = [path.resolve(__dirname, '../migrations'), path.resolve(__dirname, '../../migrations')];
  const found = candidates.find((candidate) => {
    try {
      return readdirSync(candidate).some((name) => /^\d+_.+\.sql$/.test(name));
    } catch {
      return false;
    }
  });
  if (!found) throw new Error('SQLite migration directory was not found');
  return found;
}

export function ensureWritableDirectories(config: AppConfig): void {
  mkdirSync(config.dataRoot, { recursive: true, mode: 0o750 });
  mkdirSync(path.join(config.dataRoot, 'objects', 'sha256'), { recursive: true, mode: 0o750 });
  mkdirSync(path.join(config.dataRoot, 'temp'), { recursive: true, mode: 0o750 });
  mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o750 });
  accessSync(config.dataRoot, constants.W_OK);
  const probe = path.join(config.dataRoot, `.write-probe-${randomUUID()}`);
  writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
  unlinkSync(probe);
}

export function runMigrations(db: SqliteDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: string }>).map((row) => row.version));
  const directory = findMigrationsDirectory();
  const migrationFiles = readdirSync(directory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  for (const filename of migrationFiles) {
    const version = filename.slice(0, filename.length - '.sql'.length);
    if (applied.has(version)) continue;
    const sql = readFileSync(path.join(directory, filename), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    })();
  }
}

export function openDatabase(config: AppConfig): SqliteDatabase {
  ensureWritableDirectories(config);
  const oldUmask = process.umask(0o077);
  let db: SqliteDatabase | undefined;
  try {
    db = new Database(config.databasePath);
    chmodSync(config.databasePath, 0o600);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = NORMAL');
    runMigrations(db);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${config.databasePath}${suffix}`;
      if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
    }
    return db;
  } catch (error) {
    db?.close();
    throw error;
  } finally {
    process.umask(oldUmask);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function dateAfterSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function dateBeforeDays(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
