import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AppConfig } from './config';
import { HttpError } from './errors';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function safeEqualString(actual: string, expected: string): boolean {
  return timingSafeEqual(digest(actual), digest(expected));
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeEqualHash(actualHash: string, expectedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedHash)) return false;
  return timingSafeEqual(digest(actualHash), digest(expectedHash));
}

export function bearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1] ?? null;
}

function rejectUnauthorized(req: Request, res: Response): void {
  res.setHeader('WWW-Authenticate', 'Bearer realm="resource-storage"');
  res.status(401).json({
    error: { code: 'unauthorized', message: 'A valid bearer token is required' },
    request_id: req.requestId,
  });
}

export function serviceAuth(config: AppConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const supplied = bearerToken(req);
    if (!supplied || !safeEqualString(supplied, config.serviceApiKey)) return rejectUnauthorized(req, res);
    next();
  };
}

export function adminAuth(config: AppConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const supplied = bearerToken(req);
    const serviceMatches = supplied ? safeEqualString(supplied, config.serviceApiKey) : false;
    const adminMatches = supplied && config.adminApiKey ? safeEqualString(supplied, config.adminApiKey) : false;
    if (!serviceMatches && !adminMatches) return rejectUnauthorized(req, res);
    next();
  };
}

export function asyncRoute(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  return new HttpError(500, 'internal_error', 'The request could not be completed');
}
