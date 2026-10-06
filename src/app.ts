import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express, type Request, type Response } from 'express';
import helmet from 'helmet';
import rangeParser from 'range-parser';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from './config';
import { contentDisposition, safeDisplayFilename } from './content-disposition';
import { dateAfterSeconds, nowIso, type SqliteDatabase } from './db';
import { HttpError, UploadValidationError } from './errors';
import { installContentAddressedFile, objectFileStat, receiveUpload, removeTempFile, resolveStoragePath, tempPath } from './file-store';
import {
  listAdminBindingInventory,
  listAdminObjectInventory,
  runGarbageCollection,
  scanIntegrity,
  type GcOptions,
} from './maintenance';
import { requestId, requestIp } from './request-identity';
import { adminAuth, safeEqualHash, serviceAuth, tokenHash, asyncRoute, bearerToken } from './security';

interface ObjectRow {
  id: string;
  public_id: string;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  original_filename: string;
  storage_key: string;
  state: 'verified' | 'missing' | 'corrupt' | 'quarantined';
  created_at: string;
  verified_at: string | null;
}

interface UploadSessionRow {
  id: string;
  public_id: string;
  expected_sha256: string | null;
  expected_size: number;
  mime_type: string;
  original_filename: string;
  purpose: string;
  token_hash: string;
  state: string;
  expires_at: string;
}

function randomPublicId(bytes = 18): string {
  return randomBytes(bytes).toString('base64url');
}

function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function objectById(db: SqliteDatabase, id: string): ObjectRow | undefined {
  return db.prepare('SELECT * FROM objects WHERE id = ? OR public_id = ?').get(id, id) as ObjectRow | undefined;
}

function validateIdentifier(value: unknown, name: string, maxLength: number, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || !pattern.test(value)) {
    fail(400, 'invalid_request', `${name} is invalid`);
  }
  return value;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') fail(400, 'invalid_path', `${name} is invalid`);
  return value;
}

function boundedQueryLimit(req: Request, fallback = 50): number {
  const raw = req.query.limit;
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,2}$/.test(raw)) fail(400, 'invalid_limit', 'limit must be an integer between 1 and 100');
  const value = Number(raw);
  if (value > 100) fail(400, 'invalid_limit', 'limit must be an integer between 1 and 100');
  return value;
}

function optionalCursor(req: Request, field = 'after'): string | undefined {
  const raw = req.query[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 128 || /[\u0000-\u001f\u007f]/.test(raw)) {
    fail(400, 'invalid_cursor', `${field} cursor is invalid`);
  }
  return raw;
}

interface GcRunCursor {
  created_at: string;
  id: string;
}

function decodeGcRunCursor(raw: string | undefined): GcRunCursor | undefined {
  if (raw === undefined) return undefined;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const cursor = JSON.parse(decoded) as Partial<GcRunCursor>;
    if (
      typeof cursor.created_at !== 'string' || Number.isNaN(Date.parse(cursor.created_at)) ||
      typeof cursor.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor.id) ||
      Buffer.from(decoded).toString('base64url') !== raw
    ) {
      fail(400, 'invalid_cursor', 'after cursor is invalid');
    }
    return { created_at: cursor.created_at, id: cursor.id };
  } catch {
    fail(400, 'invalid_cursor', 'after cursor is invalid');
  }
}

