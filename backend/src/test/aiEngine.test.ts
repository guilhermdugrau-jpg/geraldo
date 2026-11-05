import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Database } from '../database/database.ts';
import { runMigrations } from '../database/migrations.ts';
import { Logger } from '../logger/logger.ts';
import { WhatsAppStore } from '../whatsapp/store.ts';
import type { WhatsAppMessageContext } from '../whatsapp/types.ts';
import {
  AIEngine,
  type AIEngineDeps,
} from '../ai/aiEngine.ts';
import type { AISettings } from '../config/types.ts';
import {
  FAILURE_REPLY,
  buildTranscript,
  buildSystemPrompt,
  trimTranscript,
} from '../ai/prompt.ts';
import type { ChatClient, ChatCompletionOptions } from '../ai/types.ts';

function aiSettings(overrides: Partial<AISettings> = {}): AISettings {
  return {
    provider: 'openai',
    model: 'mock-1',
    fallbackModel: '',
    baseUrl: 'http://mock.local',
    apiKey: 'chave-teste',
    temperature: 0.5,
    maxTokens: 128,
    timeoutMs: 2000,
    ...overrides,
  };
}

class FakeChatClient implements ChatClient {
  calls: ChatCompletionOptions[] = [];
  constructor(
    private readonly script: Array<(options: ChatCompletionOptions) => Promise<string>>,
  ) {}
  async complete(options: ChatCompletionOptions): Promise<string> {
    this.calls.push(options);
    const step = this.script.shift();
    if (step === undefined) throw new Error('roteiro do mock acabou');
    return step(options);
  }
}

// ── banco + store de verdade (fixture) ──────────────────────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'geraldo-ai-'));
const db = new Database(join(dataDir, 'geraldo.db'));
runMigrations(db, { backupsDir: dataDir, dbPath: join(dataDir, 'geraldo.db') });
const store = new WhatsAppStore(db);
const logger = new Logger({ level: 'error', file: null, console: false });

function engineFor(
  overrides: Partial<AIEngineDeps> & { client?: ChatClient; ai?: Partial<AISettings> },
): AIEngine {
  return new AIEngine({
    getAI: () => aiSettings(overrides.ai ?? {}),
    store,
    log: logger.withModule('ai'),
    client: overrides.client,
    historyTurns: overrides.historyTurns ?? 5,
  });
}

function contextFor(jid: string, extra: Partial<WhatsAppMessageContext> = {}): WhatsAppMessageContext {
  return {
    chatJid: jid,
    chatType: jid.endsWith('@g.us') ? 'group' : 'private',
    senderJid: '5511900000000@s.whatsapp.net',
    senderName: 'Lucas Teste',
    wamid: 'ENGINE-1',
    kind: 'text',
    body: 'papo da conversa',
    timestampISO: new Date().toISOString(),
    mentionsMe: true,
    isReplyToMe: false,
    fromMe: false,
    ...extra,
  };
}

function sentLog(): Array<{ jid: string; text: string; quoted: unknown }> {
  return [];
}

function makeSent(): { engineSent: (engine: AIEngine) => Array<{ jid: string; text: string; quoted: unknown }> } {
  const sent: Array<{ jid: string; text: string; quoted: unknown }> = [];
  const bindExample = (engine: AIEngine): void => {
    engine.bindSend(async (jid, text, options) => {
      sent.push({ jid, text, quoted: options?.quoted });
    });
  };
  return { engineSent: () => sent, __bind: bindExample } as never;
}

after(() => {
  db.close();
});

describe('ai engine — decisão', () => {
  it('provider desligado → respond false e nenhuma chamada de rede', async () => {
    const client = new FakeChatClient([]);
    const engine = engineFor({ client, ai: { provider: 'disabled' } });
    assert.equal(engine.canGenerate(), false);
    const handled = await engine.respond(contextFor('off@s.whatsapp.net'), { raw: true });
    assert.equal(handled, false);
    assert.equal(client.calls.length, 0);
  });

  it('provider+modelo configurados → canGenerate true', () => {
    const engine = engineFor({ client: new FakeChatClient([]) });
    assert.equal(engine.canGenerate(), true);
    assert.deepEqual(engine.describe(), { active: true, provider: 'openai', model: 'mock-1' });
  });
});

