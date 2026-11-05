export type WhatsAppState =
  | 'off'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

export type WhatsAppChatType = 'private' | 'group';

export type WhatsAppMessageKind =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'other';

/** Mensagem normalizada extraída do Baileys (sem dependência de tipos dele). */
export interface WhatsAppMessageContext {
  chatJid: string;
  chatType: WhatsAppChatType;
  senderJid: string;
  senderName: string;
  wamid: string;
  kind: WhatsAppMessageKind;
  body: string | null;
  timestampISO: string;
  mentionsMe: boolean;
  isReplyToMe: boolean;
  fromMe: boolean;
}

export interface WhatsAppInfo {
  state: WhatsAppState;
  /** número (user) do dono da sessão, quando conectado */
  phone: string | null;
  note: string;
  qr: { dataUrl: string; updatedAt: string } | null;
}

export interface ChatSummary {
  jid: string;
  type: WhatsAppChatType;
  title: string | null;
  memoryEnabled: boolean;
  lastBody: string | null;
  lastAt: string | null;
}

export interface StoredChatMessage {
  id: number;
  chat: string;
  sender: string;
  senderName: string | null;
  direction: 'in' | 'out';
  kind: string;
  body: string | null;
  createdAt: string;
}

import type { WhatsAppService } from './whatsappService.ts';
import type { WhatsAppStore } from './store.ts';
import type { PanelBridge } from '../ws/panelBridge.ts';

/** Blocos da ETAPA 2 montados no boot e expostos via AppContext. */
export interface WhatsAppRuntime {
  service: WhatsAppService;
  store: WhatsAppStore;
  bridge: PanelBridge;
}