function encodeGcRunCursor(cursor: GcRunCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function requestBody(req: Request): Record<string, unknown> {
  const value = req.body as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request', 'Request body must be a JSON object');
  return value as Record<string, unknown>;
}

function setContext(req: Request, action: string, objectId: string | null = null): void {
  req.logContext = { action, objectId };
}

function safePathForLog(pathname: string): string {
  if (pathname.startsWith('/private/')) return '/private/:token';
  if (pathname.startsWith('/upload/')) return '/upload/:sessionId';
  return pathname.slice(0, 1024);
}

function isEtagMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(',').map((value) => value.trim()).some((candidate) => {
    if (candidate === '*') return true;
    return candidate.replace(/^W\//, '') === etag;
  });
}

function mediaType(value: string): string {
  const candidate = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(candidate) ? candidate : 'application/octet-stream';
}

function sendError(res: Response, status: number, code: string, message: string, requestIdValue: string): void {
  res.status(status).json({ error: { code, message }, request_id: requestIdValue });
}

async function streamObject(
  req: Request,
  res: Response,
  db: SqliteDatabase,
  config: AppConfig,
  object: ObjectRow,
  filename: string,
  isPublic: boolean,
): Promise<void> {
  let fileInfo;
  try {
    fileInfo = await objectFileStat(config, object.storage_key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      db.prepare("UPDATE objects SET state = 'missing' WHERE id = ? AND state = 'verified'").run(object.id);
      sendError(res, 404, 'object_missing', 'The object is not available', req.requestId);
      return;
    }
    throw error;
  }
  if (!fileInfo.isFile() || fileInfo.size !== object.size_bytes) {
    db.prepare("UPDATE objects SET state = 'corrupt' WHERE id = ? AND state = 'verified'").run(object.id);
    sendError(res, 503, 'object_unavailable', 'The object failed its storage check', req.requestId);
    return;
  }

  const etag = `"${object.sha256}"`;
  const mtime = new Date(object.verified_at ?? object.created_at);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', mtime.toUTCString());
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mediaType(object.mime_type));
  res.setHeader('Content-Disposition', contentDisposition(filename));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', isPublic ? 'public, max-age=86400' : 'private, no-store');
  if (!isPublic) res.setHeader('Pragma', 'no-cache');

  if (isEtagMatch(req.header('if-none-match'), etag)) {
    res.status(304).end();
    return;
  }

  let statusCode = 200;
  let start = 0;
  let end = Math.max(0, object.size_bytes - 1);
  const rangeHeader = req.header('range');
  const ifRange = req.header('if-range');
  const rangeIsCurrent = !ifRange || ifRange === etag;
  if (rangeHeader && rangeIsCurrent) {
    const ranges = rangeParser(object.size_bytes, rangeHeader);
    if (ranges === -1 || ranges === -2 || ranges.length !== 1) {
      res.setHeader('Content-Range', `bytes */${object.size_bytes}`);
      res.status(416).end();
      return;
    }
    const range = ranges[0];
    if (!range) {
      res.setHeader('Content-Range', `bytes */${object.size_bytes}`);
      res.status(416).end();
      return;
    }
    start = range.start;
    end = range.end;
    statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${object.size_bytes}`);
  }

  const contentLength = object.size_bytes === 0 ? 0 : end - start + 1;
  res.setHeader('Content-Length', String(contentLength));
  res.status(statusCode);
  if (req.method === 'HEAD' || contentLength === 0) {
    res.end();
    return;
  }

  const input = createReadStream(resolveStoragePath(config.dataRoot, object.storage_key), { start, end });
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      req.bytesSent += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(input, meter, res);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      db.prepare("UPDATE objects SET state = 'missing' WHERE id = ? AND state = 'verified'").run(object.id);
    }
    if (!res.destroyed) res.destroy(error as Error);
  }
}

function installCors(app: Express, config: AppConfig): void {
  const exposed = 'Accept-Ranges, Content-Length, Content-Range, Content-Disposition, ETag, Last-Modified, X-Request-ID';
  app.use((req, res, next) => {
    res.vary('Origin');
    const origin = req.header('origin');
    const allowed = origin ? config.corsAllowedOrigins.has(origin) : false;
    if (allowed && origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, If-None-Match, If-Range, X-Request-ID');
      res.setHeader('Access-Control-Expose-Headers', exposed);
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') {
      if (!allowed) {
        res.status(403).end();
        return;
      }
      res.status(204).end();
      return;
    }
    next();
  });
}

function installAccessLogging(app: Express, db: SqliteDatabase, config: AppConfig): void {
  app.use((req, res, next) => {
    req.requestId = requestId(req, config);
    req.clientIp = requestIp(req, config);
    req.bytesSent = 0;
    res.setHeader('X-Request-ID', req.requestId);
    res.setHeader('Cache-Control', 'private, no-store');
    let saved = false;
    const save = () => {
      if (saved) return;
      saved = true;
      const context = req.logContext;
      try {
        db.prepare(`
          INSERT INTO access_logs(created_at, object_id, action, ip, user_agent, method, path, status_code, bytes_sent, request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          nowIso(), context?.objectId ?? null, context?.action ?? 'http_request', req.clientIp,
          req.header('user-agent')?.slice(0, 1000) ?? null, req.method, safePathForLog(req.path),
          res.statusCode, Math.max(0, Math.trunc(req.bytesSent)), req.requestId,
        );
      } catch {
        // Access logging must not turn a completed transfer into a failed response.
      }
    };
    res.once('finish', save);
    res.once('close', save);
    next();
  });
}

