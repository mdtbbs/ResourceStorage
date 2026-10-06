import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';
import { completeUpload } from '../src/app';
import { installContentAddressedFile, tempPath } from '../src/file-store';
import { runGarbageCollection } from '../src/maintenance';
import { bindObject, createFixture, createUpload, uploadObject } from './helpers';

test('GC grace starts when the final binding is removed', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());

  const object = await uploadObject(fixture, Buffer.from('old but newly unbound'));
  fixture.db.prepare("UPDATE objects SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(object.id);
  await bindObject(fixture, object.id, 'private', 'gc-grace-regression');

  const bound = fixture.db.prepare('SELECT unbound_at FROM objects WHERE id = ?').get(object.id) as { unbound_at: string | null };
  assert.equal(bound.unbound_at, null);

  const binding = fixture.db.prepare("SELECT id FROM object_bindings WHERE object_id = ? AND owner_id = 'gc-grace-regression'").get(object.id) as { id: string };
  fixture.db.prepare('DELETE FROM object_bindings WHERE id = ?').run(binding.id);

  const unbound = fixture.db.prepare('SELECT unbound_at FROM objects WHERE id = ?').get(object.id) as { unbound_at: string | null };
  assert.ok(unbound.unbound_at);
  assert.ok(Date.parse(unbound.unbound_at) > Date.parse('2020-01-01T00:00:00.000Z'));

  const gc = await runGarbageCollection(fixture.db, fixture.config, {
    dryRun: true,
    limit: 10,
    objectIds: [object.public_id],
    confirm: false,
  });
  assert.equal(gc.candidates, 0);
});

test('hashless upload pins its computed digest before CAS installation', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());

  const bytes = Buffer.from('hashless upload digest pin');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const created = await createUpload(fixture, bytes);
  assert.ok(created.data.upload);
  const session = fixture.db.prepare('SELECT * FROM upload_sessions WHERE public_id = ?').get(created.data.upload.session_id) as Parameters<typeof completeUpload>[2];
  fixture.db.prepare("UPDATE upload_sessions SET state = 'uploading' WHERE id = ?").run(session.id);
  const tempFilename = tempPath(fixture.config, session.public_id);
  await writeFile(tempFilename, bytes, { flag: 'wx', mode: 0o600 });

  const checkingInstaller: typeof installContentAddressedFile = async (config, filename, digest) => {
    const row = fixture.db.prepare('SELECT expected_sha256, state FROM upload_sessions WHERE id = ?').get(session.id) as {
      expected_sha256: string | null;
      state: string;
    };
    assert.equal(row.state, 'uploading');
    assert.equal(row.expected_sha256, sha256);
    return installContentAddressedFile(config, filename, digest);
  };

  const object = await completeUpload(
    fixture.db,
    fixture.config,
    session,
    tempFilename,
    { sizeBytes: bytes.length, sha256 },
    checkingInstaller,
  );
  assert.equal(object.sha256, sha256);
});

test('authentication failures include the request id used for correlation', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());

  const response = await fetch(`${fixture.baseUrl}/api/v1/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      size_bytes: 0,
      mime_type: 'application/octet-stream',
      original_filename: 'empty.bin',
      purpose: 'resource_version',
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json() as { request_id?: string };
  assert.ok(body.request_id);
  assert.equal(body.request_id, response.headers.get('x-request-id'));
});