describe('ai engine — resposta com memória e citação', () => {
  it('sucesso: envia a resposta do provedor citando a mensagem original', async () => {
    const chat = 'ai-ok@s.whatsapp.net';
    store.ensureConversation({ jid: chat, type: 'private', title: 'Lucas' });
    store.saveMessage(contextFor(chat, { wamid: 'OK-1', body: 'manda ver' }), 'in');

    const sent: Array<{ jid: string; text: string; quoted: unknown }> = [];
    const engine = engineFor({
      client: new FakeChatClient([async () => 'papo pronto, meu rei!']),
    });
    engine.bindSend(async (jid, text, options) => {
      sent.push({ jid, text, quoted: options?.quoted });
    });

    const raw = { key: { id: 'OK-1' } };
    const handled = await engine.respond(contextFor(chat, { wamid: 'OK-1' }), raw);
    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.jid, chat);
    assert.equal(sent[0]?.text, 'papo pronto, meu rei!');
    assert.deepEqual(sent[0]?.quoted, raw);
    assert.equal(engine.callsMade, 1);
    assert.equal(engine.callsFailed, 0);
  });

  it('memória ligada: o transcript chega no prompt; desligada: não manda histórico', async () => {
    const chatOn = 'ai-mem-on@g.us';
    const chatOff = 'ai-mem-off@g.us';
    store.ensureConversation({ jid: chatOn, type: 'group', title: 'Rodada' });
    store.ensureConversation({ jid: chatOff, type: 'group', title: 'Mudo' });
    store.saveMessage(
      contextFor(chatOn, { wamid: 'M-1', body: 'segredo-na-memória' }),
      'in',
    );
    store.saveMessage(
      contextFor(chatOff, { wamid: 'M-2', body: 'nunca-vai-passar' }),
      'in',
    );
    // memória desligada no chatOff
    assert.equal(store.isMemoryEnabled(chatOn), true);
    store.setMemoryEnabled(chatOff, false);
    assert.equal(store.isMemoryEnabled(chatOff), false);

    let transcriptOn = '';
    let transcriptOff = '';
    const client = new FakeChatClient([
      async (options) => {
        transcriptOn = options.messages.map((m) => m.content).join('\n');
        return 'ok';
      },
      async (options) => {
        transcriptOff = options.messages.map((m) => m.content).join('\n');
        return 'ok';
      },
    ]);
    const engine = engineFor({ client });
    engine.bindSend(async () => undefined);

    await engine.respond(contextFor(chatOn, { wamid: 'M-1' }), {});
    await engine.respond(contextFor(chatOff, { wamid: 'M-2' }), {});

    assert.ok(transcriptOn.includes('segredo-na-memória'));
    assert.ok(!transcriptOff.includes('nunca-vai-passar'));
    assert.ok(transcriptOff.includes('Primeira mensagem'));
  });

  it('system prompt protege segredos: instrui não revelar e fica ativo', async () => {
    assert.ok(buildSystemPrompt().includes('Nunca revele'));
    assert.ok(buildSystemPrompt().startsWith('Você é o Geraldo'));
  });
});

