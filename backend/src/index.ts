import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { LOG_LEVELS, type LogLevel } from './logger/logger.ts';
import { resolveDataDir, resolvePaths, type ResolvedPaths } from './config/paths.ts';
import { ConfigStore } from './config/store.ts';
import { Logger, logFileName } from './logger/logger.ts';
import { Database } from './database/database.ts';
import { runMigrations } from './database/migrations.ts';
import { AuthService, hashPassword, generateTokenSecret } from './security/auth.ts';
import { SettingsService } from './services/settingsService.ts';
import { SystemStatusService } from './services/systemStatus.ts';
import { StatsService } from './services/statsService.ts';
import { scheduleLogRetention } from './logger/retention.ts';
import { createApp } from './httpApp.ts';
import { attachSocketServer } from './ws/socketServer.ts';
import { createPanelBridge, type PanelBridge } from './ws/panelBridge.ts';
import { AIEngine } from './ai/aiEngine.ts';
import { WhatsAppService } from './whatsapp/whatsappService.ts';
import { WhatsAppStore } from './whatsapp/store.ts';
import { TaskRunner } from './media/runner.ts';
import { MediaEngine } from './media/mediaEngine.ts';
import { resolveMediaTools } from './media/tools.ts';
import { MemeEngine } from './media/memeEngine.ts';
import { PolitenessGate, myinstantsFetchPage, searchInstants } from './search/instants.ts';
import { VoiceEngine } from './voice/voiceEngine.ts';
import { ImageEngine } from './images/imageEngine.ts';
import { UpdateEngine } from './updates/updateEngine.ts';
import { githubFetchBytes, githubFetchJson, extractZipBundle } from './updates/netUtils.ts';
import { readVersion } from './utils/version.ts';
import dotenv from 'dotenv';
import type { AppContext } from './types.ts';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

function ensureLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  return value !== undefined && (LOG_LEVELS as string[]).includes(value)
    ? (value as LogLevel)
    : fallback;
}

// ── Diretórios ──────────────────────────────────────────────────────────
const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true });
const paths: ResolvedPaths = resolvePaths(dataDir);
mkdirSync(paths.logDir, { recursive: true });

// ── Config ──────────────────────────────────────────────────────────────
const config = new ConfigStore(paths);
const configData = config.get();

const bootNotice = config.popStartupNotice();
const logger = new Logger({
  level: ensureLogLevel(process.env['GERALDO_LOG_LEVEL'], configData.log.level),
  file: logFileName(paths.logDir),
  console: true,
});
const log = logger.withModule('server');
if (bootNotice) log.warn(bootNotice);
// ETAPA 8: rotação de logs (mantém 7 dias, revisa 1×/hora; timer com unref).
scheduleLogRetention(paths.logDir, logger.withModule('logs'));

// Primeiro boot: cria segredo do token e senha provisória do painel.
let needsSave = false;
if (configData.security.tokenSecret === '') {
  configData.security.tokenSecret = generateTokenSecret();
  needsSave = true;
}
if (configData.security.dashboardPasswordHash === null) {
  configData.security.dashboardPasswordHash = hashPassword('geraldo123');
  needsSave = true;
}
if (needsSave) {
  config.save();
  log.warn('Senha provisória do painel: "geraldo123" — troque em Configurações.');
}

// ── Banco ───────────────────────────────────────────────────────────────
const db = new Database(paths.dbPath);
const migrations = runMigrations(db, { backupsDir: paths.backupsDir, dbPath: paths.dbPath });
if (migrations.applied.length > 0) {
  log.info(`migrações aplicadas: ${migrations.applied.join(', ')}`);
}
if (migrations.backups.length > 0) {
  log.info(`backups gerados: ${migrations.backups.join(', ')}`);
}

// ── Segurança ───────────────────────────────────────────────────────────
const authService = new AuthService({
  tokenSecret: configData.security.tokenSecret,
  passwordHash: configData.security.dashboardPasswordHash,
});

const startedAt = new Date().toISOString();
const version = readVersion();

// ── Settings ────────────────────────────────────────────────────────────
let broadcastFn: () => void = () => undefined;

const settings = new SettingsService(
  db,
  () => configData,
  ({ logLevel, whatsappAutoReconnect, whatsappRespondInPrivate }) => {
    if (logLevel) {
      configData.log.level = logLevel;
      config.save();
      logger.setLevel(logLevel);
      log.info(`nível de log alterado para ${logLevel}`);
    }
    if (whatsappAutoReconnect !== undefined) {
      configData.whatsapp.autoReconnect = whatsappAutoReconnect;
      config.save();
      log.info(
        `reconexão automática do WhatsApp: ${whatsappAutoReconnect ? 'ligada' : 'desligada'}`,
      );
    }
    if (whatsappRespondInPrivate !== undefined) {
      configData.whatsapp.respondInPrivate = whatsappRespondInPrivate;
      config.save();
      log.info(
        `responder conversas privadas: ${whatsappRespondInPrivate ? 'ligado' : 'desligado'}`,
      );
    }
  },
  logger.withModule('settings'),
  () => broadcastFn(),
);

