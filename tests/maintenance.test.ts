import assert from 'node:assert/strict';
import { unlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { hashFile } from '../src/file-store';
import { runGarbageCollection, scanIntegrity } from '../src/maintenance';
import { bindObject, createFixture, postJson, uploadObject } from './helpers';

test('garbage collection preserves bound objects and removes old orphans only', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const retained = await uploadObject(fixture, Buffer.from('still referenced'));
  const orphan = await uploadObject(fixture, Buffer.from('orphan content'));
  const retainedPath = (fixture.db.prepare('SELECT storage_key FROM objects WHERE id = ?').get(retained.id) as { storage_key: string }).storage_key;
  const orphanPath = (fixture.db.prepare('SELECT storage_key FROM objects WHERE id = ?').get(orphan.id) as { storage_key: string }).storage_key;
  await bindObject(fixture, retained.id, 'public', 'retained-resource');
  fixture.db.prepare("UPDATE objects SET created_at = '2000-01-01T00:00:00.000Z' WHERE id IN (?, ?)").run(retained.id, orphan.id);

  const dryRun = await runGarbageCollection(fixture.db, fixture.config, true);
  assert.deepEqual(dryRun, { candidates: 1, bytes_reclaimable: Buffer.byteLength('orphan content'), deleted: 0, failed: 0, dry_run: true });
  const actual = await runGarbageCollection(fixture.db, fixture.config, false);
  assert.equal(actual.deleted, 1);
  assert.equal(actual.failed, 0);
  assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM objects WHERE id = ?').get(retained.id) as { count: number }).count, 1);
  assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM objects WHERE id = ?').get(orphan.id) as { count: number }).count, 0);
  await assert.doesNotReject(import('node:fs/promises').then(({ stat }) => stat(`${fixture.config.dataRoot}/${retainedPath}`)));
  await assert.rejects(import('node:fs/promises').then(({ stat }) => stat(`${fixture.config.dataRoot}/${orphanPath}`)), { code: 'ENOENT' });
});

test('integrity scan marks missing and corrupt files without repairing them', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const missingObject = await uploadObject(fixture, Buffer.from('missing object'));
  const corruptObject = await uploadObject(fixture, Buffer.from('original'));
  const missingKey = (fixture.db.prepare('SELECT storage_key FROM objects WHERE id = ?').get(missingObject.id) as { storage_key: string }).storage_key;
  const corruptKey = (fixture.db.prepare('SELECT storage_key FROM objects WHERE id = ?').get(corruptObject.id) as { storage_key: string }).storage_key;
  await unlink(`${fixture.config.dataRoot}/${missingKey}`);
  await writeFile(`${fixture.config.dataRoot}/${corruptKey}`, Buffer.from('tampered'));
  const result = await scanIntegrity(fixture.db, fixture.config);
  assert.equal(result.checked, 2);
  assert.equal(result.missing, 1);
  assert.equal(result.corrupt, 1);
  assert.equal(result.healthy, 0);
  assert.equal((fixture.db.prepare('SELECT state FROM objects WHERE id = ?').get(missingObject.id) as { state: string }).state, 'missing');
  assert.equal((fixture.db.prepare('SELECT state FROM objects WHERE id = ?').get(corruptObject.id) as { state: string }).state, 'corrupt');
  const after = await hashFile(`${fixture.config.dataRoot}/${corruptKey}`);
  assert.equal(after.sha256, await import('node:crypto').then(({ createHash }) => createHash('sha256').update('tampered').digest('hex')));
});

test('admin endpoints accept the configured admin key and report dry-run integrity and GC', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const object = await uploadObject(fixture, Buffer.from('admin scan'));
  fixture.db.prepare("UPDATE objects SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(object.id);
  const gc = await postJson(fixture, '/api/admin/gc', { dry_run: true }, 'a'.repeat(64));
  assert.equal(gc.status, 200);
  assert.equal((await gc.json() as { candidates: number; deleted: number }).candidates, 1);
  const denied = await postJson(fixture, '/api/admin/gc', { dry_run: true }, 'x'.repeat(64));
  assert.equal(denied.status, 401);
  const integrity = await postJson(fixture, '/api/admin/integrity/scan', {}, 'a'.repeat(64));
  assert.equal(integrity.status, 200);
  assert.equal((await integrity.json() as { healthy: number }).healthy, 1);
});
