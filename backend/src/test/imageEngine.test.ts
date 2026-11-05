/**
 * ETAPA 7: testes do ImageEngine e dos adaptadores de provedor — sem
 * rede real aqui. O que se verifica: status honesto por provedor,
 * paths Z.ai/Gemini/OpenAI com fakes de HTTP, extração de payload,
 * lock de geração, catálogo (media_files + image_meta) e envio.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../database/database.ts';
import { runMigrations } from '../database/migrations.ts';
import { Logger } from '../logger/logger.ts';
import { resolvePaths } from '../config/paths.ts';
import type { AISettings } from '../config/types.ts';
import { ImageEngine, type ImageEngineDeps } from '../images/imageEngine.ts';
import {
  extractGeminiImage,
  extractZaiPayloadUrl,
  generateWithProvider,
  sniffImageMime,
  type ImageApiFetch,
} from '../images/providers.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'geraldoimg-'));
const paths = resolvePaths(dataDir);
mkdirSync(paths.mediaDir, { recursive: true });
const db = new Database(paths.dbPath);
runMigrations(db, { backupsDir: paths.backupsDir, dbPath: paths.dbPath });
const logger = new Logger({ level: 'error', file: null, console: false });

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* tmp do usuário — se travou ponteiro, fica no tmp mesmo */
  }
});

/** PNG mínimo: magic bytes reconhecíveis pro sniffImageMime. */
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('FALSA IMAGEM PRA TESTE'),
]);

function ai(overrides: Partial<AISettings> = {}): AISettings {
  return {
    provider: 'zai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: '',
    fallbackModel: '',
    apiKey: 'chave-fake-de-teste',
    temperature: 0.7,
    maxTokens: 2048,
    timeoutMs: 30_000,
    ...overrides,
  } as AISettings;
}

interface Harness {
  engine: ImageEngine;
  calls: { generate: number; http: number; binary: number; send: number };
  deps: ImageEngineDeps;
}

function makeEngine(
  aiOverrides: Partial<AISettings> = {},
  overrides: Partial<ImageEngineDeps> = {},
): Harness {
  const calls = { generate: 0, http: 0, binary: 0, send: 0 };
  const fetchHttp: ImageApiFetch = async (url) => {
    calls.http += 1;
    if (url.includes('/images/generations')) {
      return { ok: true, status: 200, json: { data: [{ url: 'https://fake-cdn/imagem-gerada.png' }], created: 1 } };
    }
    return { ok: true, status: 200, json: { output_image: { data: FAKE_PNG.toString('base64'), mime_type: 'image/png' } } };
  };
  const deps: ImageEngineDeps = {
    db,
    log: logger.withModule('img-teste'),
    paths: { mediaDir: paths.mediaDir },
    getAI: () => ai(aiOverrides),
    sendImage: async (chatJid) => {
      calls.send += 1;
      assert.ok(chatJid.includes('@'));
      return `fake-wamid-${String(calls.send)}`;
    },
    fetchHttp,
    fetchBinary: async () => {
      calls.binary += 1;
      return FAKE_PNG;
    },
    ...overrides,
  };
  return { engine: new ImageEngine(deps), calls, deps };
}

