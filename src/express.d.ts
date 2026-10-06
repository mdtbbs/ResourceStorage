import type { Request } from 'express';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      clientIp: string | null;
      logContext?: { action?: string; objectId?: string | null };
      bytesSent: number;
    }
  }
}

export {};
