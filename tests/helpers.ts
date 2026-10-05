import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app';
import { loadConfig, type AppConfig } from '../src/config';
import { openDatabase, type SqliteDatabase } from '../src/db';

export const SERVICE_KEY = 's'.repeat(64);

export interface Fixture {
  config: AppConfig;
  db: SqliteDatabase;
  server: Server;
  baseUrl: string;
  close(): Promise<void>;
}

export async function createFixture(options: { trustEdgeOne?: boolean; trustProxyHops?: number } = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resource-storage-test-'));
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    PORT: '5200',
    DATA_ROOT: path.join(root, 'data'),
    DATABASE_PATH: path.join(root, 'resource-storage.sqlite'),
    RES_SERVICE_API_KEY: SERVICE_KEY,
    RES_ADMIN_API_KEY: 'a'.repeat(64),
    PUBLIC_BASE_URL: 'https://res.mdtbbs.cn',
    MAX_OBJECT_SIZE: '1048576',
    UPLOAD_SESSION_TTL_SECONDS: '900',
    PRIVATE_DOWNLOAD_TTL_SECONDS: '300',
    GC_GRACE_DAYS: '7',
    ACCESS_LOG_RETENTION_DAYS: '210',
    CORS_ALLOWED_ORIGINS: 'https://mdtbbs.cn',
    TRUST_EDGEONE: String(options.trustEdgeOne ?? false),
    TRUST_PROXY_HOPS: String(options.trustProxyHops ?? 1),
  });
  const db = openDatabase(config);
  const app = createApp(config, db);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    config,
    db,
    server,
    baseUrl,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function postJson(fixture: Fixture, route: string, body: unknown, apiKey = SERVICE_KEY): Promise<Response> {
  return fetch(`${fixture.baseUrl}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function createUpload(fixture: Fixture, bytes: Buffer, options: { sha256?: string; size?: number; filename?: string } = {}) {
  const response = await postJson(fixture, '/api/v1/uploads', {
    ...(options.sha256 ? { sha256: options.sha256 } : {}),
    size_bytes: options.size ?? bytes.length,
    mime_type: 'application/octet-stream',
    original_filename: options.filename ?? 'fixture.bin',
    purpose: 'resource_version',
  });
  const data = await response.json() as { upload?: { session_id: string; token: string; url: string }; object?: { id: string; public_id: string; sha256: string; size_bytes: number }; deduplicated?: boolean };
  return { response, data };
}

export async function putUpload(fixture: Fixture, sessionId: string, token: string, bytes: Buffer): Promise<Response> {
  return fetch(`${fixture.baseUrl}/upload/${sessionId}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: Uint8Array.from(bytes),
  });
}

export async function uploadObject(fixture: Fixture, bytes: Buffer, filename = 'fixture.bin') {
  const created = await createUpload(fixture, bytes, { filename });
  if (!created.data.upload) throw new Error(`Upload session creation failed: ${JSON.stringify(created.data)}`);
  const uploaded = await putUpload(fixture, created.data.upload.session_id, created.data.upload.token, bytes);
  const data = await uploaded.json() as { object: { id: string; public_id: string; sha256: string; size_bytes: number } };
  if (!uploaded.ok) throw new Error(`Upload failed: ${JSON.stringify(data)}`);
  return data.object;
}

export async function bindObject(fixture: Fixture, objectId: string, visibility: 'public' | 'private' = 'public', ownerId: string = randomUUID()) {
  const response = await postJson(fixture, `/api/v1/objects/${objectId}/bindings`, {
    namespace: 'mindforum', owner_type: 'resource_file', owner_id: ownerId, visibility,
  });
  return { response, data: await response.json() as { binding: { id: string; object_id: string; visibility: string } } };
}
