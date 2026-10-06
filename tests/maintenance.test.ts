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

  const ids = [retained.public_id, orphan.public_id];
  const dryRun = await runGarbageCollection(fixture.db, fixture.config, { dryRun: true, limit: 50, objectIds: ids, confirm: false });
  assert.equal(dryRun.candidates, 1);
  assert.equal(dryRun.bytes_reclaimable, Buffer.byteLength('orphan content'));
  assert.equal(dryRun.deleted, 0);
  assert.equal(dryRun.failed, 0);
  assert.equal(dryRun.skipped, 0);
  const actual = await runGarbageCollection(fixture.db, fixture.config, { dryRun: false, limit: 50, objectIds: ids, confirm: true });
  assert.equal(actual.deleted, 1);
  assert.equal(actual.failed, 0);
  assert.equal(actual.skipped, 0);
  assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM objects WHERE id = ?').get(retained.id) as { count: number }).count, 1);
  assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM objects WHERE id = ?').get(orphan.id) as { count: number }).count, 0);
  await assert.doesNotReject(import('node:fs/promises').then(({ stat }) => stat(`${fixture.config.dataRoot}/${retainedPath}`)));
  await assert.rejects(import('node:fs/promises').then(({ stat }) => stat(`${fixture.config.dataRoot}/${orphanPath}`)), { code: 'ENOENT' });
});

test('unexpected GC preparation errors mark the audit run failed', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const object = await uploadObject(fixture, Buffer.from('bad storage key'));
  fixture.db.prepare("UPDATE objects SET created_at = '2000-01-01T00:00:00.000Z', storage_key = '../outside' WHERE id = ?").run(object.id);

  await assert.rejects(runGarbageCollection(fixture.db, fixture.config, {
    dryRun: true,
    limit: 10,
    objectIds: [object.public_id],
    confirm: false,
  }), /Invalid object storage key/);
  const run = fixture.db.prepare('SELECT status, completed_at, failed FROM admin_gc_runs ORDER BY created_at DESC, id DESC LIMIT 1').get() as {
    status: string;
    completed_at: string | null;
    failed: number;
  };
  assert.equal(run.status, 'failed');
  assert.ok(run.completed_at);
  assert.equal(run.failed, 1);
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
  const gc = await postJson(fixture, '/api/admin/gc', { object_ids: [object.public_id], limit: 1 }, 'a'.repeat(64));
  assert.equal(gc.status, 200);
  const gcResult = await gc.json() as { run_id: string; candidates: number; deleted: number; dry_run: boolean };
  assert.equal(gcResult.candidates, 1);
  assert.equal(gcResult.dry_run, true);
  assert.equal(gcResult.deleted, 0);
  const denied = await postJson(fixture, '/api/admin/gc', { object_ids: [object.public_id] }, 'x'.repeat(64));
  assert.equal(denied.status, 401);
  const unconfirmed = await postJson(fixture, '/api/admin/gc', { dry_run: false, object_ids: [object.public_id] }, 'a'.repeat(64));
  assert.equal(unconfirmed.status, 400);
  const runAudit = await fetch(`${fixture.baseUrl}/api/admin/gc/runs/${gcResult.run_id}`, { headers: { authorization: `Bearer ${'a'.repeat(64)}` } });
  assert.equal(runAudit.status, 200);
  const audit = await runAudit.json() as { run: { status: string; requested_object_ids: string[] }; items: Array<{ outcome: string; object_public_id: string }> };
  assert.equal(audit.run.status, 'completed');
  assert.deepEqual(audit.run.requested_object_ids, [object.public_id]);
  assert.deepEqual(audit.items.map((item) => [item.object_public_id, item.outcome]), [[object.public_id, 'eligible']]);
  const bindings = await fetch(`${fixture.baseUrl}/api/admin/inventory/bindings?namespace=mindforum&owner_type=resource_file`, { headers: { authorization: `Bearer ${'a'.repeat(64)}` } });
  assert.equal(bindings.status, 200);
  const bindingInventory = await bindings.json() as { items: unknown[]; next_cursor: string | null };
  assert.deepEqual(bindingInventory, { items: [], next_cursor: null });
  const objectInventory = await fetch(`${fixture.baseUrl}/api/admin/inventory/objects?limit=1`, { headers: { authorization: `Bearer ${'a'.repeat(64)}` } });
  assert.equal(objectInventory.status, 200);
  const inventory = await objectInventory.json() as { items: Array<Record<string, unknown>>; next_cursor: string | null };
  assert.equal(inventory.items.length, 1);
  assert.equal(inventory.items[0]?.public_id, object.public_id);
  assert.equal('storage_key' in (inventory.items[0] ?? {}), false);
  const requiredBindingFilter = await fetch(`${fixture.baseUrl}/api/admin/inventory/bindings`, { headers: { authorization: `Bearer ${'a'.repeat(64)}` } });
  assert.equal(requiredBindingFilter.status, 400);
  const integrity = await postJson(fixture, '/api/admin/integrity/scan', {}, 'a'.repeat(64));
  assert.equal(integrity.status, 200);
  assert.equal((await integrity.json() as { healthy: number }).healthy, 1);
});

test('GC run list sorts newest first and paginates by creation time with an ID tie-breaker', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const insertRun = fixture.db.prepare(`
    INSERT INTO admin_gc_runs (id, created_at, completed_at, status, dry_run, requested_limit, requested_object_ids)
    VALUES (?, ?, ?, 'completed', 1, 10, '[]')
  `);
  insertRun.run('ffffffff-ffff-4fff-8fff-ffffffffffff', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');
  insertRun.run('00000000-0000-4000-8000-000000000001', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:01.000Z');
  insertRun.run('00000000-0000-4000-8000-000000000002', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:01.000Z');

  const headers = { authorization: `Bearer ${'a'.repeat(64)}` };
  const firstResponse = await fetch(`${fixture.baseUrl}/api/admin/gc/runs?limit=2`, { headers });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json() as { items: Array<{ id: string }>; next_cursor: string | null };
  assert.deepEqual(first.items.map((run) => run.id), [
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
  ]);
  assert.ok(first.next_cursor);

  const secondResponse = await fetch(`${fixture.baseUrl}/api/admin/gc/runs?limit=2&after=${encodeURIComponent(first.next_cursor)}`, { headers });
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json() as { items: Array<{ id: string }>; next_cursor: string | null };
  assert.deepEqual(second.items.map((run) => run.id), ['ffffffff-ffff-4fff-8fff-ffffffffffff']);
  assert.equal(second.next_cursor, null);

  const invalid = await fetch(`${fixture.baseUrl}/api/admin/gc/runs?after=not-a-cursor`, { headers });
  assert.equal(invalid.status, 400);
});