describe('ImageEngine (ETAPA 7) — geração por prompt', () => {
  it('status honesto: IA desabilitada → capable false com instrução real', () => {
    const { engine } = makeEngine({ provider: 'disabled', apiKey: '' });
    const s = engine.status();
    assert.equal(s.ready, false);
    assert.equal(s.capable, false);
    assert.ok(s.hint !== null && s.hint.includes('desabilitada'));
  });

  it('status honesto: provedor capaz sem chave → ready false pedindo a chave', () => {
    const { engine } = makeEngine({ provider: 'gemini', apiKey: '' });
    const s = engine.status();
    assert.equal(s.capable, true);
    assert.equal(s.ready, false);
    assert.ok(s.hint !== null && s.hint.includes('chave'));
    assert.equal(s.modelName, 'gemini-nano-banana-2.1');
  });

  it('status: groq/ollama não mandam imagem (documentado, sem fake)', () => {
    const groq = makeEngine({ provider: 'groq' }).engine.status();
    assert.equal(groq.capable, false);
    assert.ok(groq.hint !== null && groq.hint.includes('zai (GLM-Image)'));
    const ollama = makeEngine({ provider: 'ollama' }).engine.status();
    assert.equal(ollama.capable, false);
  });

  it('geração Z.ai feliz: URL baixada na hora + catálogo completo', async () => {
    const { engine, calls } = makeEngine();
    const made = await engine.generate('cabra da peste tocando forró no sertão');
    assert.equal(made.provider, 'zai');
    assert.equal(made.model, 'glm-image');
    assert.equal(made.mime, 'image/png');
    assert.ok(existsSync(made.filePath));
    assert.equal(calls.http, 1);
    assert.equal(calls.binary, 1);

    const list = engine.listImages();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, made.id);
    assert.equal(list[0]?.prompt, 'cabra da peste tocando forró no sertão');
    const got = engine.getImage(made.id);
    assert.notEqual(got, null);
    assert.ok(got !== null && got.filePath.endsWith('.png'));

    const row = db
      .prepare(
        `SELECT m.category AS c FROM media_files m
         JOIN image_meta i ON i.id = m.id WHERE m.id = ?`,
      )
      .get(made.id) as { c: string } | undefined;
    assert.ok(row !== undefined);
    assert.equal(row.c, 'image');
  });

  it('geração Gemini feliz: input no formato interactions, imagem em base64', async () => {
    const seen: Array<{ url: string; init: Record<string, unknown> }> = [];
    const { engine } = makeEngine(
      { provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      {
        fetchHttp: async (url, init) => {
          seen.push({ url, init: init as unknown as Record<string, unknown> });
          return {
            ok: true,
            status: 200,
            json: { output_image: { data: FAKE_PNG.toString('base64'), mime_type: 'image/png' } },
          };
        },
      },
    );
    const made = await engine.generate('um cangaceiro de óculos escuros');
    assert.equal(made.provider, 'gemini');
    assert.equal(made.model, 'gemini-nano-banana-2.1');
    assert.equal(seen[0]?.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    const headers = (seen[0]?.init['headers'] ?? {}) as Record<string, string>;
    assert.ok(headers['x-goog-api-key'] !== undefined);
    assert.equal(headers['Api-Revision'], '2026-05-20');
    assert.ok(!existsSync(join(paths.mediaDir, 'gemini-should-not-have-cdn.png')));
  });

  it('geração OpenAI-compat feliz pelo b64_json', async () => {
    const { engine } = makeEngine(
      { provider: 'openai', model: 'meu-modelo-de-imagem' },
      {
        fetchHttp: async (url) => {
          assert.ok(url.includes('/images/generations'));
          return { ok: true, status: 200, json: { data: [{ b64_json: FAKE_PNG.toString('base64') }] } };
        },
      },
    );
    const made = await engine.generate('post existential dolor');
    assert.equal(made.provider, 'openai');
    assert.equal(made.model, 'meu-modelo-de-imagem');
  });

  it('provedor responde HTTP 503 → erro honesto com o status', async () => {
    const { engine } = makeEngine(
      { provider: 'zai' },
      {
        fetchHttp: async () => ({ ok: false, status: 503, json: { message: 'overloaded' } }),
      },
    );
    await assert.rejects(() => engine.generate('oi'), /HTTP 503/);
  });

  it('Gemini sem imagem na resposta → erro honesto (nada inventado)', async () => {
    const { engine } = makeEngine(
      { provider: 'gemini' },
      { fetchHttp: async () => ({ ok: true, status: 200, json: { steps: [] } }) },
    );
    await assert.rejects(() => engine.generate('oi'), /sem imagem/);
  });

  it('lock: segunda geração enquanto roda erra honesta de fila', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const { engine } = makeEngine(
      { provider: 'zai' },
      {
        fetchHttp: async () => {
          await gate;
          return { ok: true, status: 200, json: { data: [{ url: 'https://fake-cdn/x.png' }] } };
        },
      },
    );
    const first = engine.generate('fala longa empilhada');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    await assert.rejects(() => engine.generate('outra imagem'), /já sendo gerada/);
    release();
    const made = await first;
    assert.ok(existsSync(made.filePath));
  });

  it('entrada: prompt vazio, longo demais e tamanho podre são instructive', async () => {
    const { engine } = makeEngine();
    await assert.rejects(() => engine.generate('   '), /prompt vazio/);
    await assert.rejects(() => engine.generate('a'.repeat(1001)), /passa de 1000 caracteres/);
    await assert.rejects(() => engine.generate('oi', '128000x128'), /LARGURAxALTURA/);
    await assert.rejects(() => engine.generate('oi', '200x300'), /512–2048/);
  });

  it('envio: fantasma 404-like, jid inválido e arquivo sumido são honestos', async () => {
    const { engine } = makeEngine();
    await assert.rejects(() => engine.send('nao-existe-imagem', '551199999@s.whatsapp.net'), /não encontrada/);

    const made = await engine.generate('mandada depois');
    await assert.rejects(() => engine.send(made.id, 'uzumakinji'), /jid.*inválido/);

    rmSync(made.filePath, { force: true });
    await assert.rejects(() => engine.send(made.id, '551199999@s.whatsapp.net'), /sumiu do disco/);
  });

  it('envio feliz devolve wamid do whatsappService', async () => {
    const { engine, calls } = makeEngine();
    const made = await engine.generate('essa vai pro zap como foto');
    const sent = await engine.send(made.id, '551199999@s.whatsapp.net', 'olha o gato');
    assert.equal(sent.ok, true);
    assert.equal(sent.wamid, 'fake-wamid-1');
    assert.equal(calls.send, 1);
  });
});

