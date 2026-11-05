import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { AppContext } from '../types.ts';
import { requireAuth, authLimiter, globalLimiter, errorHandler } from '../security/middleware.ts';
import type { LogLevel } from '../config/types.ts';
import { AI_PRESETS } from '../ai/presets.ts';
import type { LogEntry } from '../logger/logger.ts';

const loginSchema = z.object({
  password: z.string().min(1).max(200),
});

const settingsSchema = z
  .object({
    ai: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    log: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']) }).optional(),
    whatsapp: z
      .object({
        autoReconnect: z.boolean().optional(),
        respondInPrivate: z.boolean().optional(),
      })
      .optional(),
    // ETAPA 9: dono/repo vão direto pra URL da API do GitHub — regex
    // travada (sem barra nem nada que perigue no path).
    updates: z
      .object({
        channel: z.enum(['stable', 'beta', 'development']).optional(),
        autoCheck: z.boolean().optional(),
        intervalHours: z.number().int().min(1).max(168).optional(),
        owner: z.string().max(100).regex(/^$|^[A-Za-z0-9-]+$/).optional(),
        repo: z.string().max(100).regex(/^$|^[A-Za-z0-9._-]+$/).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200),
  })
  .strict();

interface Rejection {
  ok: false;
  error: string;
}

function validationError(error: z.ZodError): Rejection {
  const first = error.issues[0];
  if (!first) return { ok: false, error: 'Payload inválido' };
  const field = first.path.filter((part) => typeof part !== 'number' && part.length > 0).join('.');
  return { ok: false, error: field === '' ? first.message : `${field}: ${first.message}` };
}

function describeUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildApiRouter(ctx: AppContext): Router {
  const router = Router();
  const limiter = globalLimiter();
  const loginLimiter = authLimiter();
  router.use(limiter);

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, name: 'Geraldo AI', version: ctx.status.snapshot().version });
  });

  router.post('/auth/login', loginLimiter, (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    const result = ctx.authService.login(parsed.data.password);
    if (!result.ok) {
      ctx.log.warn(`login falhou (${result.reason}): ${req.ip}`);
      const status = result.reason === 'not-configured' ? 503 : 401;
      res.status(status).json({ ok: false, error: 'Senha incorreta' } satisfies Rejection);
      return;
    }
    ctx.log.info(`login realizado: ${req.ip}`);
    res.json({ ok: true, token: result.token, expiresAt: result.expiresAt });
  });

  router.use(requireAuth(ctx.authService, ctx.log));

  router.get('/auth/me', (req: Request, res: Response) => {
    const payload = req.authPayload;
    if (!payload) {
      res.status(401).json({ ok: false, error: 'Sessão inválida' });
      return;
    }
    res.json({ ok: true, sub: payload.sub, expiresAt: new Date(payload.exp).toISOString() });
  });

  router.get('/system/status', (_req: Request, res: Response) => {
    res.json(ctx.status.snapshot());
  });

  // ETAPA 8: contagens reais do banco pro dashboard (conversas/mensagens
  // 24h, mídia por categoria, fila) — SQL de contagem, sem estimativa.
  router.get('/stats', (_req: Request, res: Response) => {
    res.json(ctx.stats.snapshot());
  });

  router.get('/settings', (_req: Request, res: Response) => {
    res.json(ctx.settings.getPublic());
  });

  // Presets públicos de provedor (sem segredos — só IDs/URLs/ajuda).
  router.get('/settings/ai-presets', (_req: Request, res: Response) => {
    res.json({ ok: true, presets: AI_PRESETS });
  });

  router.put('/settings', (req: Request, res: Response) => {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    const patch = parsed.data;
    if (patch.ai) ctx.settings.updateAI(patch.ai);
    if (patch.log) ctx.settings.setLogLevel(patch.log.level);
    if (patch.whatsapp) {
      if (patch.whatsapp.autoReconnect !== undefined) {
        ctx.settings.setWhatsappAutoReconnect(patch.whatsapp.autoReconnect);
      }
      if (patch.whatsapp.respondInPrivate !== undefined) {
        ctx.settings.setWhatsappRespondInPrivate(patch.whatsapp.respondInPrivate);
      }
    }
    if (patch.updates) ctx.settings.updateUpdates(patch.updates);
    ctx.broadcastSettings();
    res.json(ctx.settings.getPublic());
  });

  router.put('/security/password', (req: Request, res: Response) => {
    const parsed = passwordChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    const login = ctx.authService.login(parsed.data.currentPassword);
    if (!login.ok) {
      res.status(401).json({ ok: false, error: 'Senha atual incorreta' } satisfies Rejection);
      return;
    }
    ctx.authService.updateSecrets(
      ctx.securityHooks.changePassword(parsed.data.newPassword),
    );
    res.json({ ok: true });
  });

  router.get('/logs', (req: Request, res: Response) => {
    const level = typeof req.query.level === 'string' ? (req.query.level as LogLevel) : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit =
      typeof req.query.limit === 'string' && req.query.limit !== ''
        ? Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 300, 1), 1000)
        : undefined;
    const logs: LogEntry[] = ctx.logger.recent({ level, search, limit });
    res.json({ ok: true, entries: logs });
  });

  // ── WhatsApp (ETAPA 2) ────────────────────────────────────────────────
  const sendSchema = z.object({ text: z.string().min(1).max(4000) }).strict();
  const memorySchema = z.object({ enabled: z.boolean() }).strict();

  router.get('/whatsapp/status', (_req: Request, res: Response) => {
    res.json({ ...ctx.whatsapp.service.info(), hasSession: ctx.whatsapp.service.hasSession() });
  });

  router.post('/whatsapp/connect', (_req: Request, res: Response) => {
    void ctx.whatsapp.service.start();
    res.status(202).json({ ok: true, info: ctx.whatsapp.service.info() });
  });

  router.post('/whatsapp/disconnect', (_req: Request, res: Response) => {
    void ctx.whatsapp.service.disconnect().then(() => undefined);
    res.status(202).json({ ok: true, info: ctx.whatsapp.service.info() });
  });

  router.delete('/whatsapp/session', (_req: Request, res: Response) => {
    void ctx.whatsapp.service
      .destroySession()
      .then((info) => res.json({ ok: true, info }))
      .catch((error: unknown) => {
        ctx.log.error(`erro ao apagar sessão WhatsApp: ${String(error)}`);
        res.status(500).json({ ok: false, error: 'Falha ao apagar sessão' });
      });
  });

  router.get('/whatsapp/conversations', (req: Request, res: Response) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit =
      typeof req.query.limit === 'string' && req.query.limit !== ''
        ? Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 200)
        : undefined;
    res.json({ ok: true, chats: ctx.whatsapp.store.listChats({ search, limit }) });
  });

  router.get('/whatsapp/conversations/:jid/messages', (req: Request, res: Response) => {
    const limit =
      typeof req.query.limit === 'string' && req.query.limit !== ''
        ? Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 80, 1), 200)
        : undefined;
    res.json({
      ok: true,
      messages: ctx.whatsapp.store.listMessages(req.params['jid'] ?? '', limit),
    });
  });

  router.put('/whatsapp/conversations/:jid/memory', (req: Request, res: Response) => {
    const parsed = memorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    const ok = ctx.whatsapp.store.setMemoryEnabled(req.params['jid'] ?? '', parsed.data.enabled);
    if (!ok) {
      res.status(404).json({ ok: false, error: 'Conversa não encontrada' } satisfies Rejection);
      return;
    }
    ctx.whatsapp.bridge.emit('conversation:update', { jid: req.params['jid'] });
    res.json({ ok: true, enabled: parsed.data.enabled });
  });

  router.post('/whatsapp/conversations/:jid/message', (req: Request, res: Response) => {
    const parsed = sendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    void (async () => {
      try {
        await ctx.whatsapp.service.sendText(req.params['jid'] ?? '', parsed.data.text);
        res.json({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(502).json({ ok: false, error: message });
      }
    })();
  });

  // ── IA (ETAPA 3) ──────────────────────────────────────────────────────
  const aiTestSchema = z.object({ prompt: z.string().max(2000).optional() }).strict();

  router.post('/ai/test', (req: Request, res: Response) => {
    const parsed = aiTestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    void (async () => {
      const result = await ctx.ai.testGenerate(parsed.data.prompt ?? '');
      res.json(result);
    })();
  });

  // ── Mídias (ETAPA 4) ──────────────────────────────────────────────────
  const downloadSchema = z
    .object({ url: z.string().min(8).max(600), format: z.enum(['audio', 'video']) })
    .strict();

  router.get('/media/tools', async (_req: Request, res: Response) => {
    const tools = await ctx.media.engine.toolsStatus();
    res.json({
      ok: true,
      ytdlpPath: tools.ytdlpPath,
      ffmpegPath: tools.ffmpegPath,
      ytdlpVersion: tools.ytdlpVersion,
      ffmpegVersion: tools.ffmpegVersion,
      ready: tools.ytdlpPath !== null && tools.ffmpegPath !== null,
      hint: tools.ytdlpPath === null ? 'instale com: winget install yt-dlp.yt-dlp' : null,
    });
  });

  router.post('/media/download', (req: Request, res: Response) => {
    const parsed = downloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    const enqueued = ctx.media.engine.enqueueDownload(parsed.data);
    if (!enqueued.ok) {
      res.status(400).json({ ok: false, error: enqueued.error } satisfies Rejection);
      return;
    }
    res.status(202).json({ ok: true, jobId: enqueued.id });
  });

  router.get('/media/jobs', (req: Request, res: Response) => {
    const limit =
      typeof req.query.limit === 'string' && req.query.limit !== ''
        ? Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200)
        : undefined;
    res.json({ ok: true, jobs: ctx.media.runner.list({ limit }) });
  });

  router.get('/media/jobs/:id', (req: Request, res: Response) => {
    const job = ctx.media.runner.get(req.params['id'] ?? '');
    if (job === null) {
      res.status(404).json({ ok: false, error: 'Tarefa não encontrada' } satisfies Rejection);
      return;
    }
    res.json({ ok: true, job });
  });

  router.post('/media/jobs/:id/cancel', (req: Request, res: Response) => {
    const done = ctx.media.runner.cancel(req.params['id'] ?? '');
    if (!done) {
      res.status(409).json({ ok: false, error: 'job fora da fila ou já finalizado' } satisfies Rejection);
      return;
    }
    res.json({ ok: true });
  });

  router.get('/media/files', (req: Request, res: Response) => {
    const limit =
      typeof req.query.limit === 'string' && req.query.limit !== ''
        ? Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500)
        : undefined;
    res.json({ ok: true, files: ctx.media.engine.listFiles({ limit }) });
  });

  router.get('/media/files/:id/file', (req: Request, res: Response) => {
    const file = ctx.media.engine.getFile(req.params['id'] ?? '');
    if (file === null) {
      res.status(404).json({ ok: false, error: 'Arquivo não catalogado' } satisfies Rejection);
      return;
    }
    const mediaRoot = ctx.paths.mediaDir;
    if (!file.filePath.startsWith(mediaRoot) || !existsSync(file.filePath)) {
      res.status(410).json({ ok: false, error: 'arquivo sumiu do disco' } satisfies Rejection);
      return;
    }
    res.download(file.filePath, basename(file.filePath), (error) => {
      if (error !== undefined && error !== null) {
        ctx.log.warn(`download do painel falhou: ${String(error.message)}`);
        res.status(500).json({ ok: false, error: 'Falha ao enviar arquivo' });
      }
    });
  });

  // ── ETAPA 5: mens/sons (MyInstants) ────────────────────────────────────
  const memeSendSchema = z
    .object({ soundId: z.string().min(8).max(120), jid: z.string().min(5).max(80) })
    .strict();
  const memeImportSchema = z
    .object({ title: z.string().min(1).max(200), url: z.string().min(12).max(500) })
    .strict();

  router.get('/memes/search', (req: Request, res: Response) => {
    const query = typeof req.query['q'] === 'string' ? req.query['q'] : '';
    void ctx.memes
      .search(query)
      .then((outcome) => {
        if (!outcome.ok) {
          res.status(429).json({ ok: false, error: `espera ${Math.ceil(outcome.waitMs / 1000)} s antes da próxima busca`, waitMs: outcome.waitMs } satisfies Rejection & { waitMs: number });
          return;
        }
        res.json({ ok: true, items: outcome.items });
      })
      .catch((error: unknown) => {
        res.status(500).json({ ok: false, error: describeUnknown(error) } satisfies Rejection);
      });
  });

  router.post('/memes/import', (req: Request, res: Response) => {
    const parsed = memeImportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    void ctx.memes
      .importSound(parsed.data)
      .then((outcome) => {
        if (!outcome.ok) {
          res.status(429).json({ ok: false, error: `espera ${Math.ceil(outcome.waitMs / 1000)} s antes do próximo download`, waitMs: outcome.waitMs } satisfies Rejection & { waitMs: number });
          return;
        }
        res.status(201).json({ ok: true, id: outcome.id });
      })
      .catch((error: unknown) => {
        res.status(500).json({ ok: false, error: describeUnknown(error) } satisfies Rejection);
      });
  });

  router.get('/memes/sounds', (req: Request, res: Response) => {
    const limit =
      typeof req.query.limit === 'string' && req.query.limit !== ''
        ? Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200)
        : undefined;
    res.json({ ok: true, sounds: ctx.memes.listSounds(limit) });
  });

  router.post('/memes/send', (req: Request, res: Response) => {
    const parsed = memeSendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    void ctx.memes
      .send(parsed.data.soundId, parsed.data.jid)
      .then((sent) => {
        res.json({ ok: true, wamid: sent.wamid, title: sent.title });
      })
      .catch((error: unknown) => {
        const message = describeUnknown(error);
        const status = message.includes('não está conectado')
          ? 409
          : message.includes('som não encontrado') || message.includes('sumiu do disco')
            ? 404
            : 400;
        res.status(status).json({ ok: false, error: message } satisfies Rejection);
      });
  });

  // ── ETAPA 6: voz (Piper TTS local) ──────────────────────────────────────
  const voiceSynthSchema = z
    .object({ text: z.string().min(1).max(400), voiceId: z.string().min(4).max(80).optional() })
    .strict();
  const voiceSendSchema = z
    .object({ clipId: z.string().min(8).max(120), jid: z.string().min(5).max(80) })
    .strict();
  const voiceInstallSchema = z
    .object({ voiceId: z.string().min(4).max(80).optional() })
    .strict();

  router.get('/voice/status', (req, res) => {
    void ctx.voice
      .status()
      .then((state) => {
        res.json({ ok: true, ...state });
      })
      .catch((error: unknown) => {
        res.status(500).json({ ok: false, error: describeUnknown(error) } satisfies Rejection);
      });
  });

  router.post('/voice/install', (req, res) => {
    const body = req.body ?? {};
    const parsed = voiceInstallSchema.safeParse(body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    void ctx.voice
      .installAssets(parsed.data.voiceId ?? 'pt_BR-faber-medium')
      .then(() => {
        res.json({ ok: true, note: 'piper e voz instalados' });
      })
      .catch((error: unknown) => {
        res.status(500).json({ ok: false, error: describeUnknown(error) } satisfies Rejection);
      });
  });

  router.post('/voice/synthesize', (req, res) => {
    const parsed = voiceSynthSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    void ctx.voice
      .synthesize(parsed.data.text, parsed.data.voiceId)
      .then((made) => {
        res.status(201).json({ ok: true, id: made.id, voice: made.voice, cached: made.cached });
      })
      .catch((error: unknown) => {
        const message = describeUnknown(error);
        const status = message.includes('já sintetizando') ? 409 : 400;
        res.status(status).json({ ok: false, error: message } satisfies Rejection);
      });
  });

  router.get('/voice/clips', (req, res) => {
    const limit =
      typeof req.query.limit === 'string' && req.query.limit !== ''
        ? Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200)
        : undefined;
    res.json({ ok: true, clips: ctx.voice.listClips(limit) });
  });

  router.post('/voice/send', (req, res) => {
    const parsed = voiceSendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    void ctx.voice
      .send(parsed.data.clipId, parsed.data.jid)
      .then((sent) => {
        res.json({ ok: true, wamid: sent.wamid });
      })
      .catch((error: unknown) => {
        const message = describeUnknown(error);
        const status = message.includes('não está conectado')
          ? 409
          : message.includes('não encontrado') || message.includes('sumiu do disco')
            ? 404
            : 400;
        res.status(status).json({ ok: false, error: message } satisfies Rejection);
      });
  });

  // ── ETAPA 7: imagens (geração por prompt + envio) ──────────────────────
  const imagesGenerateSchema = z
    .object({
      prompt: z.string().min(1).max(1000),
      size: z.string().regex(/^\d{3,4}x\d{3,4}$/).optional(),
    })
    .strict();
  const imagesSendSchema = z
    .object({
      imageId: z.string().min(8).max(120),
      jid: z.string().min(5).max(80),
      caption: z.string().max(300).optional(),
    })
    .strict();
  const mediaSendSchema = z
    .object({
      fileId: z.string().min(8).max(120),
      jid: z.string().min(5).max(80),
      caption: z.string().max(300).optional(),
    })
    .strict();

  router.get('/images/status', (req, res) => {
    res.json({ ok: true, ...ctx.images.status() });
  });

  router.post('/images/generate', (req, res) => {
    const parsed = imagesGenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    void ctx.images
      .generate(parsed.data.prompt, parsed.data.size)
      .then((image) => {
        res.status(201).json({ ok: true, image });
      })
      .catch((error: unknown) => {
        const message = describeUnknown(error);
        const status = message.includes('já sendo gerada') ? 409 : 400;
        res.status(status).json({ ok: false, error: message } satisfies Rejection);
      });
  });

  router.get('/images/list', (req, res) => {
    const limit =
      typeof req.query.limit === 'string' && req.query.limit !== ''
        ? Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 200)
        : undefined;
    res.json({ ok: true, images: ctx.images.listImages(limit) });
  });

  router.post('/images/send', (req, res) => {
    const parsed = imagesSendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    void ctx.images
      .send(parsed.data.imageId, parsed.data.jid, parsed.data.caption)
      .then((sent) => {
        res.json({ ok: true, wamid: sent.wamid });
      })
      .catch((error: unknown) => {
        const message = describeUnknown(error);
        // "não encontrad" casa encontrado e encontrada (imagem/clip/arquivo).
        const status = message.includes('não está conectado')
          ? 409
          : message.includes('não encontrad') || message.includes('sumiu do disco')
            ? 404
            : 400;
        res.status(status).json({ ok: false, error: message } satisfies Rejection);
      });
  });

  // Manda do catálogo de mídia (vídeo mp4 do yt-dlp, áudio, imagem) direto
  // pro chat — ETAPA 7. Honestidade: mime governa o dispatch, resto é 400.
  router.post('/media/send', (req, res) => {
    const parsed = mediaSendSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(validationError(parsed.error));
      return;
    }
    const file = ctx.media.engine.getFile(parsed.data.fileId);
    const caption = parsed.data.caption ?? null;
    if (file === null) {
      res.status(404).json({ ok: false, error: 'arquivo não encontrado no catálogo' } satisfies Rejection);
      return;
    }
    const mime = file.mime ?? '';
    const sendPromise =
      mime === 'video/mp4'
        ? ctx.whatsapp.service.sendVideo(parsed.data.jid.trim(), file.filePath, caption)
        : mime.startsWith('image/')
          ? ctx.whatsapp.service.sendImage(parsed.data.jid.trim(), file.filePath, caption)
          : mime.startsWith('audio/')
            ? ctx.whatsapp.service.sendAudio(parsed.data.jid.trim(), file.filePath, caption)
            : null;
    if (sendPromise === null) {
      res
        .status(400)
        .json({
          ok: false,
          error: mime === ''
            ? 'arquivo sem mime conhecido no catálogo — não dá pra mandar honesto'
            : `tipo ${mime} não é mandável (vídeo mp4, áudio e imagem; ${mime} não serve)`,
        } satisfies Rejection);
      return;
    }
    void sendPromise
      .then((wamid) => {
        res.json({ ok: true, wamid });
      })
      .catch((error: unknown) => {
        const message = describeUnknown(error);
        const status = message.includes('não está conectado')
          ? 409
          : message.includes('sumiu do disco')
            ? 404
            : 400;
        res.status(status).json({ ok: false, error: message } satisfies Rejection);
      });
  });

  // ── ETAPA 9: atualizador (GitHub Releases públicos, sem token) ─────────
  // check devolve 200 mesmo com ok:false — o que falhou (rede, repo,
  // canal vazio) vai em `error`/`hint` pra tela, sem estourar 5xx.
  router.get('/updates/status', (_req, res) => {
    res.json(ctx.updates.status());
  });

  router.post('/updates/check', (_req, res) => {
    void ctx.updates.check().then((result) => res.json(result));
  });

  router.post('/updates/stage', (_req, res) => {
    void ctx.updates
      .stage()
      .then((staged) => res.status(201).json({ ok: true, staged }))
      .catch((error: unknown) => {
        res.status(400).json({ ok: false, error: describeUnknown(error) } satisfies Rejection);
      });
  });

  router.post('/updates/discard', (_req, res) => {
    try {
      ctx.updates.discardStaged();
      res.json({ ok: true });
    } catch (error: unknown) {
      res.status(500).json({ ok: false, error: describeUnknown(error) } satisfies Rejection);
    }
  });

  router.post('/updates/prepare', (_req, res) => {
    void ctx.updates
      .prepare()
      .then((made) => res.status(201).json({ ok: true, ...made }))
      .catch((error: unknown) => {
        res.status(400).json({ ok: false, error: describeUnknown(error) } satisfies Rejection);
      });
  });

  // 202 + mensagem: por trás o servidor se despede via updatesOnApply
  // (fecha o processo) e o helper desatachado troca o dist com backup.
  router.post('/updates/apply', (_req, res) => {
    try {
      const started = ctx.updates.apply();
      ctx.updatesOnApply();
      res.status(202).json({ ok: true, message: started.message });
    } catch (error: unknown) {
      res.status(400).json({ ok: false, error: describeUnknown(error) } satisfies Rejection);
    }
  });

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: 'Rota não encontrada' } satisfies Rejection);
  });

  router.use(errorHandler(ctx.log));
  return router;
}
