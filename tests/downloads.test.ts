import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { bindObject, createFixture, postJson, uploadObject } from './helpers';

test('serves public objects only after public binding, with ETag, Range, HEAD, and UTF-8 filename', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const bytes = Buffer.from('abcdefghij');
  const object = await uploadObject(fixture, bytes, '原始资源.msch');
  const url = `${fixture.baseUrl}/o/${object.public_id}/${encodeURIComponent('建筑图纸.msch')}`;
  assert.equal((await fetch(url)).status, 404);

  const privateBinding = await bindObject(fixture, object.id, 'private', 'file-1');
  assert.equal(privateBinding.response.status, 200);
  assert.equal((await fetch(url)).status, 404);

  const privateGrant = await postJson(fixture, `/api/v1/objects/${object.id}/signed-url`, { expires_in: 300, filename: '举报附件.msch' });
  const privateData = await privateGrant.json() as { url: string };
  const privateResponse = await fetch(privateData.url.replace('https://res.mdtbbs.cn', fixture.baseUrl), { headers: { range: 'bytes=2-4' } });
  assert.equal(privateResponse.status, 206);
  assert.equal(await privateResponse.text(), 'cde');
  assert.match(privateResponse.headers.get('cache-control') ?? '', /private, no-store/);

  const sameBinding = await bindObject(fixture, object.id, 'public', 'file-1');
  assert.equal(sameBinding.data.binding.id, privateBinding.data.binding.id);
  assert.equal(sameBinding.data.binding.visibility, 'public');

  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'abcdefghij');
  const etag = response.headers.get('etag');
  assert.equal(etag, `"${object.sha256}"`);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(response.headers.get('cache-control')?.includes('immutable'), false);
  assert.match(response.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
  assert.match(decodeURIComponent(response.headers.get('content-disposition') ?? ''), /建筑图纸\.msch/);

  const partial = await fetch(url, { headers: { range: 'bytes=1-3' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 1-3/10');
  assert.equal(partial.headers.get('content-length'), '3');
  assert.equal(await partial.text(), 'bcd');

  const notModified = await fetch(url, { headers: { 'if-none-match': etag! } });
  assert.equal(notModified.status, 304);
  assert.equal((await notModified.text()), '');
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');

  await fetch(`${fixture.baseUrl}/api/v1/objects/${object.id}/bindings/${sameBinding.data.binding.id}`, {
    method: 'DELETE', headers: { authorization: 'Bearer ' + 's'.repeat(64) },
  });
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await readFile(`${fixture.config.dataRoot}/${(fixture.db.prepare('SELECT storage_key FROM objects WHERE id = ?').get(object.id) as { storage_key: string }).storage_key}`)).toString(), bytes.toString());
});

test('service metadata and content endpoints require the service API key and stream ranges', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const object = await uploadObject(fixture, Buffer.from('0123456789'));
  const denied = await fetch(`${fixture.baseUrl}/api/v1/objects/${object.id}`);
  assert.equal(denied.status, 401);
  const metadata = await fetch(`${fixture.baseUrl}/api/v1/objects/${object.id}`, { headers: { authorization: 'Bearer ' + 's'.repeat(64) } });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get('cache-control'), 'private, no-store');
  const content = await fetch(`${fixture.baseUrl}/api/v1/objects/${object.id}/content`, {
    headers: { authorization: 'Bearer ' + 's'.repeat(64), range: 'bytes=-4' },
  });
  assert.equal(content.status, 206);
  assert.equal(await content.text(), '6789');
  assert.match(content.headers.get('cache-control') ?? '', /no-store/);
});

test('binding creation is idempotent and deletion leaves the object in place', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const object = await uploadObject(fixture, Buffer.from('bound object'));
  const first = await bindObject(fixture, object.id, 'public', 'resource-file-17');
  const second = await bindObject(fixture, object.id, 'public', 'resource-file-17');
  assert.equal(first.data.binding.id, second.data.binding.id);
  assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM object_bindings WHERE object_id = ?').get(object.id) as { count: number }).count, 1);
  await fetch(`${fixture.baseUrl}/api/v1/objects/${object.id}/bindings/${first.data.binding.id}`, {
    method: 'DELETE', headers: { authorization: 'Bearer ' + 's'.repeat(64) },
  });
  assert.equal((fixture.db.prepare('SELECT COUNT(*) AS count FROM objects WHERE id = ?').get(object.id) as { count: number }).count, 1);
  await stat(`${fixture.config.dataRoot}/${(fixture.db.prepare('SELECT storage_key FROM objects WHERE id = ?').get(object.id) as { storage_key: string }).storage_key}`);
});

test('private signed URL supports Range and expired tokens are rejected without caching', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const object = await uploadObject(fixture, Buffer.from('private body'));
  const response = await postJson(fixture, `/api/v1/objects/${object.id}/signed-url`, { filename: '审查附件.txt', expires_in: 30 });
  const signed = await response.json() as { url: string };
  const url = signed.url.replace('https://res.mdtbbs.cn', fixture.baseUrl);
  const range = await fetch(url, { headers: { range: 'bytes=0-6' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'private');
  const token = new URL(url).pathname.split('/').pop()!;
  fixture.db.prepare("UPDATE private_download_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?")
    .run(createHash('sha256').update(token).digest('hex'));
  const expired = await fetch(url);
  assert.equal(expired.status, 404);
});

test('health response is minimal and access logs redact bearer and private path tokens', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const health = await fetch(`${fixture.baseUrl}/health`);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const object = await uploadObject(fixture, Buffer.from('redacted'));
  const grantResponse = await postJson(fixture, `/api/v1/objects/${object.id}/signed-url`, {});
  const grant = await grantResponse.json() as { url: string };
  const token = new URL(grant.url).pathname.split('/').pop()!;
  await fetch(grant.url.replace('https://res.mdtbbs.cn', fixture.baseUrl));
  const rows = fixture.db.prepare('SELECT * FROM access_logs').all();
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes('s'.repeat(64)), false);
  assert.equal(serialized.includes('/private/:token'), true);
  const columns = fixture.db.prepare('PRAGMA table_info(access_logs)').all() as Array<{ name: string }>;
  assert.equal(columns.some((column) => /authorization|cookie|token|body/i.test(column.name)), false);
});
