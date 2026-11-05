import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthService } from './auth.ts';
import type { ChildLogger } from '../logger/logger.ts';

declare module 'express-serve-static-core' {
  interface Request {
    authPayload?: { sub: string; iat: number; exp: number };
  }
}

export function requireAuth(
  authService: AuthService,
  logger?: ChildLogger,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const token =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;

    if (token === null) {
      logger?.warn(`401 sem token ${req.ip} ${req.method} ${req.originalUrl}`);
      res.status(401).json({ ok: false, error: 'Autenticação necessária' });
      return;
    }

    const payload = authService.verifyToken(token);
    if (payload === null) {
      logger?.warn(`401 token inválido ${req.ip} ${req.method} ${req.originalUrl}`);
      res.status(401).json({ ok: false, error: 'Sessão inválida ou expirada' });
      return;
    }

    req.authPayload = payload;
    next();
  };
}

/** Limite global: protege o processo contra rajadas do painel/externos. */
export function globalLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Muitas requisições — espere um pouco, cabra' },
  });
}

/** Limite duro apenas no login. */
export function authLimiter(): RequestHandler {
  return rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { ok: false, error: 'Muitas tentativas de login. Aguarde dez minutos.' },
  });
}

/** Se um handler lança, responde 500 e registra no logger. */
export function errorHandler(log: ChildLogger): {
  (error: unknown, req: Request, res: Response, next: NextFunction): void;
} {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    log.error(`500 ${req.method} ${req.originalUrl}: ${describeError(error)}`);
    res.status(500).json({ ok: false, error: 'Erro interno' });
  };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
