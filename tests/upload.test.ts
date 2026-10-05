import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { completeUpload } from '../src/app';
import { installContentAddressedFile, resolveStoragePath, tempPath } from '../src/file-store';
import { createFixture, createUpload, putUpload, SERVICE_KEY, uploadObject } from './helpers';

test('streams a regular upload, records SHA-256, and rejects replay', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const bytes = Buffer.from('streamed resource bytes');
  const { data } = await createUpload(fixture, bytes, { sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.ok(data.upload);
  const uploaded = await putUpload(fixture, data.upload.session_id, data.upload.token, bytes);
  assert.equal(uploaded.status, 201);
  const result = await uploaded.json() as { object: { sha256: string; size_bytes: number } };
  assert.equal(result.object.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.object.size_bytes, bytes.length);
  const replay = await putUpload(fixture, data.upload.session_id, data.upload.token, bytes);
  assert.equal(replay.status, 409);
});

test('rejects a bad token without consuming the session and then rejects an expired session', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const bytes = Buffer.from('auth boundaries');
  const created = await createUpload(fixture, bytes);
  assert.ok(created.data.upload);
  const wrong = await putUpload(fixture, created.data.upload.session_id, 'wrong-token', bytes);
  assert.equal(wrong.status, 401);
  const good = await putUpload(fixture, created.data.upload.session_id, created.data.upload.token, bytes);
  assert.equal(good.status, 201);

  const expired = await createUpload(fixture, bytes);
  assert.ok(expired.data.upload);
  fixture.db.prepare("UPDATE upload_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE public_id = ?")
    .run(expired.data.upload.session_id);
  const result = await putUpload(fixture, expired.data.upload.session_id, expired.data.upload.token, bytes);
  assert.equal(result.status, 410);
  assert.equal((fixture.db.prepare('SELECT state FROM upload_sessions WHERE public_id = ?').get(expired.data.upload.session_id) as { state: string }).state, 'expired');
});

test('marks size and digest mismatches failed and removes temporary files', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const bytes = Buffer.from('mismatch');
  const wrongSize = await createUpload(fixture, bytes, { size: bytes.length + 1 });
  assert.ok(wrongSize.data.upload);
  const sizeResponse = await putUpload(fixture, wrongSize.data.upload.session_id, wrongSize.data.upload.token, bytes);
  assert.equal(sizeResponse.status, 422);
  assert.equal((fixture.db.prepare('SELECT state FROM upload_sessions WHERE public_id = ?').get(wrongSize.data.upload.session_id) as { state: string }).state, 'failed');

  const wrongHash = await createUpload(fixture, bytes, { sha256: '0'.repeat(64) });
  assert.ok(wrongHash.data.upload);
  const hashResponse = await putUpload(fixture, wrongHash.data.upload.session_id, wrongHash.data.upload.token, bytes);
  assert.equal(hashResponse.status, 422);
  assert.equal((fixture.db.prepare('SELECT state FROM upload_sessions WHERE public_id = ?').get(wrongHash.data.upload.session_id) as { state: string }).state, 'failed');
  assert.deepEqual(await readdir(`${fixture.config.dataRoot}/temp`), []);
});

test('deduplicates known hashes and concurrent CAS uploads', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const bytes = Buffer.from('one physical object');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const first = await uploadObject(fixture, bytes);
  const duplicate = await createUpload(fixture, bytes, { sha256: hash });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.data.deduplicated, true);
  assert.equal(duplicate.data.object?.id, first.id);

  const twoA = await createUpload(fixture, bytes);
  const twoB = await createUpload(fixture, bytes);
  assert.ok(twoA.data.upload && twoB.data.upload);
  const [a, b] = await Promise.all([
    putUpload(fixture, twoA.data.upload.session_id, twoA.data.upload.token, bytes),
    putUpload(fixture, twoB.data.upload.session_id, twoB.data.upload.token, bytes),
  ]);
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const dataA = await a.json() as { object: { id: string } };
  const dataB = await b.json() as { object: { id: string } };
  assert.equal(dataA.object.id, dataB.object.id);
  assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM objects').get() as { count: number }).count, 1);
});

test('transaction failure preserves a CAS file another concurrent upload bound', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const bytes = Buffer.from('shared CAS survives one transaction failure');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const first = await createUpload(fixture, bytes);
  const second = await createUpload(fixture, bytes);
  assert.ok(first.data.upload && second.data.upload);

  const firstSession = fixture.db.prepare('SELECT * FROM upload_sessions WHERE public_id = ?').get(first.data.upload.session_id) as Parameters<typeof completeUpload>[2];
  const secondSession = fixture.db.prepare('SELECT * FROM upload_sessions WHERE public_id = ?').get(second.data.upload.session_id) as Parameters<typeof completeUpload>[2];
  fixture.db.prepare("UPDATE upload_sessions SET state = 'uploading' WHERE id IN (?, ?)").run(firstSession.id, secondSession.id);
  fixture.db.exec(`
    CREATE TRIGGER fail_first_upload_completion
    BEFORE UPDATE OF state ON upload_sessions
    WHEN OLD.id = '${firstSession.id}' AND NEW.state = 'completed'
    BEGIN
      SELECT RAISE(ABORT, 'simulated transaction failure');
    END
  `);

  const firstTemp = tempPath(fixture.config, firstSession.public_id);
  const secondTemp = tempPath(fixture.config, secondSession.public_id);
  await Promise.all([writeFile(firstTemp, bytes, { flag: 'wx', mode: 0o600 }), writeFile(secondTemp, bytes, { flag: 'wx', mode: 0o600 })]);
  let notifyInstalled!: () => void;
  let continueFirst!: () => void;
  const installed = new Promise<void>((resolve) => { notifyInstalled = resolve; });
  const firstGate = new Promise<void>((resolve) => { continueFirst = resolve; });
  const gatedInstaller: typeof installContentAddressedFile = async (config, filename, digest) => {
    const result = await installContentAddressedFile(config, filename, digest);
    notifyInstalled();
    await firstGate;
    return result;
  };

  const failedCompletion = completeUpload(fixture.db, fixture.config, firstSession, firstTemp, { sizeBytes: bytes.length, sha256 }, gatedInstaller);
  await installed;
  let successfulObject: Awaited<ReturnType<typeof completeUpload>>;
  try {
    successfulObject = await completeUpload(fixture.db, fixture.config, secondSession, secondTemp, { sizeBytes: bytes.length, sha256 });
  } finally {
    continueFirst();
  }
  await assert.rejects(failedCompletion, /simulated transaction failure/);

  assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM objects WHERE sha256 = ?').get(sha256) as { count: number }).count, 1);
  assert.equal((fixture.db.prepare('SELECT state FROM upload_sessions WHERE id = ?').get(firstSession.id) as { state: string }).state, 'failed');
  assert.ok(successfulObject);
  assert.equal((await stat(resolveStoragePath(fixture.config.dataRoot, successfulObject.storage_key))).size, bytes.length);
  assert.deepEqual(await readdir(path.join(fixture.config.dataRoot, 'temp')), []);
});

test('requires API credentials for upload session creation', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const denied = await fetch(`${fixture.baseUrl}/api/v1/uploads`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size_bytes: 0, mime_type: 'application/octet-stream', original_filename: 'empty.bin', purpose: 'resource_version' }),
  });
  assert.equal(denied.status, 401);
  const wrong = await createUpload(fixture, Buffer.alloc(0), { filename: 'empty.bin' });
  assert.equal(wrong.response.status, 201);
  assert.equal(SERVICE_KEY.length, 64);
});
