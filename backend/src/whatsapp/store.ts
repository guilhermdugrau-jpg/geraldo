import type { Database } from '../database/database.ts';
import type {
  ChatSummary,
  StoredChatMessage,
  WhatsAppChatType,
  WhatsAppMessageContext,
} from './types.ts';

const CHAT_LIST_LIMIT = 100;
const MAX_MESSAGE_FETCH = 200;
const NAME_MAX = 80;

export interface UpsertConversationInput {
  jid: string;
  type: WhatsAppChatType;
  title?: string | null;
}

/**
 * Persistência de conversas/mensagens do WhatsApp. Who row's created lazily;
 * idempotente por wamid (não guarda mensagem duplicada em reentregas).
 */
export class WhatsAppStore {
  constructor(private readonly db: Database) {}

  ensureConversation(input: UpsertConversationInput): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO conversations (jid, type, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(jid) DO UPDATE SET
           title = COALESCE(excluded.title, conversations.title),
           updated_at = excluded.updated_at`,
      )
      .run(input.jid, input.type, input.title ?? null, now, now);
  }

  setMemoryEnabled(jid: string, enabled: boolean): boolean {
    const result = this.db
      .prepare(
        `UPDATE conversations SET memory_enabled = ?, updated_at = ? WHERE jid = ?`,
      )
      .run(enabled ? 1 : 0, new Date().toISOString(), jid);
    return Number(result.changes) > 0;
  }

  isMemoryEnabled(jid: string): boolean {
    const row = this.db
      .prepare('SELECT memory_enabled AS memoryEnabled FROM conversations WHERE jid = ?')
      .get(jid) as { memoryEnabled: number } | undefined;
    return row === undefined ? false : row.memoryEnabled === 1;
  }

  /** false quando a mensagem já foi registrada (wamid duplicado). */
  saveMessage(context: WhatsAppMessageContext, direction: 'in' | 'out'): boolean {
    this.ensureConversation({
      jid: context.chatJid,
      type: context.chatType,
      title: null,
    });
    try {
      this.db
        .prepare(
          `INSERT INTO messages
             (chat, sender, sender_name, direction, kind, body, created_at, wamid)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          context.chatJid,
          context.senderJid.slice(0, NAME_MAX),
          context.senderName.slice(0, NAME_MAX),
          direction,
          context.kind,
          context.body,
          context.timestampISO,
          context.wamid,
        );
      return true;
    } catch (error) {
      const errcode = (error as { errcode?: number }).errcode;
      const message = error instanceof Error ? error.message : String(error);
      if (errcode === 2067 || message.includes('UNIQUE')) return false; // reentrega
      throw error;
    }
  }

  listChats(options: { search?: string; limit?: number } = {}): ChatSummary[] {
    const limit = Math.min(Math.max(options.limit ?? CHAT_LIST_LIMIT, 1), 200);
    const search = options.search?.trim() ?? '';
    const rows = this.db
      .prepare(
        `SELECT
           c.jid AS jid,
           c.type AS type,
           c.title AS title,
           c.memory_enabled AS memory_enabled,
           (SELECT body FROM messages m WHERE m.chat = c.jid ORDER BY m.id DESC LIMIT 1) AS last_body,
           (SELECT created_at FROM messages m WHERE m.chat = c.jid ORDER BY m.id DESC LIMIT 1) AS last_at
         FROM conversations c
         WHERE (
           ? = ''
           OR c.jid LIKE '%' || ?1 || '%'
           OR c.title LIKE '%' || ?1 || '%'
           OR (SELECT body FROM messages m WHERE m.chat = c.jid ORDER BY m.id DESC LIMIT 1)
                LIKE '%' || ?1 || '%'
         )
         ORDER BY COALESCE(last_at, c.created_at) DESC, c.jid ASC
         LIMIT ?`,
      )
      .all(search, limit) as Array<{
      jid: string;
      type: string;
      title: string | null;
      memory_enabled: number;
      last_body: string | null;
      last_at: string | null;
    }>;

    return rows.map((row) => ({
      jid: row.jid,
      type: row.type === 'group' ? 'group' : 'private',
      title: row.title,
      memoryEnabled: row.memory_enabled === 1,
      lastBody: row.last_body,
      lastAt: row.last_at,
    }));
  }

  listMessages(chatJid: string, limit = 80): StoredChatMessage[] {
    const bounded = Math.min(Math.max(limit, 1), MAX_MESSAGE_FETCH);
    const rows = this.db
      .prepare(
        `SELECT id, chat, sender, sender_name, direction, kind, body, created_at
         FROM messages WHERE chat = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(chatJid, bounded) as Array<{
      id: number;
      chat: string;
      sender: string;
      sender_name: string | null;
      direction: string;
      kind: string;
      body: string | null;
      created_at: string;
    }>;
    return rows
      .map((row) => ({
        id: row.id,
        chat: row.chat,
        sender: row.sender,
        senderName: row.sender_name,
        direction: row.direction === 'out' ? ('out' as const) : ('in' as const),
        kind: row.kind,
        body: row.body,
        createdAt: row.created_at,
      }))
      .reverse(); // ordem cronológica para o painel
  }
}
