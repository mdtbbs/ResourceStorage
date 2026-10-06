import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture } from './helpers';

test('EdgeOne client IP headers are ignored unless trusted proxy mode is enabled', async (t) => {
  const untrusted = await createFixture({ trustEdgeOne: false });
  t.after(() => untrusted.close());
  const ignored = await fetch(`${untrusted.baseUrl}/health`, {
    headers: { 'eo-connecting-ip': '203.0.113.10', 'x-forwarded-for': '198.51.100.20' },
  });
  assert.equal(ignored.status, 200);
  const untrustedIp = (untrusted.db.prepare("SELECT ip FROM access_logs WHERE path = '/health' ORDER BY id DESC LIMIT 1").get() as { ip: string }).ip;
  assert.equal(untrustedIp, '127.0.0.1');

  const trusted = await createFixture({ trustEdgeOne: true, trustProxyHops: 1 });
  t.after(() => trusted.close());
  await fetch(`${trusted.baseUrl}/health`, {
    headers: { 'eo-connecting-ip': '203.0.113.11', 'x-forwarded-for': '198.51.100.21' },
  });
  const edgeIp = (trusted.db.prepare("SELECT ip FROM access_logs WHERE path = '/health' ORDER BY id DESC LIMIT 1").get() as { ip: string }).ip;
  assert.equal(edgeIp, '203.0.113.11');

  await fetch(`${trusted.baseUrl}/health`, { headers: { 'x-forwarded-for': '198.51.100.22, 198.51.100.23' } });
  const forwardedIp = (trusted.db.prepare("SELECT ip FROM access_logs WHERE path = '/health' ORDER BY id DESC LIMIT 1").get() as { ip: string }).ip;
  assert.equal(forwardedIp, '198.51.100.23');
});

test('CORS only reflects an explicitly allowed origin', async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.close());
  const allowed = await fetch(`${fixture.baseUrl}/health`, { headers: { origin: 'https://mdtbbs.cn' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://mdtbbs.cn');
  const disallowed = await fetch(`${fixture.baseUrl}/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(disallowed.headers.get('access-control-allow-origin'), null);
  const preflight = await fetch(`${fixture.baseUrl}/upload/test`, {
    method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
  });
  assert.equal(preflight.status, 403);
});