// ── Status do sistema ───────────────────────────────────────────────────
const bridgeRef: { current: PanelBridge | null } = { current: null };
const status = new SystemStatusService({
  version: () => version,
  startedAt: () => startedAt,
  paths: { dataDir: paths.dataDir },
  effectiveAI: () => settings.effectiveAI(),
  taskCounts: () => ({ queued: runner.counts().queued, running: runner.counts().running }),
  // ETAPA 8: estado real (arrow avaliada no request — o serviço ainda
  // não existe nesta linha, e isso é de propósito).
  whatsappInfo: () => {
    const info = whatsappService.info();
    const state =
      info.state === 'connected' || info.state === 'qr' ? info.state : 'disconnected';
    return { state, note: info.note };
  },
});

// ── ETAPA 8: contagens agregadas pro dashboard ──────────────────────────
const stats = new StatsService({
  db,
  effectiveAI: () => settings.effectiveAI(),
  whatsappInfo: () => {
    const info = whatsappService.info();
    const state =
      info.state === 'connected' || info.state === 'qr' ? info.state : 'disconnected';
    return { state, note: info.note };
  },
  taskCounts: () => runner.counts(),
});

// ── WhatsApp (ETAPA 2) + IA (ETAPA 3) + Mídias (ETAPA 4) ────────────────
const whatsappStore = new WhatsAppStore(db);
const aiEngine = new AIEngine({
  getAI: () => settings.effectiveAI(),
  store: whatsappStore,
  log: logger.withModule('ai'),
});
const whatsappService = new WhatsAppService({
  sessionDir: paths.sessionDir,
  store: whatsappStore,
  log: logger.withModule('whatsapp'),
  ai: aiEngine,
  getRespondInPrivate: () => configData.whatsapp.respondInPrivate,
  getAutoReconnect: () => configData.whatsapp.autoReconnect,
  emitStatus: (info) => bridgeRef.current?.emit('whatsapp:status', info),
  emitQr: (qr) => bridgeRef.current?.emit('whatsapp:qr', qr),
});
aiEngine.bindSend((jid, text, options) => whatsappService.sendText(jid, text, options ?? {}));

const runner = new TaskRunner({
  db,
  log: logger.withModule('tasks'),
  concurrency: 1,
  onEvent: (event, data) =>
    bridgeRef.current?.emit(event === 'job:progress' ? 'media:progress' : 'media:done', data),
});
const mediaEngine = new MediaEngine({
  runner,
  log: logger.withModule('media'),
  db,
  paths: { mediaDir: paths.mediaDir },
  resolveTools: ({ force } = {}) => resolveMediaTools({ env: process.env }),
});
mediaEngine.register();
runner.resumePending();
void mediaEngine.toolsStatus({ force: true }).then((tools) => {
  if (tools.ytdlpPath !== null && tools.ffmpegPath !== null) {
    log.info(`ferramentas de mídia: yt-dlp ${String(tools.ytdlpVersion)} · ffmpeg ${String(tools.ffmpegVersion)}`);
  } else {
    log.warn('yt-dlp/ffmpeg não achados — downloads recusados até instalar ("winget install yt-dlp.yt-dlp")');
  }
});

// ── Memes/sons (ETAPA 5) ─────────────────────────────────────────────────
const memeEngine = new MemeEngine({
  db,
  log: logger.withModule('memes'),
  paths: { mediaDir: paths.mediaDir },
  search: (query) => searchInstants(query, myinstantsFetchPage),
  gate: new PolitenessGate(),
  sendAudio: (chatJid, filePath, label) => whatsappService.sendAudio(chatJid, filePath, label),
});
log.info('MemeEngine pronto (MyInstants, raspagem educada com intervalo entre buscas)');

// ── Voz (ETAPA 6) ────────────────────────────────────────────────────────
const voiceEngine = new VoiceEngine({
  db,
  log: logger.withModule('voice'),
  paths: { piperDir: paths.piperDir, voicesDir: paths.voicesDir, mediaDir: paths.mediaDir },
  resolveFfmpeg: async () => {
    const tools = await resolveMediaTools({ env: process.env });
    return tools.ffmpegPath;
  },
  sendVoiceNote: (chatJid, filePath, label) => whatsappService.sendVoiceNote(chatJid, filePath, label),
});
void voiceEngine.status().then((voiceStatus) => {
  if (voiceStatus.ready) {
    log.info(`voz pronta: piper ${String(voiceStatus.piper.version)} · ${String(voiceStatus.voices.length)} voz(es) pt_BR`);
  } else {
    log.warn(`voz indisponível ainda: ${String(voiceStatus.hint)}`);
  }
});