export async function completeUpload(
  db: SqliteDatabase,
  config: AppConfig,
  session: UploadSessionRow,
  tempFilename: string,
  actual: { sizeBytes: number; sha256: string },
  installFile: typeof installContentAddressedFile = installContentAddressedFile,
): Promise<ObjectRow> {
  let installed = false;
  let finalPath: string | null = null;
  try {
    const installedFile = await installFile(config, tempFilename, actual.sha256);
    installed = installedFile.installed;
    finalPath = resolveStoragePath(config.dataRoot, installedFile.key);

    db.exec('BEGIN IMMEDIATE');
    const currentSession = db.prepare('SELECT state FROM upload_sessions WHERE id = ?').get(session.id) as { state: string } | undefined;
    if (!currentSession || currentSession.state !== 'uploading') throw new HttpError(409, 'upload_replayed', 'The upload session has already been used');

    const existing = db.prepare('SELECT * FROM objects WHERE sha256 = ?').get(actual.sha256) as ObjectRow | undefined;
    let object: ObjectRow;
    if (existing) {
      if (existing.state !== 'verified' || existing.size_bytes !== actual.sizeBytes) {
        throw new HttpError(409, 'object_unavailable', 'An object with this digest exists but is not verified');
      }
      object = existing;
    } else {
      const now = nowIso();
      object = {
        id: randomUUID(),
        public_id: randomPublicId(),
        sha256: actual.sha256,
        size_bytes: actual.sizeBytes,
        mime_type: session.mime_type,
        original_filename: session.original_filename,
        storage_key: installedFile.key,
        state: 'verified',
        created_at: now,
        verified_at: now,
      };
      db.prepare(`
        INSERT INTO objects(id, public_id, sha256, size_bytes, mime_type, original_filename, storage_key, state, created_at, verified_at)
        VALUES (@id, @public_id, @sha256, @size_bytes, @mime_type, @original_filename, @storage_key, @state, @created_at, @verified_at)
      `).run(object);
    }
    const changed = db.prepare("UPDATE upload_sessions SET state = 'completed', completed_at = ? WHERE id = ? AND state = 'uploading'")
      .run(nowIso(), session.id);
    if (changed.changes !== 1) throw new HttpError(409, 'upload_replayed', 'The upload session has already been used');
    db.exec('COMMIT');
    return object;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* No transaction remained open. */ }
    if (installed && finalPath) {
      cleanupFailedCasInstall(db, session.id, actual.sha256, finalPath);
    }
    throw error;
  } finally {
    await removeTempFile(tempFilename);
  }
}

