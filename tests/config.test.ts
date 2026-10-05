import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';

const base = {
  NODE_ENV: 'production',
  RES_SERVICE_API_KEY: 's'.repeat(64),
  PUBLIC_BASE_URL: 'https://res.mdtbbs.cn',
  CORS_ALLOWED_ORIGINS: 'https://mdtbbs.cn',
  DATA_ROOT: '/tmp/resource-storage-config-test',
};

test('production config requires a strong service key, HTTPS public origin, and exact HTTPS CORS origins', () => {
  assert.throws(() => loadConfig({ ...base, RES_SERVICE_API_KEY: 'too-short' }), /RES_SERVICE_API_KEY/);
  assert.throws(() => loadConfig({ ...base, PUBLIC_BASE_URL: 'http://res.mdtbbs.cn' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: '*' }), /cannot contain \*/);
  assert.throws(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: 'http://mdtbbs.cn' }), /using HTTPS/);
  assert.throws(() => loadConfig({ ...base, PUBLIC_BASE_URL: 'https://res.mdtbbs.cn/path' }), /service origin/);
  assert.equal(loadConfig(base).publicBaseUrl, 'https://res.mdtbbs.cn');
});

test('production config rejects absent service keys and invalid numeric limits', () => {
  const noKey = { ...base } as Record<string, string | undefined>;
  delete noKey.RES_SERVICE_API_KEY;
  assert.throws(() => loadConfig(noKey), /RES_SERVICE_API_KEY/);
  assert.throws(() => loadConfig({ ...base, UPLOAD_SESSION_TTL_SECONDS: '15' }), /UPLOAD_SESSION_TTL_SECONDS/);
  assert.throws(() => loadConfig({ ...base, TRUST_EDGEONE: 'sometimes' }), /TRUST_EDGEONE/);
});

test('SQLite database files are created with owner-only permissions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resource-storage-db-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test',
    RES_SERVICE_API_KEY: 's'.repeat(64),
    DATA_ROOT: path.join(root, 'data'),
    DATABASE_PATH: path.join(root, 'resource-storage.sqlite'),
    CORS_ALLOWED_ORIGINS: 'https://mdtbbs.cn',
  });
  const db = openDatabase(config);
  try {
    assert.equal((await stat(config.databasePath)).mode & 0o777, 0o600);
  } finally {
    db.close();
  }
});
