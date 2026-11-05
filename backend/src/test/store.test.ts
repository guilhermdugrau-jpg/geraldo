import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Database } from '../database/database.ts';
import { runMigrations } from '../database/migrations.ts';
import { WhatsAppStore } from '../whatsapp/store.ts';
import type { WhatsAppMessageContext } from '../whatsapp/types.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'geraldo-store-'));
const db = new Database(join(dataDir, 'geraldo.db'));
runMigrations(db, { backupsDir: dataDir, dbPath: join(dataDir, 'geraldo.db') });
const store = new WhatsAppStore(db);

function contextFor(jid: string, overrides: Partial<WhatsAppMessageContext> = {}): WhatsAppMessageContext {
  return {
    chatJid: jid,
    chatType: jid.endsWith('@g.us') ? 'group' : 'private',
    senderJid: jid,
    senderName: 'Pessoa de teste',
    wamid: 'W-1',
    kind: 'text',
    body: null,
    timestampISO: new Date().toISOString(),
    mentionsMe: false,
    isReplyToMe: false,
    fromMe: false,
    ...overrides,
  };
}

after(() => {
  db.close();
});

describe('whatsapp store — persistência idempotente', () => {
  it('saveMessage guarda e reentrega com o mesmo wamid não duplica', () => {
    const first = store.saveMessage(
      contextFor('5511900000000@s.whatsapp.net', { wamid: 'DUP-1', body: 'e aí' }),
      'in',
    );
    assert.equal(first, true);

    const duplicate = store.saveMessage(
      contextFor('5511900000000@s.whatsapp.net', { wamid: 'DUP-1', body: 'e aí' }),
      'in',
    );
    assert.equal(duplicate, false);

    const messages = store.listMessages('5511900000000@s.whatsapp.net');
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.body, 'e aí');
  });

  it('ensureConversation cria e atualiza título sem duplicar linha', () => {
    const jid = 'grupo-teste@g.us';
    store.ensureConversation({ jid, type: 'group', title: null });
    store.ensureConversation({ jid, type: 'group', title: 'O Round' });

    const chats = store.listChats();
    const found = chats.filter((c) => c.jid === jid);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.title, 'O Round');
    assert.equal(found[0]?.type, 'group');
  });

  it('ensureConversation com title null preserva título anterior', () => {
    const jid = 'titulo-preservado@g.us';
    store.ensureConversation({ jid, type: 'group', title: 'Nome Bom' });
    store.ensureConversation({ jid, type: 'group', title: null });
    const found = store.listChats().find((c) => c.jid === jid);
    assert.equal(found?.title, 'Nome Bom');
  });

  it('setMemoryEnabled atualiza conversa existente e falha em Jid desconhecido', () => {
    const jid = 'memoria-toggle@s.whatsapp.net';
    store.ensureConversation({ jid, type: 'private', title: null });

    assert.equal(store.setMemoryEnabled(jid, false), true);
    const chat = store.listChats().find((c) => c.jid === jid);
    assert.equal(chat?.memoryEnabled, false);

    // religa (o default da tabela é 1, mas aqui garantimos o ciclo completo)
    assert.equal(store.setMemoryEnabled(jid, true), true);
    assert.equal(store.setMemoryEnabled('desconhecido@s.whatsapp.net', false), false);
  });

  it('listChats busca por título Jid e ordena por atividade recente', () => {
    const a = 'chat-a@s.whatsapp.net';
    const b = 'chat-b@s.whatsapp.net';
    store.ensureConversation({ jid: a, type: 'private', title: 'Lucas Silva' });
    store.ensureConversation({ jid: b, type: 'private', title: 'Maria da Padaria' });

    // A é mais antiga; B ganhou mensagem depois — B primeiro.
    store.saveMessage(contextFor(a, { body: 'msg antiga', timestampISO: '2026-01-01T10:00:00.000Z' }), 'in');
    store.saveMessage(contextFor(b, { body: 'msg nova', timestampISO: '2026-02-01T10:00:00.000Z' }), 'in');

    const chats = store.listChats();
    const publicIdxA = chats.findIndex((c) => c.jid === a);
    const publicIdxB = chats.findIndex((c) => c.jid === b);
    assert.ok(publicIdxA >= 0 && publicIdxB >= 0);
    assert.ok(publicIdxB < publicIdxA);

    const byTitle = store.listChats({ search: 'Padaria' });
    assert.equal(byTitle.length, 1);
    assert.equal(byTitle[0]?.jid, b);

    const byLast = store.listChats({ search: 'msg antiga' });
    assert.equal(byLast.length, 1);
    assert.equal(byLast[0]?.jid, a);
  });

  it('listMessages devolve ordem cronológica crescente com direção', () => {
    const chat = 'ordem@s.whatsapp.net';
    store.saveMessage(contextFor(chat, { wamid: 'O-1', body: 'primeira', timestampISO: '2026-03-01T10:00:00.000Z' }), 'in');
    store.saveMessage(contextFor(chat, { wamid: 'O-2', body: 'segunda', senderJid: chat, senderName: 'Geraldo' }), 'out');

    const messages = store.listMessages(chat);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.body, 'primeira');
    assert.equal(messages[1]?.body, 'segunda');
    assert.equal(messages[1]?.direction, 'out');
    assert.equal(messages[1]?.senderName, 'Geraldo');
  });

  it('limit clamp em listMessages', () => {
    const chat = 'clamp@s.whatsapp.net';
    for (let i = 0; i < 5; i += 1) {
      store.saveMessage(contextFor(chat, { wamid: `C-${i}`, body: `m${i}` }), 'in');
    }
    assert.equal(store.listMessages(chat, 2).length, 2);
    assert.equal(store.listMessages(chat, 999).length, 5);
  });
});