describe('imagem/providers — extração pura e sniff', () => {
  it('snippet Z.ai: data[0].url; lixo → null (sem invented)', () => {
    assert.equal(extractZaiPayloadUrl({ data: [{ url: 'https://x/y.png' }] }), 'https://x/y.png');
    assert.equal(extractZaiPayloadUrl({ data: [] }), null);
    assert.equal(extractZaiPayloadUrl({ data: [{ url: 'não é http' }] }), null);
    assert.equal(extractZaiPayloadUrl(null), null);
  });

  it(' Gemini: output_image direto, inlineData aninhado e nada → null', () => {
    assert.equal(extractGeminiImage({ output_image: { data: 'QUJD', mime_type: 'image/png' } })?.data, 'QUJD');
    const nested = { steps: [{ parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'WFla' } }] }] };
    assert.equal(extractGeminiImage(nested)?.mime, 'image/jpeg');
    assert.equal(extractGeminiImage({ oi: [] }), null);
  });

  it('sniffImageMime: PNG, JPEG e fallback honesto', () => {
    assert.equal(sniffImageMime(FAKE_PNG), 'image/png');
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffImageMime(Buffer.from('estudo de texto')), 'application/octet-stream');
  });

  it('generateWithProvider sem provedor e sem chave eram honestos', async () => {
    await assert.rejects(
      () => generateWithProvider(
        { provider: 'groq', baseUrl: '', apiKey: 'k', timeoutMs: 1000, model: '' },
        async () => ({ ok: true, status: 200, json: {} }),
        async () => FAKE_PNG,
        'oi',
      ),
      /não expõe geração de imagem/,
    );
    await assert.rejects(
      () => generateWithProvider(
        { provider: 'zai', baseUrl: '', apiKey: '', timeoutMs: 1000, model: '' },
        async () => ({ ok: true, status: 200, json: {} }),
        async () => FAKE_PNG,
        'oi',
      ),
      /chave de API vazia/,
    );
  });
});
