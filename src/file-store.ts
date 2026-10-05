import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from './config';
import { UploadValidationError } from './errors';

export interface UploadedFile {
  sizeBytes: number;
  sha256: string;
}

export function storageKey(sha256: string): string {
  return `objects/sha256/${sha256.slice(0, 2)}/${sha256}`;
}

export function resolveStoragePath(dataRoot: string, key: string): string {
  if (!/^objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key)) {
    throw new Error('Invalid object storage key');
  }
  const resolvedRoot = path.resolve(dataRoot);
  const resolved = path.resolve(resolvedRoot, key);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Object path escaped the data root');
  return resolved;
}

export function tempPath(config: AppConfig, sessionPublicId: string): string {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(sessionPublicId)) throw new Error('Invalid upload session id');
  return path.join(config.dataRoot, 'temp', `${sessionPublicId}--${randomUUID()}.part`);
}

export async function receiveUpload(
  request: NodeJS.ReadableStream,
  destination: string,
  expectedSize: number,
  maxObjectSize: number,
): Promise<UploadedFile> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > maxObjectSize) {
        callback(new UploadValidationError('size_limit', `Upload exceeds the ${maxObjectSize} byte limit`));
        return;
      }
      if (sizeBytes > expectedSize) {
        callback(new UploadValidationError('size_mismatch', `Upload is larger than the expected ${expectedSize} bytes`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(request, meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    throw error;
  }

  if (sizeBytes !== expectedSize) {
    await unlink(destination).catch(() => undefined);
    throw new UploadValidationError('size_mismatch', `Expected ${expectedSize} bytes but received ${sizeBytes}`);
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

export async function hashFile(filename: string): Promise<{ sizeBytes: number; sha256: string }> {
  const digest = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of createReadStream(filename)) {
    const bytes = chunk as Buffer;
    digest.update(bytes);
    sizeBytes += bytes.length;
  }
  return { sizeBytes, sha256: digest.digest('hex') };
}

export async function installContentAddressedFile(config: AppConfig, tempFilename: string, sha256: string): Promise<{ key: string; installed: boolean }> {
  const key = storageKey(sha256);
  const destination = resolveStoragePath(config.dataRoot, key);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
  try {
    await link(tempFilename, destination);
    return { key, installed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const current = await hashFile(destination);
    const incoming = await hashFile(tempFilename);
    if (current.sha256 !== sha256 || current.sizeBytes !== incoming.sizeBytes) {
      throw new Error('A conflicting file already occupies the content-addressed path');
    }
    return { key, installed: false };
  }
}

export async function removeTempFile(filename: string): Promise<void> {
  await unlink(filename).catch(() => undefined);
}

export async function objectFileStat(config: AppConfig, key: string) {
  return stat(resolveStoragePath(config.dataRoot, key));
}
