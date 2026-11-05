import { existsSync } from 'node:fs';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppContext } from './types.ts';
import { buildApiRouter } from './api/routes.ts';

/**
 * ETAPA 8: CSP apertada quando servimos o build de produção do painel.
 * No dev o Vite injeta scripts inline → CSP falsa (documentado).
 * data: = favicon/QR base64; blob: = prévias de mídia/imagens do painel;
 * ws:/wss: = Socket.IO (mesma origem em prod, mas CSP3 é rígida com ws).
 */
const CSP_DIRECTIVES = {
  useDefaults: false,
  directives: {
    'default-src': ["'self'"],
    'script-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", 'ws:', 'wss:'],
    'font-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
  } as const,
} as const;

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');

  // Produção: serve o build do frontend (frontend/dist) com fallback SPA.
  const frontendDist = resolveFrontendDist();
  const servingProdPanel = frontendDist !== null;
  app.use(
    helmet({
      contentSecurityPolicy: servingProdPanel ? CSP_DIRECTIVES : false,
    }),
  );
  app.use(express.json({ limit: '256kb' }));

  app.use('/api', buildApiRouter(ctx));

  if (frontendDist) {
    app.use(express.static(frontendDist));
    app.get(/^\/(?!api|socket\.io).*/, (_req, res) => {
      res.sendFile(join(frontendDist, 'index.html'));
    });
  }

  return app;
}

function resolveFrontendDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ do backend compilado: ../.. = backend/ ; no dev (tsx): src/ → ../../
  const candidates = [
    join(here, '..', '..', 'frontend', 'dist'),
    join(here, '..', '..', '..', 'frontend', 'dist'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}
