import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import type { AppConfig } from './config';

function parseIp(value: string | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim().replace(/^"|"$/g, '');
  if (candidate.startsWith('[') && candidate.includes(']')) candidate = candidate.slice(1, candidate.indexOf(']'));
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) candidate = candidate.slice(0, candidate.lastIndexOf(':'));
  candidate = candidate.split('%', 1)[0] ?? candidate;
  if (isIP(candidate) === 0) return null;
  return candidate.startsWith('::ffff:') ? candidate.slice('::ffff:'.length) : candidate;
}

export function requestIp(req: Request, config: AppConfig): string | null {
  if (config.trustEdgeOne) {
    const edgeIp = parseIp(req.header('eo-connecting-ip'));
    if (edgeIp) return edgeIp;
    const forwarded = req.header('x-forwarded-for');
    if (forwarded && config.trustProxyHops > 0) {
      const chain = forwarded.split(',').map((part) => part.trim()).filter(Boolean);
      const index = Math.max(0, chain.length - config.trustProxyHops);
      const forwardedIp = parseIp(chain[index]);
      if (forwardedIp) return forwardedIp;
    }
  }
  return parseIp(req.socket.remoteAddress);
}

export function requestId(req: Request, config: AppConfig): string {
  if (config.trustEdgeOne) {
    const candidate = req.header('eo-log-uuid') ?? req.header('eo-request-id');
    if (candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)) return candidate;
  }
  return randomUUID();
}