describe('ai engine — falhas honestas', () => {
  it('provider falhou → aviso FAILURE_REPLY vai pro chat, com a citação', async () => {
    const chat = 'ai-fail@s.whatsapp.net';
    store.ensureConversation({ jid: chat, type: 'private', title: null });
    store.saveMessage(contextFor(chat, { wamid: 'F-1' }), 'in');

    const sent: Array<{ text: string }> = [];
    const engine = engineFor({
      ai: { fallbackModel: '' },
      client: new FakeChatClient([async () => {
        throw new ProviderErrorText('HTTP 500');
      }]),
    });
    engine.bindSend(async (_jid, text) => {
      sent.push({ text });
    });

    const handled = await engine.respond(contextFor(chat, { wamid: 'F-1' }), {});
    assert.equal(handled, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text, FAILURE_REPLY);
    assert.equal(engine.callsFailed, 1);
  });

  it('modelo de reserva entra quando o principal cai', async () => {
    const chat = 'ai-fallback@s.whatsapp.net';
    store.ensureConversation({ jid: chat, type: 'private', title: null });
    store.saveMessage(contextFor(chat, { wamid: 'FB-1' }), 'in');

    const used: string[] = [];
    const sent: Array<{ text: string }> = [];
    const engine = engineFor({
      ai: { fallbackModel: 'mock-reserva' },
      client: new FakeChatClient([
        async (options) => {
          used.push(options.model);
          throw new ProviderErrorText('HTTP 404');
        },
        async (options) => {
          used.push(options.model);
          return 'resposta da reserva';
        },
      ]),
    });
    engine.bindSend(async (_jid, text) => {
      sent.push({ text });
    });

    const handled = await engine.respond(contextFor(chat, { wamid: 'FB-1' }), {});
    assert.equal(handled, true);
    assert.deepEqual(used, ['mock-1', 'mock-reserva']);
    assert.equal(sent[0]?.text, 'resposta da reserva');
  });

  it('duas respostas na mesma conversa em paralelo: a segunda é descartada sem duplicar', async () => {
    const chat = 'ai-lock@s.whatsapp.net';
    store.ensureConversation({ jid: chat, type: 'private', title: null });
    store.saveMessage(contextFor(chat, { wamid: 'L-1' }), 'in');

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: Array<{ text: string }> = [];
    const engine = engineFor({
      client: new FakeChatClient([async () => {
        await gate;
        return 'lenta';
      }]),
    });
    engine.bindSend(async (_jid, text) => {
      sent.push({ text });
    });

    const first = engine.respond(contextFor(chat, { wamid: 'L-1' }), {});
    const second = await engine.respond(contextFor(chat, { wamid: 'L-2' }), {});
    assert.equal(second, true); // tratado (descartado com log)
    release();
    await first;
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.text, 'lenta');
  });
});