function cleanupFailedCasInstall(db: SqliteDatabase, sessionId: string, sha256: string, filename: string): void {
  try {
    // Serialize the absence check with object creation; unlink only in this rare failure path.
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE upload_sessions SET state = 'failed' WHERE id = ? AND state = 'uploading'").run(sessionId);
    const referenced = db.prepare('SELECT 1 FROM objects WHERE sha256 = ?').get(sha256);
    const anotherUpload = db.prepare(`
      SELECT 1 FROM upload_sessions
      WHERE id <> ? AND state = 'uploading'
        AND (expected_sha256 IS NULL OR expected_sha256 = ?)
      LIMIT 1
    `).get(sessionId, sha256);
    if (!referenced && !anotherUpload) {
      try {
        unlinkSync(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    db.exec('COMMIT');
  } catch {
    try { db.exec('ROLLBACK'); } catch { /* Keep the CAS file if cleanup could not be verified. */ }
  }
}

export function createApp(config: AppConfig, db: SqliteDatabase): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  installAccessLogging(app, db, config);
  installCors(app, config);
  app.use(express.json({ limit: '64kb', strict: true, type: ['application/json', 'application/*+json'] }));

  app.get('/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      const probe = path.join(config.dataRoot, `.health-${randomUUID()}`);
      writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
      unlinkSync(probe);
      res.status(200).json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  app.post('/api/v1/uploads', serviceAuth(config), asyncRoute((req, res) => {
    setContext(req, 'upload_session_create');
    const body = requestBody(req);
    const size = body.size_bytes;
    if (!Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > config.maxObjectSize) {
      fail(400, 'invalid_size', `size_bytes must be between 0 and ${config.maxObjectSize}`);
    }
    let sha256: string | null = null;
    if (body.sha256 !== undefined && body.sha256 !== null && body.sha256 !== '') {
      if (typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(body.sha256)) fail(400, 'invalid_sha256', 'sha256 must be a 64 character hexadecimal digest');
      sha256 = body.sha256.toLowerCase();
    }
    if (typeof body.mime_type !== 'string' || body.mime_type.trim().length === 0 || body.mime_type.length > 200) fail(400, 'invalid_mime_type', 'mime_type is invalid');
    const mimeType = body.mime_type.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) fail(400, 'invalid_mime_type', 'mime_type must be a media type such as application/octet-stream');
    if (typeof body.original_filename !== 'string' || body.original_filename.trim().length === 0 || body.original_filename.length > 512 || /[\u0000-\u001f\u007f]/.test(body.original_filename)) {
      fail(400, 'invalid_filename', 'original_filename must be a non-empty filename of at most 512 characters');
    }
    const purpose = validateIdentifier(body.purpose, 'purpose', 100, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

    if (sha256) {
      const existing = db.prepare('SELECT * FROM objects WHERE sha256 = ?').get(sha256) as ObjectRow | undefined;
      if (existing?.state === 'verified' && existing.size_bytes === size) {
        return res.status(200).json({
          deduplicated: true,
          object: { id: existing.id, public_id: existing.public_id, sha256: existing.sha256, size_bytes: existing.size_bytes },
        });
      }
      if (existing?.state === 'verified' && existing.size_bytes !== size) fail(409, 'sha256_size_conflict', 'The known digest has a different size');
    }

    const id = randomUUID();
    const publicId = randomPublicId();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = dateAfterSeconds(config.uploadSessionTtlSeconds);
    db.prepare(`
      INSERT INTO upload_sessions(id, public_id, expected_sha256, expected_size, mime_type, original_filename, purpose,
        token_hash, state, expires_at, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL)
    `).run(id, publicId, sha256, size, mimeType, body.original_filename.normalize('NFC'), purpose, tokenHash(token), expiresAt, nowIso());
    return res.status(201).json({
      deduplicated: false,
      upload: {
        session_id: publicId,
        url: `${config.publicBaseUrl}/upload/${encodeURIComponent(publicId)}`,
        token,
        expires_at: expiresAt,
      },
    });
  }));

  app.put('/upload/:sessionId', asyncRoute(async (req, res) => {
    setContext(req, 'upload_receive');
    const sessionId = routeParam(req, 'sessionId');
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(sessionId)) fail(404, 'upload_session_not_found', 'Upload session was not found');
    const session = db.prepare('SELECT * FROM upload_sessions WHERE public_id = ?').get(sessionId) as UploadSessionRow | undefined;
    if (!session) fail(404, 'upload_session_not_found', 'Upload session was not found');
    const token = bearerToken(req);
    if (!token || !safeEqualHash(tokenHash(token), session.token_hash)) fail(401, 'invalid_upload_token', 'The upload token is invalid');
    if (session.state !== 'open') fail(session.state === 'expired' ? 410 : 409, 'upload_session_unavailable', 'The upload session is no longer available');
    if (Date.parse(session.expires_at) <= Date.now()) {
      db.prepare("UPDATE upload_sessions SET state = 'expired' WHERE id = ? AND state = 'open'").run(session.id);
      fail(410, 'upload_session_expired', 'The upload session has expired');
    }
    const claimed = db.prepare("UPDATE upload_sessions SET state = 'uploading' WHERE id = ? AND state = 'open'").run(session.id);
    if (claimed.changes !== 1) fail(409, 'upload_session_unavailable', 'The upload session is no longer available');

    const failSession = () => db.prepare("UPDATE upload_sessions SET state = 'failed' WHERE id = ? AND state = 'uploading'").run(session.id);
    if (req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') {
      failSession();
      req.resume();
      fail(415, 'unsupported_media_type', 'Uploads must use application/octet-stream');
    }
    const contentLength = req.header('content-length');
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) !== session.expected_size)) {
      failSession();
      req.resume();
      fail(422, 'size_mismatch', `Expected Content-Length ${session.expected_size}`);
    }

    const tempFilename = tempPath(config, session.public_id);
    let received: { sizeBytes: number; sha256: string };
    try {
      received = await receiveUpload(req, tempFilename, session.expected_size, config.maxObjectSize);
      if (session.expected_sha256 && received.sha256 !== session.expected_sha256) {
        failSession();
        await removeTempFile(tempFilename);
        fail(422, 'sha256_mismatch', 'The uploaded content does not match the expected SHA-256 digest');
      }
    } catch (error) {
      failSession();
      await removeTempFile(tempFilename);
      if (error instanceof UploadValidationError) {
        fail(422, error.code, error.message);
      }
      if (req.aborted || (error as NodeJS.ErrnoException).code === 'ECONNRESET') {
        fail(400, 'upload_interrupted', 'The upload connection ended before the file was complete');
      }
      throw error;
    }

    let object: ObjectRow;
    try {
      object = await completeUpload(db, config, session, tempFilename, received);
    } catch (error) {
      failSession();
      throw error;
    }
    req.logContext = { action: 'upload_complete', objectId: object.id };
    return res.status(201).json({
      object: { id: object.id, public_id: object.public_id, sha256: object.sha256, size_bytes: object.size_bytes },
    });
  }));

  app.get('/api/v1/objects/:id/content', serviceAuth(config), asyncRoute(async (req, res) => {
    const object = objectById(db, routeParam(req, 'id'));
    if (!object) fail(404, 'object_not_found', 'Object was not found');
    setContext(req, 'object_content', object.id);
    if (object.state !== 'verified') fail(410, 'object_unavailable', 'Object is not verified');
    await streamObject(req, res, db, config, object, object.original_filename, false);
  }));

  app.get('/api/v1/objects/:id', serviceAuth(config), (req, res) => {
    const object = objectById(db, routeParam(req, 'id'));
    if (!object) return sendError(res, 404, 'object_not_found', 'Object was not found', req.requestId);
    setContext(req, 'object_metadata', object.id);
    return res.json({
      object: {
        id: object.id,
        public_id: object.public_id,
        sha256: object.sha256,
        size_bytes: object.size_bytes,
        mime_type: object.mime_type,
        original_filename: object.original_filename,
        state: object.state,
        created_at: object.created_at,
        verified_at: object.verified_at,
      },
    });
  });

  app.post('/api/v1/objects/:id/bindings', serviceAuth(config), (req, res) => {
    const object = objectById(db, routeParam(req, 'id'));
    if (!object) return sendError(res, 404, 'object_not_found', 'Object was not found', req.requestId);
    setContext(req, 'binding_create', object.id);
    if (object.state !== 'verified') return sendError(res, 409, 'object_unavailable', 'Only verified objects can be bound', req.requestId);
    const body = requestBody(req);
    const namespace = validateIdentifier(body.namespace, 'namespace', 64, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
    const ownerType = validateIdentifier(body.owner_type, 'owner_type', 64, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
    const ownerId = validateIdentifier(body.owner_id, 'owner_id', 128, /^[^\u0000-\u001f\u007f]+$/);
    if (body.visibility !== 'public' && body.visibility !== 'private') fail(400, 'invalid_visibility', 'visibility must be public or private');
    const id = randomUUID();
    const row = db.prepare(`
      INSERT INTO object_bindings(id, object_id, namespace, owner_type, owner_id, visibility, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace, owner_type, owner_id)
      DO UPDATE SET object_id = excluded.object_id, visibility = excluded.visibility
      RETURNING id, object_id, namespace, owner_type, owner_id, visibility, created_at
    `).get(id, object.id, namespace, ownerType, ownerId, body.visibility, nowIso());
    return res.status(200).json({ binding: row });
  });

  app.delete('/api/v1/objects/:id/bindings/:bindingId', serviceAuth(config), (req, res) => {
    const object = objectById(db, routeParam(req, 'id'));
    if (!object) return sendError(res, 404, 'object_not_found', 'Object was not found', req.requestId);
    setContext(req, 'binding_delete', object.id);
    db.prepare('DELETE FROM object_bindings WHERE id = ? AND object_id = ?').run(routeParam(req, 'bindingId'), object.id);
    return res.status(204).end();
  });

  app.post('/api/v1/objects/:id/signed-url', serviceAuth(config), (req, res) => {
    const object = objectById(db, routeParam(req, 'id'));
    if (!object) return sendError(res, 404, 'object_not_found', 'Object was not found', req.requestId);
    setContext(req, 'private_url_create', object.id);
    if (object.state !== 'verified') return sendError(res, 409, 'object_unavailable', 'Only verified objects can be downloaded', req.requestId);
    const body = req.body === undefined ? {} : requestBody(req);
    const ttl = body.expires_in === undefined ? config.privateDownloadTtlSeconds : body.expires_in;
    if (!Number.isSafeInteger(ttl) || (ttl as number) < 30 || (ttl as number) > 3600) {
      return sendError(res, 400, 'invalid_expiry', 'expires_in must be between 30 and 3600 seconds', req.requestId);
    }
    if (body.filename !== undefined && (typeof body.filename !== 'string' || body.filename.length > 512 || /[\u0000-\u001f\u007f]/.test(body.filename))) {
      return sendError(res, 400, 'invalid_filename', 'filename is invalid', req.requestId);
    }
    const filename = safeDisplayFilename(typeof body.filename === 'string' && body.filename ? body.filename : object.original_filename);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = dateAfterSeconds(ttl as number);
    db.prepare('INSERT INTO private_download_tokens(id, token_hash, object_id, filename, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), tokenHash(token), object.id, filename, expiresAt, nowIso());
    return res.status(201).json({ url: `${config.publicBaseUrl}/private/${token}`, expires_at: expiresAt });
  });

  app.get('/private/:token', asyncRoute(async (req, res) => {
    const token = routeParam(req, 'token');
    if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) fail(404, 'download_not_found', 'Download URL was not found');
    const hashed = tokenHash(token);
    const row = db.prepare(`
      SELECT t.filename, t.expires_at, o.* FROM private_download_tokens t
      JOIN objects o ON o.id = t.object_id WHERE t.token_hash = ?
    `).get(hashed) as (ObjectRow & { filename: string; expires_at: string }) | undefined;
    if (!row || Date.parse(row.expires_at) <= Date.now() || row.state !== 'verified') {
      if (row && Date.parse(row.expires_at) <= Date.now()) db.prepare('DELETE FROM private_download_tokens WHERE expires_at <= ?').run(nowIso());
      fail(404, 'download_not_found', 'Download URL was not found or has expired');
    }
    setContext(req, 'private_download', row.id);
    await streamObject(req, res, db, config, row, row.filename, false);
  }));

  app.get('/o/:publicId/:filename', asyncRoute(async (req, res) => {
    const object = db.prepare(`
      SELECT o.* FROM objects o
      WHERE o.public_id = ? AND o.state = 'verified'
        AND EXISTS (SELECT 1 FROM object_bindings b WHERE b.object_id = o.id AND b.visibility = 'public')
      LIMIT 1
    `).get(routeParam(req, 'publicId')) as ObjectRow | undefined;
    if (!object) fail(404, 'object_not_found', 'Public object was not found');
    setContext(req, 'public_download', object.id);
    await streamObject(req, res, db, config, object, routeParam(req, 'filename'), true);
  }));

  app.post('/api/admin/gc', adminAuth(config), asyncRoute(async (req, res) => {
    setContext(req, 'admin_gc');
    const body = req.body === undefined ? {} : requestBody(req);
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') fail(400, 'invalid_request', 'dry_run must be a boolean');
    if (body.confirm !== undefined && typeof body.confirm !== 'boolean') fail(400, 'invalid_request', 'confirm must be a boolean');
    const limit = body.limit === undefined ? 50 : body.limit;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) fail(400, 'invalid_limit', 'limit must be an integer between 1 and 100');
    if (!Array.isArray(body.object_ids) || body.object_ids.length < 1 || body.object_ids.length > 100 || body.object_ids.some((id) => typeof id !== 'string' || id.length < 16 || id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(id))) {
      fail(400, 'invalid_object_ids', 'object_ids must contain between 1 and 100 valid object IDs');
    }
    if (new Set(body.object_ids as string[]).size !== body.object_ids.length) fail(400, 'invalid_object_ids', 'object_ids must be unique');
    const options: GcOptions = {
      dryRun: body.dry_run !== false,
      limit: limit as number,
      objectIds: body.object_ids as string[],
      confirm: body.confirm === true,
    };
    if (!options.dryRun && !options.confirm) fail(400, 'confirmation_required', 'confirm must be true before GC deletes filtered candidates');
    const result = await runGarbageCollection(db, config, options);
    return res.json(result);
  }));

  app.get('/api/admin/gc/runs', adminAuth(config), (req, res) => {
    setContext(req, 'admin_gc_audit_list');
    const limit = boundedQueryLimit(req);
    const after = decodeGcRunCursor(optionalCursor(req));
    const rows = db.prepare(`
      SELECT id, created_at, completed_at, status, dry_run, requested_limit, requested_object_ids,
        candidates, bytes_reclaimable, deleted, skipped, failed
      FROM admin_gc_runs
      WHERE (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(after?.created_at ?? null, after?.created_at ?? null, after?.created_at ?? null, after?.id ?? null, limit + 1) as Array<Record<string, unknown> & { id: string; created_at: string }>;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      ...row,
      dry_run: row.dry_run === 1,
      requested_object_ids: JSON.parse(String(row.requested_object_ids)) as string[],
    }));
    const last = items.at(-1);
    return res.json({ items, next_cursor: hasMore && last ? encodeGcRunCursor({ created_at: last.created_at, id: last.id }) : null });
  });

  app.get('/api/admin/gc/runs/:runId', adminAuth(config), (req, res) => {
    setContext(req, 'admin_gc_audit_detail');
    const runId = routeParam(req, 'runId');
    const run = db.prepare(`
      SELECT id, created_at, completed_at, status, dry_run, requested_limit, requested_object_ids,
        candidates, bytes_reclaimable, deleted, skipped, failed
      FROM admin_gc_runs WHERE id = ?
    `).get(runId) as (Record<string, unknown> & { id: string; requested_object_ids: string; dry_run: number }) | undefined;
    if (!run) return sendError(res, 404, 'gc_run_not_found', 'GC run was not found', req.requestId);
    const items = db.prepare(`
      SELECT object_id, object_public_id, sha256, size_bytes, outcome, created_at
      FROM admin_gc_run_items WHERE run_id = ? ORDER BY created_at ASC, object_id ASC
    `).all(runId);
    return res.json({ run: { ...run, dry_run: run.dry_run === 1, requested_object_ids: JSON.parse(run.requested_object_ids) as string[] }, items });
  });

  app.get('/api/admin/inventory/objects', adminAuth(config), (req, res) => {
    setContext(req, 'admin_object_inventory');
    const stateRaw = req.query.state;
    const states = ['verified', 'missing', 'corrupt', 'quarantined'] as const;
    if (stateRaw !== undefined && (typeof stateRaw !== 'string' || !states.includes(stateRaw as (typeof states)[number]))) {
      fail(400, 'invalid_state', 'state must be verified, missing, corrupt, or quarantined');
    }
    const after = optionalCursor(req);
    return res.json(listAdminObjectInventory(db, {
      limit: boundedQueryLimit(req),
      ...(after ? { after } : {}),
      ...(typeof stateRaw === 'string' ? { state: stateRaw as (typeof states)[number] } : {}),
    }));
  });

  app.get('/api/admin/inventory/bindings', adminAuth(config), (req, res) => {
    setContext(req, 'admin_binding_inventory');
    const namespace = req.query.namespace;
    const ownerType = req.query.owner_type;
    if (typeof namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(namespace)) fail(400, 'invalid_namespace', 'namespace is required and must be valid');
    if (typeof ownerType !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(ownerType)) fail(400, 'invalid_owner_type', 'owner_type is required and must be valid');
    const after = optionalCursor(req);
    return res.json(listAdminBindingInventory(db, {
      namespace,
      ownerType,
      limit: boundedQueryLimit(req),
      ...(after ? { after } : {}),
    }));
  });

  app.post('/api/admin/integrity/scan', adminAuth(config), asyncRoute(async (req, res) => {
    setContext(req, 'admin_integrity_scan');
    return res.json(await scanIntegrity(db, config));
  }));

  app.use((_req, res) => sendError(res, 404, 'not_found', 'Route was not found', _req.requestId));

  const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.headersSent || res.destroyed) return;
    if ((error as { status?: number }).status === 413) {
      sendError(res, 413, 'payload_too_large', 'Request body exceeds the allowed size', req.requestId);
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      sendError(res, 400, 'invalid_json', 'Request body must be valid JSON', req.requestId);
      return;
    }
    const status = Number((error as { status?: unknown }).status);
    if (status >= 400 && status < 500) {
      sendError(res, status, 'invalid_request', 'The request could not be parsed', req.requestId);
      return;
    }
    const httpError = error instanceof HttpError ? error : null;
    sendError(res, httpError?.statusCode ?? 500, httpError?.code ?? 'internal_error', httpError?.message ?? 'The request could not be completed', req.requestId);
  };
  app.use(errorHandler);
  return app;
}
