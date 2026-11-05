import type { WhatsAppChatType, WhatsAppMessageContext, WhatsAppMessageKind } from './types.ts';

const MAX_BODY_CHARS = 4000;
const GERALDO_TAG = '@geraldo';

/* ── utilitários seguros sobre proto desconhecidos ────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Baileys usa números ou Long ({low, high}) nas timestamps. */
export function timestampToISO(value: unknown): string {
  const seconds =
    typeof value === 'number'
      ? value
      : isRecord(value) && typeof value['low'] === 'number'
        ? value['low']
        : 0;
  return new Date(seconds * 1000).toISOString();
}

/** Normaliza um Jid: remove o sufixo de dispositivo (@xxx:NN). */
export function normalizeJid(jid: string): string {
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at);
  const domain = jid.slice(at + 1);
  return `${user.split(':')[0] ?? user}@${domain.split(':')[0] ?? domain}`;
}

function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

const KIND_BY_KEY: Record<string, WhatsAppMessageKind> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  audioMessage: 'audio',
  videoMessage: 'video',
  documentMessage: 'document',
  stickerMessage: 'sticker',
};

export interface ParsedWhatsAppMessage {
  wamid: string;
  chatJid: string;
  chatType: WhatsAppChatType;
  senderJid: string;
  senderName: string;
  kind: WhatsAppMessageKind;
  body: string | null;
  timestampISO: string;
  fromMe: boolean;
  mentionsMe: boolean;
  isReplyToMe: boolean;
}

/**
 * Extrai os campos úteis de um WAMessage cru do Baileys. Retorna null para
 * mensagens sem conteúdo de texto/mídia (sistema, reações, protocolo etc.).
 * Puro e testável — não contata nada.
 */
export function parseWhatsAppMessage(raw: unknown, meJid: string | null): ParsedWhatsAppMessage | null {
  if (!isRecord(raw)) return null;

  const key = raw['key'];
  if (!isRecord(key)) return null;

  const wamid = str(key['id']);
  const chatJidRaw = str(key['remoteJid']);
  if (wamid === null || chatJidRaw === null) return null;

  const fromMe = key['fromMe'] === true;
  const chatJid = chatJidRaw;
  const chatType: WhatsAppChatType = isGroupJid(chatJid) ? 'group' : 'private';

  // Em grupos, o autor é key.participant; no privado, o próprio chat.
  const senderRaw = chatType === 'group' ? str(key['participant']) : chatJidRaw;
  if (chatType === 'group' && senderRaw === null) return null;
  const senderJid = normalizeJid(senderRaw ?? chatJidRaw);

  const pushName = str(raw['pushName']);
  const senderName = pushName ?? senderJid.split('@')[0] ?? senderJid;

  const message = raw['message'];
  if (!isRecord(message)) return null; // protocol/reaction/sem body

  let kind: WhatsAppMessageKind = 'other';
  let body: string | null = null;
  let mentionsMe = false;
  let isReplyToMe = false;

  const contentKeys = Object.keys(message);
  for (const contentKey of contentKeys) {
    const kindCandidate = KIND_BY_KEY[contentKey];
    if (kindCandidate === undefined) continue;
    kind = kindCandidate;
    const content = message[contentKey];

    if (kind === 'text') {
      if (contentKey === 'conversation') {
        body = str(content);
      } else if (contentKey === 'extendedTextMessage' && isRecord(content)) {
        const text = str(content['text']);
        if (text !== null) body = text;
      }
    } else {
      // Mídias: guarda legenda como corpo (quando existir).
      body = isRecord(content) ? str(content['caption']) : null;
    }
    break;
  }

  if (kind === 'other') return null;

  // Contexto de citação/mencão
  for (const contentKey of contentKeys) {
    const content = message[contentKey];
    if (!isRecord(content)) continue;
    const contextInfo = content['contextInfo'];
    if (!isRecord(contextInfo)) continue;

    const mentionedJids = asArray(contextInfo['mentionedJid'])
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeJid);
    const quotedParticipant = str(contextInfo['participant']);
    if (quotedParticipant !== null) {
      isReplyToMe =
        meJid !== null &&
        normalizeJid(quotedParticipant) === normalizeJid(meJid);
    }
    if (meJid !== null && mentionedJids.includes(normalizeJid(meJid))) {
      mentionsMe = true;
    }
  }

  // Menção textual '@geraldo' também conta (usuários taguiam sem Jid real).
  if (!mentionsMe && meJid !== null) {
    const plain = body ?? str(raw['conversation']);
    if (plain !== null && plain.toLowerCase().includes(GERALDO_TAG)) {
      mentionsMe = true;
    }
  }

  return {
    wamid,
    chatJid,
    chatType,
    senderJid,
    senderName,
    kind,
    body: body === null ? null : body.slice(0, MAX_BODY_CHARS),
    timestampISO: timestampToISO(raw['messageTimestamp']),
    fromMe,
    mentionsMe,
    isReplyToMe,
  };
}

export type { WhatsAppMessageContext };

export interface ResponseDecision {
  isGroup: boolean;
  mentionsMe: boolean;
  isReplyToMe: boolean;
  respondInPrivate: boolean;
}

/**
 * Regra de resposta da ETAPA 2 (antes da IA):
 * - grupo: só se for menção @geraldo ou resposta a mensagem do Geraldo;
 * - privado: conforme configuração.
 */
export function decideResponse(options: ResponseDecision): boolean {
  if (options.isGroup) return options.mentionsMe || options.isReplyToMe;
  return options.respondInPrivate;
}