describe('ai engine — testGenerate (botão do painel)', () => {
  it('IA desligada responde ok:false com instrução clara', async () => {
    const engine = engineFor({ ai: { provider: 'disabled' } });
    const result = await engine.testGenerate('');
    assert.deepEqual(result, {
      ok: false,
      error: 'IA sem provider/modelo configurado em Configurações',
    });
  });

  it('IA ligada com provider bom devolve a resposta e um prompt real', async () => {
    let seenMaxTokens = 0;
    const engine = engineFor({
      client: new FakeChatClient([async (options) => {
        seenMaxTokens = options.maxTokens;
        assert.ok(options.messages.some((m) => m.role === 'system'));
        return 'oi do provedor de testes';
      }]),
    });
    const result = await engine.testGenerate('diz bom dia');
    assert.deepEqual(result, { ok: true, reply: 'oi do provedor de testes' });
    assert.equal(seenMaxTokens, 128);
  });

  it('IA ligada mas provider fora do ar → ok:false com o erro', async () => {
    const engine = engineFor({
      ai: { fallbackModel: '' },
      client: new FakeChatClient([async () => {
        throw new ProviderErrorText('HTTP 503');
      }]),
    });
    const result = await engine.testGenerate('qualquer coisa');
    assert.equal(result.ok, false);
    assert.ok(result.ok === false && result.error.includes('503'));
  });

  it('apiKey passa para o client em qualquer provider com key (groq etc.)', async () => {
    const chats: Array<ChatCompletionOptions> = [];
    const client: ChatClient = {
      complete: async (options) => {
        chats.push(options);
        return 'respondido';
      },
    };
    const engine = engineFor({ client, ai: { provider: 'groq', apiKey: 'gsk_chave-de-teste' } });
    const chat = 'key-pass@s.whatsapp.net';
    store.ensureConversation({ jid: chat, type: 'private', title: null });
    store.saveMessage(contextFor(chat, { wamid: 'K-1' }), 'in');
    engine.bindSend(async () => undefined);
    const handled = await engine.respond(contextFor(chat, { wamid: 'K-1' }), {});
    assert.equal(handled, true);
    assert.equal(chats.length, 1);
    assert.equal(chats[0]?.apiKey, 'gsk_chave-de-teste');
    assert.equal(chats[0]?.model, 'mock-1');
  });

  it('req (groq): resposta usa streaming e pede chave no header direto', async () => {
    let sawStream: boolean | undefined = undefined;
    const client: ChatClient = {
      complete: async (options) => {
        sawStream = options.stream;
        return 'oi do stream';
      },
    };
    const engine = engineFor({ client });
    const chat = 'stream-flag@s.whatsapp.net';
    store.ensureConversation({ jid: chat, type: 'private', title: null });
    store.saveMessage(contextFor(chat, { wamid: 'S-1' }), 'in');
    engine.bindSend(async () => undefined);
    await engine.respond(contextFor(chat, { wamid: 'S-1' }), {});
    assert.equal(sawStream, true);
  });

  it('HTTP 429 do provider primário cai no modelo reserva sem quebrar', async () => {
    const chat = 'ai-429@s.whatsapp.net';
    store.ensureConversation({ jid: chat, type: 'private', title: null });
    store.saveMessage(contextFor(chat, { wamid: 'R-1' }), 'in');

    const used: string[] = [];
    const sent: Array<{ text: string }> = [];
    const engine = engineFor({
      ai: { fallbackModel: 'qwen/qwen3.8-27b' },
      client: new FakeChatClient([
        async (options) => {
          used.push(options.model);
          throw new ProviderErrorText('provedor respondeu HTTP 429');
        },
        async (options) => {
          used.push(options.model);
          return 'reserva no after 429';
        },
      ]),
    });
    engine.bindSend(async (_jid, text) => {
      sent.push({ text });
    });

    const handled = await engine.respond(contextFor(chat, { wamid: 'R-1' }), {});
    assert.equal(handled, true);
    assert.deepEqual(used, ['mock-1', 'qwen/qwen3.8-27b']);
    assert.equal(sent[0]?.text, 'reserva no after 429');
  });

  it('ollama sem key manda apiKey undefined (sem header)', async () => {
    let sawKey: string | undefined = 'sentinel';
    const client: ChatClient = {
      complete: async (options) => {
        sawKey = options.apiKey;
        return 'local ok';
      },
    };
    const engine = engineFor({ client, ai: { provider: 'ollama', apiKey: '' } });
    const chat = 'key-none@s.whatsapp.net';
    store.ensureConversation({ jid: chat, type: 'private', title: null });
    store.saveMessage(contextFor(chat, { wamid: 'NK-1' }), 'in');
    engine.bindSend(async () => undefined);
    await engine.respond(contextFor(chat, { wamid: 'NK-1' }), {});
    assert.equal(sawKey, undefined);
  });
});

describe('prompt — utilitários do histórico', () => {
  it('buildTranscript usa Geraldo para saída e nome para entrada', () => {
    const transcript = buildTranscript([
      {
        id: 1,
        chat: 'c',
        sender: 'x',
        senderName: 'Zézinho',
        direction: 'in',
        kind: 'text',
        body: 'ó o papo',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 2,
        chat: 'c',
        sender: 'x',
        senderName: 'Geraldo',
        direction: 'out',
        kind: 'text',
        body: 'mandei',
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ]);
    assert.ok(transcript.includes('Zézinho: ó o papo'));
    assert.ok(transcript.includes('Geraldo: mandei'));
  });

  it('trimTranscript guarda o final e corta linha incompleta', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `linha-${i}: texto ${i}`);
    const trimmed = trimTranscript(lines.join('\n'), 120);
    assert.ok(trimmed.length <= 120);
    assert.ok(trimmed.endsWith('texto 49')
      || trimmed.includes('linha-49'), 'mantém a última linha');
    assert.ok(!trimmed.startsWith('linha-0'));
  });
});

/** ProviderError com nome estável só pros testes (import leve). */
class ProviderErrorText extends Error {}

// reuso do makeSent quando necessário em novos testes
void makeSent;
