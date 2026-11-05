import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decideResponse,
  normalizeJid,
  parseWhatsAppMessage,
  timestampToISO,
} from '../whatsapp/extract.ts';

const ME = '5511900000000:12@s.whatsapp.net'; // com sufixo de dispositivo

function base(withMessage: Record<string, unknown>): {
  key: Record<string, unknown>;
  message: Record<string, unknown>;
  pushName?: string;
  messageTimestamp?: unknown;
} {
  return {
    key: {
      id: 'WAMID-1',
      remoteJid: '5511900000000@s.whatsapp.net',
      fromMe: false,
      ...{},
    },
    message: withMessage,
    pushName: 'Lucas',
    messageTimestamp: 1700000000,
  };
}

describe('extract — parseWhatsAppMessage', () => {
  it('mensagem de texto simples em conversa privada', () => {
    const parsed = parseWhatsAppMessage(base({ conversation: 'oxente, tudo joia?' }), ME);
    assert.ok(parsed !== null);
    assert.equal(parsed.kind, 'text');
    assert.equal(parsed.body, 'oxente, tudo joia?');
    assert.equal(parsed.chatType, 'private');
    assert.equal(parsed.senderName, 'Lucas');
    assert.equal(parsed.senderJid, '5511900000000@s.whatsapp.net');
    assert.equal(parsed.wamid, 'WAMID-1');
    assert.equal(parsed.fromMe, false);
    assert.equal(parsed.mentionsMe, false);
    assert.equal(parsed.timestampISO, '2023-11-14T22:13:20.000Z');
  });

  it('extendedTextMessage usa o campo text', () => {
    const parsed = parseWhatsAppMessage(
      base({ extendedTextMessage: { text: 'resposta longa' } }),
      ME,
    );
    assert.ok(parsed !== null);
    assert.equal(parsed.body, 'resposta longa');
    assert.equal(parsed.kind, 'text');
  });

  it('mensagem em grupo usa key.participant como autor', () => {
    const group = {
      key: {
        id: 'G-1',
        remoteJid: '120363025@g.us',
        fromMe: false,
        participant: '5581999887766:5@s.whatsapp.net',
      },
      message: { conversation: 'e o povo' },
      pushName: 'Zé',
      messageTimestamp: 1700000001,
    };
    const parsed = parseWhatsAppMessage(group, ME);
    assert.ok(parsed !== null);
    assert.equal(parsed.chatType, 'group');
    assert.equal(parsed.senderJid, '5581999887766@s.whatsapp.net');
  });

  it('menção por Jid (com sufixo de device) é detectada', () => {
    const parsed = parseWhatsAppMessage(
      base({
        extendedTextMessage: {
          text: 'chama o Geraldo',
          contextInfo: { mentionedJid: [ME] },
        },
      }),
      ME,
    );
    assert.ok(parsed !== null);
    assert.equal(parsed.mentionsMe, true);
  });

  it("menção textual '@geraldo' também detecta", () => {
    const parsed = parseWhatsAppMessage(base({ conversation: 'ó o @geraldo pra trampar' }), ME);
    assert.ok(parsed !== null);
    assert.equal(parsed.mentionsMe, true);
  });

  it('resposta a mensagem do Geraldo marca isReplyToMe', () => {
    const parsed = parseWhatsAppMessage(
      base({
        extendedTextMessage: {
          text: 'foi você quem falou isso',
          contextInfo: { participant: ME, quotedMessage: { conversation: '...' } },
        },
      }),
      ME,
    );
    assert.ok(parsed !== null);
    assert.equal(parsed.isReplyToMe, true);
  });

  it('reação e protocolo são ignorados (return null)', () => {
    assert.equal(parseWhatsAppMessage(base({ reactionMessage: { text: '👍' } }), ME), null);
    assert.equal(
      parseWhatsAppMessage(base({ protocolMessage: { type: 0 } }), ME),
      null,
    );
  });

  it('mídia com legenda guarda a legenda como corpo', () => {
    const parsed = parseWhatsAppMessage(
      base({ imageMessage: { caption: 'olha o meme', url: 'x' } }),
      ME,
    );
    assert.ok(parsed !== null);
    assert.equal(parsed.kind, 'image');
    assert.equal(parsed.body, 'olha o meme');
  });

  it('mídia sem legenda tem body null, mas não é descartada', () => {
    const parsed = parseWhatsAppMessage(base({ audioMessage: { ptt: true } }), ME);
    assert.ok(parsed !== null);
    assert.equal(parsed.kind, 'audio');
    assert.equal(parsed.body, null);
  });

  it('fromMe passa no parse (o serviço decide o que fazer)', () => {
    const mine = {
      key: { id: 'M-1', remoteJid: '5511900000000@s.whatsapp.net', fromMe: true },
      message: { conversation: 'mensagem minha' },
      messageTimestamp: 1700000002,
    };
    const parsed = parseWhatsAppMessage(mine, ME);
    assert.ok(parsed !== null);
    assert.equal(parsed.fromMe, true);
  });

  it('sem key/id remoteJid descarta a mensagem', () => {
    assert.equal(parseWhatsAppMessage({ message: { conversation: 'x' } }, ME), null);
  });
});

describe('extract — timestampToISO', () => {
  it('aceita número em segundos', () => {
    assert.equal(timestampToISO(1700000000), '2023-11-14T22:13:20.000Z');
  });

  it('aceita Long do protobuf ({low})', () => {
    assert.equal(timestampToISO({ low: 1700000000, high: 0 }), '2023-11-14T22:13:20.000Z');
  });

  it('valor desconhecido vira época (1970)', () => {
    assert.equal(timestampToISO(null), '1970-01-01T00:00:00.000Z');
    assert.equal(timestampToISO('lixo'), '1970-01-01T00:00:00.000Z');
  });
});

describe('extract — normalizeJid', () => {
  it('remove sufixo de device do usuário e do domínio', () => {
    assert.equal(normalizeJid('5511900000000:12@s.whatsapp.net'), '5511900000000@s.whatsapp.net');
    assert.equal(normalizeJid('1112:0@broadcast:443'), '1112@broadcast');
    assert.equal(normalizeJid('sem-arroba'), 'sem-arroba');
  });
});

describe('extract — decideResponse (regra honesta da ETAPA 2)', () => {
  it('grupo sem menção/resposta não acorda o Geraldo', () => {
    assert.equal(
      decideResponse({ isGroup: true, mentionsMe: false, isReplyToMe: false, respondInPrivate: true }),
      false,
    );
  });

  it('grupo com menção ou resposta acorda', () => {
    assert.equal(
      decideResponse({ isGroup: true, mentionsMe: true, isReplyToMe: false, respondInPrivate: true }),
      true,
    );
    assert.equal(
      decideResponse({ isGroup: true, mentionsMe: false, isReplyToMe: true, respondInPrivate: false }),
      true,
    );
  });

  it('privado segue a configuração', () => {
    assert.equal(
      decideResponse({ isGroup: false, mentionsMe: false, isReplyToMe: false, respondInPrivate: true }),
      true,
    );
    assert.equal(
      decideResponse({ isGroup: false, mentionsMe: true, isReplyToMe: false, respondInPrivate: false }),
      false,
    );
  });
});
