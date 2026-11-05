import { existsSync, rmSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type AnyMessageContent,
  type MiscMessageGenerationOptions,
  type WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { classifyDisconnect, backoffDelayMs } from './connectionPolicy.ts';
import { decideResponse, parseWhatsAppMessage } from './extract.ts';
import { WhatsAppStore } from './store.ts';
import { mimeForExtension } from '../media/progress.ts';
import type { AIEngine } from '../ai/aiEngine.ts';
import type { WhatsAppInfo, WhatsAppMessageContext, WhatsAppState } from './types.ts';
import type { ChildLogger } from '../logger/logger.ts';

const baileysLogger = pino({ level: 'silent' });

export interface WhatsAppServiceDeps {
  sessionDir: string;
  store: WhatsAppStore;
  log: ChildLogger;
  ai?: AIEngine | null;
  getRespondInPrivate(): boolean;
  getAutoReconnect(): boolean;
  emitStatus(info: WhatsAppInfo): void;
  emitQr(qr: { dataUrl: string; updatedAt: string }): void;
}

const INTRO_PRIVATE =
  'Oxente, cabra da peste! Cheguei no chat! Sou o Geraldo — por enquanto tô só ' +
  'de olho e anotando o round; minha inteligência completa chega na próxima ' +
  'atualização. Fica esperto, visse!';

interface ConnectionUpdateLike {
  connection?: string;
  qr?: string;
  lastDisconnect?: { error?: unknown };
}

/**
 * Serviço WhatsApp (ETAPA 2): QR, sessão persistida, reconexão com backoff,
 * recepção e envio de mensagens, detecção de menções/respostas ao Geraldo.
 * Não expõe conteúdo do WhatsApp para comandos de sistema; tudo depois é
 * roteado por JSON seguro.
 */
export class WhatsAppService {
  private sock: WASocket | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private starting = false;
  private suppressReconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private greetedChats = new Set<string>();
  private groupTitlePending = new Set<string>();

  private state: WhatsAppState = 'off';
  private phone: string | null = null;
  private note = 'desconectado';
  private qr: { dataUrl: string; updatedAt: string } | null = null;

  constructor(
    private readonly deps: WhatsAppServiceDeps,
  ) {}

  info(): WhatsAppInfo {
    return { state: this.state, phone: this.phone, note: this.note, qr: this.qr };
  }

  hasSession(): boolean {
    return existsSync(join(this.deps.sessionDir, 'creds.json'));
  }

  /** Inicia/renova a conexão. Seguro contra chamadas duplas. */
  async start(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting' || this.state === 'qr') {
      this.deps.log.warn('sessão WhatsApp já em andamento — ignoro segunda chamada');
      return;
    }
    if (this.starting) return;
    this.starting = true;

    try {
      this.clearReconnectTimer();
      this.suppressReconnect = false;
      this.phone = null;
      this.qr = null;
      this.setState('connecting', 'iniciando conexão com o WhatsApp...');

      const { state, saveCreds } = await useMultiFileAuthState(this.deps.sessionDir);
      this.saveCreds = saveCreds;

      let version: [number, number, number] | undefined;
      try {
        version = (await fetchLatestBaileysVersion()).version;
      } catch {
        // Sem internet pra checar versão: segue com a versão embutida.
      }

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        logger: baileysLogger,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        browser: Browsers.ubuntu('Geraldo AI'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
      });

      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (update) => {
        void this.handleConnectionUpdate(update as unknown as ConnectionUpdateLike);
      });
      sock.ev.on('messages.upsert', (upsert) => {
        const raw = upsert as unknown as { messages?: unknown[]; type?: string };
        void this.handleUpsert(raw.messages ?? [], raw.type ?? 'notify');
      });
      this.sock = sock;
    } catch (error) {
      this.starting = false;
      this.sock = null;
      this.setState('disconnected', 'falhou ao iniciar o módulo WhatsApp');
      this.deps.log.error(`falha ao iniciar WhatsApp: ${describe(error)}`);
      this.scheduleReconnect();
    }
  }

  private async handleConnectionUpdate(update: ConnectionUpdateLike): Promise<void> {
    if (typeof update.qr === 'string' && update.qr !== '') {
      try {
        const dataUrl = await QRCode.toDataURL(update.qr, { margin: 1, width: 520 });
        this.qr = { dataUrl, updatedAt: new Date().toISOString() };
        this.setState('qr', 'novo QR gerado — escaneia no WhatsApp do celular');
        this.deps.emitQr(this.qr);
      } catch {
        this.deps.log.warn('não consegui renderizar o QR como imagem');
      }
      return;
    }

    switch (update.connection) {
      case 'connecting':
        if (this.state !== 'qr') this.setState('connecting', 'conectando...');
        return;
      case 'open': {
        this.starting = false;
        this.reconnectAttempts = 0;
        this.qr = null;
        const user = this.sock?.user;
        const id = typeof user?.id === 'string' ? user.id : null;
        this.phone = id !== null ? (jidNormalizedUser(id).split('@')[0] ?? null) : null;
        this.setState('connected', 'conectado ao WhatsApp');
        return;
      }
      case 'close':
        this.handleClose(update.lastDisconnect?.error);
        return;
      default:
        return;
    }
  }

  private handleClose(error: unknown): void {
    this.starting = false;
    const code = statusCodeFrom(error);
    const action = typeof code === 'number'
      ? classifyDisconnect(code)
      : 'reconnect';

    try { this.sock?.end(undefined); } catch { /* socket já fechou */ }
    this.sock = null;

    if (action === 'logout') {
      this.suppressReconnect = true;
      this.clearReconnectTimer();
      this.setState('logged_out', 'sessão deslogada — escaneie o QR de novo');
      return;
    }
    if (action === 'replaced') {
      this.suppressReconnect = true;
      this.setState('disconnected', 'outra sessão assumiu (device em uso em outro lugar)');
      return;
    }
    if (code === DisconnectReason.restartRequired) {
      this.deps.log.info('close pós-scan (restartRequired) — sigo reconectando');
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.suppressReconnect || !this.deps.getAutoReconnect()) {
      this.setState('disconnected', 'desconectado');
      return;
    }
    const delay = backoffDelayMs(this.reconnectAttempts);
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 6);
    this.setState('connecting', `reconectando em ${Math.round(delay / 1000)} s...`);
    this.clearReconnectTimer();
    const timer = globalThis.setTimeout(() => {
      this.reconnectTimer = null;
      void this.start();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.reconnectTimer = timer as NodeJS.Timeout;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Desconecta mantendo a sessão salva (o reconecta com QR depois). */
  async disconnect(): Promise<void> {
    this.suppressReconnect = true;
    this.clearReconnectTimer();
    try { this.sock?.end(undefined); } catch { /* fecha já fechado */ }
    this.sock = null;
    this.setState('disconnected', 'desconectado pelo painel');
  }

  /** Desconecta E apaga a sessão do disco (sai da conta). */
  async destroySession(): Promise<void> {
    await this.disconnect();
    this.greetedChats.clear();
    try {
      rmSync(this.deps.sessionDir, { recursive: true, force: true });
    } catch (error) {
      this.deps.log.warn(`ao apagar cookie secreto: ${describe(error)}`);
    }
    this.state = 'logged_out';
    this.note = 'sessão apagada — precisa escanear o QR de novo';
    this.emitStatus();
  }

  /** Reconecta automaticamente no boot caso exista sessão salva. */
  maybeAutoConnect(): void {
    if (!this.hasSession()) return;
    void this.start();
  }

  async sendText(
    chatJid: string,
    text: string,
    options: { quoted?: unknown } = {},
  ): Promise<void> {
    const sock = this.sock;
    if (sock === null || this.state !== 'connected') {
      throw new Error('WhatsApp não está conectado');
    }
    const content: AnyMessageContent = { text };
    const sendOptions =
      options.quoted !== undefined
        ? ({ quoted: options.quoted } as MiscMessageGenerationOptions)
        : undefined;
    const sent = await sock.sendMessage(chatJid, content, sendOptions);
    const wamid =
      sent !== undefined && sent.key !== undefined && typeof sent.key.id === 'string'
        ? sent.key.id
        : `local-${Date.now()}`;
    const context: WhatsAppMessageContext = {
      chatJid,
      chatType: isJidGroup(chatJid) ? 'group' : 'private',
      senderJid: typeof sock.user?.id === 'string' ? jidNormalizedUser(sock.user.id) : 'geraldo',
      senderName: 'Geraldo',
      wamid,
      kind: 'text',
      body: text,
      timestampISO: new Date().toISOString(),
      mentionsMe: false,
      isReplyToMe: false,
      fromMe: true,
    };
    this.deps.store.saveMessage(context, 'out');
  }

  /**
   * Manda áudio (mp3/ogg) DE UM ARQUIVO local — ETAPA 5 (sons). Erro honesto
   * se desconectado ("WhatsApp não está conectado") — as rotas mapeiam p/ 409.
   */
  async sendAudio(chatJid: string, audioPath: string, label: string | null = null): Promise<string> {
    const sock = this.sock;
    if (sock === null || this.state !== 'connected') {
      throw new Error('WhatsApp não está conectado');
    }
    if (!existsSync(audioPath)) {
      throw new Error('arquivo de áudio sumiu do disco antes do envio');
    }
    const mime = mimeForExtension(extname(audioPath).replace(/^\./, '')) ?? 'audio/mpeg';
    const audio = await readFile(audioPath);
    const sent = await sock.sendMessage(chatJid, { audio, mimetype: mime, ptt: false });
    const wamid =
      sent !== undefined && sent.key !== undefined && typeof sent.key.id === 'string'
        ? sent.key.id
        : `local-${Date.now()}`;
    this.deps.store.saveMessage(
      {
        chatJid,
        chatType: isJidGroup(chatJid) ? 'group' : 'private',
        senderJid: typeof sock.user?.id === 'string' ? jidNormalizedUser(sock.user.id) : 'geraldo',
        senderName: 'Geraldo',
        wamid,
        kind: 'audio',
        body: label,
        timestampISO: new Date().toISOString(),
        mentionsMe: false,
        isReplyToMe: false,
        fromMe: true,
      },
      'out',
    );
    this.deps.log.info(
      `[chat] áudio ${basename(audioPath)} (${String(statSync(audioPath).size)} bytes) mandado p/ ${chatJid}`,
    );
    return wamid;
  }

  /**
   * Manda NOTA DE VOZ (ptt — o balãozinho de "áudio segurando botão" do
   * WhatsApp) a partir de um OGG/Opus no disco — ETAPA 6. Erro honesto
   * se desconectado.
   */
  async sendVoiceNote(chatJid: string, audioPath: string, label: string | null = null): Promise<string> {
    const sock = this.sock;
    if (sock === null || this.state !== 'connected') {
      throw new Error('WhatsApp não está conectado');
    }
    if (!existsSync(audioPath)) {
      throw new Error('a nota de voz sumiu do disco antes do envio');
    }
    const audio = await readFile(audioPath);
    const sent = await sock.sendMessage(chatJid, {
      audio,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true,
    });
    const wamid =
      sent !== undefined && sent.key !== undefined && typeof sent.key.id === 'string'
        ? sent.key.id
        : `local-${Date.now()}`;
    this.deps.store.saveMessage(
      {
        chatJid,
        chatType: isJidGroup(chatJid) ? 'group' : 'private',
        senderJid: typeof sock.user?.id === 'string' ? jidNormalizedUser(sock.user.id) : 'geraldo',
        senderName: 'Geraldo',
        wamid,
        kind: 'audio',
        body: label,
        timestampISO: new Date().toISOString(),
        mentionsMe: false,
        isReplyToMe: false,
        fromMe: true,
      },
      'out',
    );
    this.deps.log.info(`[chat] nota de voz ${basename(audioPath)} mandada p/ ${chatJid}`);
    return wamid;
  }

  /**
   * Manda IMAGEM (png/jpeg/webp) com legenda opcional — ETAPA 7 (imagens
   * geradas / catálogo de mídia). Erro honesto se desconectado ou se o
   * a extensão não for imagem mandável.
   */
  async sendImage(chatJid: string, imagePath: string, caption: string | null = null): Promise<string> {
    const sock = this.sock;
    if (sock === null || this.state !== 'connected') {
      throw new Error('WhatsApp não está conectado');
    }
    if (!existsSync(imagePath)) {
      throw new Error('a imagem sumiu do disco antes do envio');
    }
    const mime = mimeForExtension(extname(imagePath).replace(/^\./, ''));
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') {
      throw new Error(`imagem tem que ser PNG/JPEG/WebP (${String(extname(imagePath))} não serve)`);
    }
    const image = await readFile(imagePath);
    const content: AnyMessageContent = { image, mimetype: mime };
    if (caption !== null && caption.trim() !== '') content.caption = caption.trim();
    const sent = await sock.sendMessage(chatJid, content);
    const wamid =
      sent !== undefined && sent.key !== undefined && typeof sent.key.id === 'string'
        ? sent.key.id
        : `local-${Date.now()}`;
    this.deps.store.saveMessage(
      {
        chatJid,
        chatType: isJidGroup(chatJid) ? 'group' : 'private',
        senderJid: typeof sock.user?.id === 'string' ? jidNormalizedUser(sock.user.id) : 'geraldo',
        senderName: 'Geraldo',
        wamid,
        kind: 'image',
        body: caption !== null && caption.trim() !== '' ? caption.trim() : null,
        timestampISO: new Date().toISOString(),
        mentionsMe: false,
        isReplyToMe: false,
        fromMe: true,
      },
      'out',
    );
    this.deps.log.info(`[chat] imagem ${basename(imagePath)} mandada p/ ${chatJid}`);
    return wamid;
  }

  /**
   * Manda VÍDEO mp4 com legenda opcional — ETAPA 7 (catálogo de mídia/
   * downloads do yt-dlp). Honestidade: só mp4 é aceito (o Geraldo remuxa
   * o download do yt-dlp pra mp4; outro container tem que converter).
   */
  async sendVideo(chatJid: string, videoPath: string, caption: string | null = null): Promise<string> {
    const sock = this.sock;
    if (sock === null || this.state !== 'connected') {
      throw new Error('WhatsApp não está conectado');
    }
    if (!existsSync(videoPath)) {
      throw new Error('o vídeo sumiu do disco antes do envio');
    }
    if (extname(videoPath).toLowerCase() !== '.mp4') {
      throw new Error('vídeo tem que ser mp4 (o Geraldo baixa do yt-dlp remuxado em mp4; converta antes)');
    }
    const video = await readFile(videoPath);
    const content: AnyMessageContent = { video, mimetype: 'video/mp4' };
    if (caption !== null && caption.trim() !== '') content.caption = caption.trim();
    const sent = await sock.sendMessage(chatJid, content);
    const wamid =
      sent !== undefined && sent.key !== undefined && typeof sent.key.id === 'string'
        ? sent.key.id
        : `local-${Date.now()}`;
    this.deps.store.saveMessage(
      {
        chatJid,
        chatType: isJidGroup(chatJid) ? 'group' : 'private',
        senderJid: typeof sock.user?.id === 'string' ? jidNormalizedUser(sock.user.id) : 'geraldo',
        senderName: 'Geraldo',
        wamid,
        kind: 'video',
        body: caption !== null && caption.trim() !== '' ? caption.trim() : null,
        timestampISO: new Date().toISOString(),
        mentionsMe: false,
        isReplyToMe: false,
        fromMe: true,
      },
      'out',
    );
    this.deps.log.info(`[chat] vídeo ${basename(videoPath)} (${String(statSync(videoPath).size)} bytes) mandado p/ ${chatJid}`);
    return wamid;
  }

  /** Pipeline de entrada (ETAPA 2): extrai, persiste e decide resposta mínima. */
  private async handleUpsert(messages: unknown[], type: string): Promise<void> {
    if (type !== 'notify') return; // 'append' = sync de histórico antigo — ignorado
    const me = this.meJid();

    for (const message of messages) {
      const parsed = parseWhatsAppMessage(message, me);
      if (parsed === null) continue;
      if (parsed.fromMe) continue;

      const context: WhatsAppMessageContext = {
        chatJid: parsed.chatJid,
        chatType: parsed.chatType,
        senderJid: parsed.senderJid,
        senderName: parsed.senderName,
        wamid: parsed.wamid,
        kind: parsed.kind,
        body: parsed.body,
        timestampISO: parsed.timestampISO,
        mentionsMe: parsed.mentionsMe,
        isReplyToMe: parsed.isReplyToMe,
        fromMe: false,
      };

      const fresh = this.deps.store.saveMessage(context, 'in');
      if (!fresh) continue;

      this.refreshGroupTitle(context.chatJid, context.chatType);
      this.deps.log.info(
        `[chat] mensagem nova de ${context.senderName} (${context.kind}, ${context.chatType})`,
      );
      this.deps.log.debug(`[chat] texto: ${short(context)}`);

      const shouldRespond = decideResponse({
        isGroup: context.chatType === 'group',
        mentionsMe: context.mentionsMe,
        isReplyToMe: context.isReplyToMe,
        respondInPrivate: this.deps.getRespondInPrivate(),
      });
      if (!shouldRespond) continue;

      // ETAPA 3: IA configurada → generateReply (grupos incluídos).
      // IA desligada → comportamento da ETAPA 2 (saudação fixa no privado).
      const ai = this.deps.ai;
      if (ai !== undefined && ai !== null) {
        await ai.respond(context, message);
      } else if (context.chatType === 'private') {
        await this.greetOncePrivate(context.chatJid);
      }
    }
  }

  private async greetOncePrivate(chatJid: string): Promise<void> {
    if (this.greetedChats.has(chatJid)) return;
    this.greetedChats.add(chatJid);
    try {
      await this.sendText(chatJid, INTRO_PRIVATE);
    } catch (error) {
      this.deps.log.warn(`não consegui responder no privado: ${describe(error)}`);
    }
  }

  private refreshGroupTitle(chatJid: string, chatType: WhatsAppMessageContext['chatType']): void {
    if (chatType !== 'group' || this.groupTitlePending.has(chatJid)) return;
    const sock = this.sock;
    if (sock === null) return;
    this.groupTitlePending.add(chatJid);
    void sock
      .groupMetadata(chatJid)
      .then((meta: { subject?: string }) => {
        if (typeof meta.subject === 'string' && meta.subject !== '') {
          this.deps.store.ensureConversation({ jid: chatJid, type: 'group', title: meta.subject });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.groupTitlePending.delete(chatJid);
      });
  }

  private meJid(): string | null {
    const id = this.sock?.user?.id;
    return typeof id === 'string' ? jidNormalizedUser(id) : null;
  }

  private setState(state: WhatsAppState, note: string): void {
    this.state = state;
    this.note = note;
    this.deps.log.info(`WhatsApp → ${state} (${note})`);
    this.emitStatus();
  }

  private emitStatus(): void {
    this.deps.emitStatus(this.info());
  }
}

function statusCodeFrom(error: unknown): number | undefined {
  if (error === null || error === undefined) return undefined;
  if (error instanceof Boom) {
    const status = error.output?.statusCode;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function short(message: WhatsAppMessageContext): string {
  const preview = message.body ?? `(${message.kind})`;
  return preview.length > 60 ? `${preview.slice(0, 60)}…` : preview;
}