// ── Imagens (ETAPA 7) ────────────────────────────────────────────────────
const imageEngine = new ImageEngine({
  db,
  log: logger.withModule('images'),
  paths: { mediaDir: paths.mediaDir },
  // Mesma fonte do AIEngine: overlay do painel (tabela settings).
  getAI: () => settings.effectiveAI(),
  sendImage: (chatJid, filePath, caption) => whatsappService.sendImage(chatJid, filePath, caption),
});
void Promise.resolve().then(() => {
  const imageStatus = imageEngine.status();
  if (imageStatus.ready) {
    log.info(`imagem pronta: ${imageStatus.provider}/${imageStatus.modelName}`);
    if (imageStatus.costNote !== null) log.info(`custo: ${imageStatus.costNote}`);
  } else {
    log.warn(`geração de imagem inativa: ${String(imageStatus.hint)}`);
  }
});

// ── Atualizador (ETAPA 9) ────────────────────────────────────────────────
// appDir = raiz do CÓDIGO (onde vivem backend/ e frontend/). Tanto roda
// via src (tsx) quanto via dist (node) chegam aqui com dois '..'.
const appDir = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const updatesEngine = new UpdateEngine({
  log: logger.withModule('updates'),
  getUpdates: () => settings.effectiveUpdates(),
  currentVersion: () => version,
  paths: { updatesDir: paths.updatesDir, appDir },
  fetchJson: githubFetchJson,
  fetchBytes: githubFetchBytes,
  extractZip: extractZipBundle,
  onEvent: (event, data) => bridgeRef.current?.emit(event, data),
});
updatesEngine.startAutoCheck();

// ── Contexto compartilhado ──────────────────────────────────────────────
const ctx: AppContext = {
  logger,
  log: logger.withModule('api'),
  config,
  db,
  authService,
  settings,
  status,
  stats,
  paths,
  whatsapp: {
    service: whatsappService,
    store: whatsappStore,
    bridge: {
      emit: (event: string, data: unknown) => bridgeRef.current?.emit(event, data),
    },
  },
  ai: aiEngine,
  media: {
    runner,
    engine: mediaEngine,
    bridge: {
      emit: (event: string, data: unknown) => bridgeRef.current?.emit(event, data),
    },
  },
  memes: memeEngine,
  voice: voiceEngine,
  images: imageEngine,
  updates: updatesEngine,
  updatesOnApply: () => {
    // 202 já dado; dá 1,5 s pro flush e encerra. Quem reabre é Lucas
    // com o START.bat — o helper desatachado (apply-update.cmd) cuida
    // do backup e da troca do dist nesse meio tempo.
    setTimeout(() => {
      log.warn('encerrando o Geraldo pra aplicar a atualização — reabra com START.bat');
      process.exit(0);
    }, 1500);
  },
  broadcastSettings: () => broadcastFn(),
  securityHooks: {
    changePassword(newPassword: string) {
      // ETAPA 8: roda o segredo do token junto da senha — todo token
      // emitido antes morre na hora (nada de sessão fantasma por 12h).
      const tokenSecret = generateTokenSecret();
      const passwordHash = hashPassword(newPassword);
      configData.security.dashboardPasswordHash = passwordHash;
      configData.security.tokenSecret = tokenSecret;
      config.save();
      authService.updateSecrets({ tokenSecret, passwordHash });
      log.info('senha do painel alterada');
      return { tokenSecret, passwordHash };
    },
    currentSecrets() {
      return {
        tokenSecret: configData.security.tokenSecret,
        passwordHash: configData.security.dashboardPasswordHash,
      };
    },
  },
};
broadcastFn = (): void => {
  socket.io.emit('settings', settings.getPublic());
};

// ── HTTP + Socket.IO ────────────────────────────────────────────────────
const app = createApp(ctx);
const httpServer = createServer(app);
const socket = attachSocketServer(httpServer, ctx);
const whatsappBridge = createPanelBridge(socket.io);
bridgeRef.current = whatsappBridge;
whatsappService.maybeAutoConnect();

const { host, port } = configData.server;
httpServer.listen(port, host, () => {
  log.info(`Geraldo AI v${version} pronto`);
  log.info(`  painel (dev): http://localhost:3000  |  api: http://${host}:${port}/api/health`);
  log.info(`  dados: ${paths.dataDir}`);
});

// ── Graceful shutdown ───────────────────────────────────────────────────
let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn(`encerramento via ${signal}...`);
  try {
    void whatsappService.disconnect();
  } catch {
    /* conforme: já desconectada */
  }
  try {
    socket.shutdown();
    httpServer.close(() => {
      void logger.close().then(() => {
        db.close();
        log.info('encerrado com sucesso!');
        process.exit(0);
      });
    });
    // Conexões persistentes penduradas: força saída em 5 s.
    setTimeout(() => {
      log.warn('encerramento forçado — conexões persistentes');
      void logger.close();
      db.close();
      process.exit(1);
    }, 5000).unref();
  } catch (error) {
    log.error(`erro no encerramento: ${error instanceof Error ? error.message : String(error)}`);
    try {
      void logger.close();
      db.close();
    } catch {
      /* nada mais a fazer */
    }
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  log.error(`uncaughtException: ${error.stack ?? error.message}`);
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  log.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  shutdown('unhandledRejection');
});
