import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export interface AppConfig {
  nodeEnv: string;
  port: number;
  dataRoot: string;
  databasePath: string;
  serviceApiKey: string;
  adminApiKey: string | null;
  publicBaseUrl: string;
  maxObjectSize: number;
  uploadSessionTtlSeconds: number;
  privateDownloadTtlSeconds: number;
  gcGraceDays: number;
  accessLogRetentionDays: number;
  corsAllowedOrigins: Set<string>;
  trustEdgeOne: boolean;
  trustProxyHops: number;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw.toLowerCase() === 'true') return true;
  if (raw.toLowerCase() === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function requiredSecret(env: NodeJS.ProcessEnv, name: string, optional = false): string | null {
  const value = env[name]?.trim();
  if (!value && optional) return null;
  if (!value || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const port = integer(env, 'PORT', 5200, 1, 65535);
  const dataRoot = path.resolve(env.DATA_ROOT?.trim() || './data');
  const databasePath = path.resolve(env.DATABASE_PATH?.trim() || path.join(dataRoot, 'resource-storage.sqlite'));
  const serviceApiKey = requiredSecret(env, 'RES_SERVICE_API_KEY')!;
  const adminApiKey = requiredSecret(env, 'RES_ADMIN_API_KEY', true);
  const publicBaseUrl = (env.PUBLIC_BASE_URL?.trim() || 'https://res.mdtbbs.cn').replace(/\/+$/, '');

  let parsedPublicUrl: URL;
  try {
    parsedPublicUrl = new URL(publicBaseUrl);
  } catch {
    throw new Error('PUBLIC_BASE_URL must be a valid absolute URL');
  }
  if (parsedPublicUrl.protocol !== 'https:' && nodeEnv === 'production') {
    throw new Error('PUBLIC_BASE_URL must use HTTPS in production');
  }
  if (parsedPublicUrl.username || parsedPublicUrl.password || parsedPublicUrl.pathname !== '/' || parsedPublicUrl.search || parsedPublicUrl.hash) {
    throw new Error('PUBLIC_BASE_URL must contain only the public service origin');
  }

  const originsRaw = env.CORS_ALLOWED_ORIGINS?.trim()
    || (nodeEnv === 'production' ? 'https://mdtbbs.cn' : 'https://mdtbbs.cn,http://localhost:3000');
  const corsAllowedOrigins = new Set<string>();
  for (const item of originsRaw.split(',').map((origin) => origin.trim()).filter(Boolean)) {
    if (item === '*') throw new Error('CORS_ALLOWED_ORIGINS cannot contain *');
    let parsed: URL;
    try {
      parsed = new URL(item);
    } catch {
      throw new Error(`Invalid CORS origin: ${item}`);
    }
    if (parsed.origin !== item || (nodeEnv === 'production' && parsed.protocol !== 'https:')) {
      throw new Error(`CORS origin must be an exact origin${nodeEnv === 'production' ? ' using HTTPS' : ''}`);
    }
    corsAllowedOrigins.add(item);
  }
  if (nodeEnv === 'production' && corsAllowedOrigins.size === 0) {
    throw new Error('CORS_ALLOWED_ORIGINS must include at least one explicit HTTPS origin in production');
  }

  return {
    nodeEnv,
    port,
    dataRoot,
    databasePath,
    serviceApiKey,
    adminApiKey,
    publicBaseUrl,
    maxObjectSize: integer(env, 'MAX_OBJECT_SIZE', 268_435_456, 1, Number.MAX_SAFE_INTEGER),
    uploadSessionTtlSeconds: integer(env, 'UPLOAD_SESSION_TTL_SECONDS', 900, 30, 86_400),
    privateDownloadTtlSeconds: integer(env, 'PRIVATE_DOWNLOAD_TTL_SECONDS', 300, 30, 3_600),
    gcGraceDays: integer(env, 'GC_GRACE_DAYS', 7, 0, 36_500),
    accessLogRetentionDays: integer(env, 'ACCESS_LOG_RETENTION_DAYS', 210, 1, 36_500),
    corsAllowedOrigins,
    trustEdgeOne: boolean(env, 'TRUST_EDGEONE', false),
    trustProxyHops: integer(env, 'TRUST_PROXY_HOPS', 1, 0, 16),
  };
}
