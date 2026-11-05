import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chatCompletionsUrl, OpenAICompatClient, sseBlockContent } from '../ai/client.ts';
import { ProviderError, type ChatCompletionOptions } from '../ai/types.ts';

describe('ai client — chatCompletionsUrl', () => {
  it('Ollama host puro ganha /v1/chat/completions', () => {
    assert.equal(
      chatCompletionsUrl('http://localhost:11434'),
      'http://localhost:11434/v1/chat/completions',
    );
  });

  it('barra no final é normalizada', () => {
    assert.equal(
      chatCompletionsUrl('http://localhost:11434/'),
      'http://localhost:11434/v1/chat/completions',
    );
  });

  it('OpenAI /v1 existente não duplica o caminho', () => {
    assert.equal(
      chatCompletionsUrl('https://api.openai.com/v1'),
      'https://api.openai.com/v1/chat/completions',
    );
  });
});

describe('ai client — extração de conteúdo', () => {
  const base: ChatCompletionOptions = {
    baseUrl: 'http://mock',
    model: 'm1',
    messages: [{ role: 'user', content: 'oi' }],
    temperature: 0.5,
    maxTokens: 64,
    timeoutMs: 1000,
  };

  function clientWith(payloadProvider: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; header(name: string): string | null }>): OpenAICompatClient {
    return new OpenAICompatClient(() => payloadProvider());
  }

  it('lê choices[0].message.content', async () => {
    const client = clientWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'resposta do mock' } }] }),
      text: async () => '',
      header: () => 'application/json',
    }));
    assert.equal(await client.complete(base), 'resposta do mock');
  });

  it('provedores antigos com choices[0].text continuam lidos', async () => {
    const client = clientWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ text: 'completamento bruto' }] }),
      text: async () => '',
      header: () => null,
    }));
    assert.equal(await client.complete(base), 'completamento bruto');
  });

  it('HTTP 401 inclui status na ProviderError', async () => {
    const client = clientWith(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'chave ruim',
      header: () => null,
    }));
    await assert.rejects(
      client.complete(base),
      (error: ProviderError) => error.status === 401 && error.message.includes('401'),
    );
  });

  it('resposta vazia (sem choices) é rejeitada com clareza', async () => {
    const client = clientWith(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
      text: async () => '',
      header: () => null,
    }));
    await assert.rejects(client.complete(base), /sem conteúdo/);
  });

  it('fetch que estoura (AbortError) vira timeout legível', async () => {
    const client = clientWith(async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    });
    await assert.rejects(client.complete(base), /timeout/);
  });

  it('apiKey vai no HEADER authorization; Ollama (sem key) não envia', async () => {
    const saw: { current: { headers: Record<string, string>; body: string } | null } = {
      current: null,
    };
    const client = new OpenAICompatClient((url, init) => {
      saw.current = {
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      void url;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok mock' } }] }),
        text: async () => '',
        header: () => 'application/json',
      });
    });
    await client.complete({ ...base, apiKey: 'chave-secreta' });
    assert.ok(saw.current !== null);
    const headers = saw.current.headers;
    assert.equal(headers['authorization'], 'Bearer chave-secreta');
    assert.equal(headers['content-type'], 'application/json');

    await client.complete({ ...base, apiKey: undefined });
    assert.ok(saw.current !== null);
    const next = saw.current.headers;
    assert.equal(next['authorization'], undefined);
  });

  it('stream:true pede accept SSE e manda stream no corpo', async () => {
    const saw: { current: { headers: Record<string, string>; body: string } | null } = {
      current: null,
    };
    const client = new OpenAICompatClient((_url, init) => {
      saw.current = {
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'x' } }] }),
        text: async () => '',
        header: () => 'application/json',
      });
    });
    await client.complete({ ...base, stream: true });
    assert.ok(saw.current !== null);
    assert.equal(saw.current.headers['accept'], 'text/event-stream');
    const body = JSON.parse(saw.current.body) as { stream?: boolean };
    assert.equal(body.stream, true);
  });
});

describe('ai client — streaming SSE', () => {
  const base: ChatCompletionOptions = {
    baseUrl: 'http://mock',
    model: 'm1',
    messages: [{ role: 'user', content: 'oi' }],
    temperature: 0.5,
    maxTokens: 64,
    timeoutMs: 1000,
    stream: true,
  };

  function sseResponse(chunks: string[]): {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
    body: ReadableStream<Uint8Array>;
    header(name: string): string | null;
  } {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('não deveria ler json em modo stream');
      },
      text: async () => '',
      body: stream,
      header: (name) => (name === 'content-type' ? 'text/event-stream' : null),
    };
  }

  function jsonOkResponse(payload: unknown): {
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
    body: ReadableStream<Uint8Array> | null;
    header(name: string): string | null;
  } {
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => '',
      body: null,
      header: () => 'application/json',
    };
  }

  it('sseBlockContent junta deltas de vários pares data:', () => {
    const block = [
      'data: {"choices":[{"delta":{"content":"Ol"}}]}',
      'data: {"choices":[{"delta":{"content":"á!"}}]}',
      'data: [DONE]',
    ].join('\n');
    assert.equal(sseBlockContent(block), 'Olá!');
  });

  it('trocẽ completa: chunks SSE rendem a frase inteira', async () => {
    const client = new OpenAICompatClient(() =>
      Promise.resolve(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"primei"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"ro final"}}]}\n\ndata: [DONE]\n\n',
        ]),
      ),
    );
    assert.equal(await client.complete(base), 'primeiro final');
  });

  it('provider que responde JSON mesmo pedindo stream continua funcionando', async () => {
    const client = new OpenAICompatClient(() =>
      Promise.resolve(
        jsonOkResponse({ choices: [{ message: { content: 'resposta única' } }] }),
      ),
    );
    assert.equal(await client.complete(base), 'resposta única');
  });

  it('stream vazio rejeita com mensagem clara', async () => {
    const client = new OpenAICompatClient(() =>
      Promise.resolve(sseResponse(['data: [DONE]\n\n'])),
    );
    await assert.rejects(client.complete(base), /sem conteúdo/);
  });

  it('HTTP 429 em modo stream também estoura ProviderError p/ fallback', async () => {
    let sawStatus = 0;
    const client = new OpenAICompatClient(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: async () => ({}),
        text: async () => 'rate_limit_exceeded',
        header: () => null,
      }),
    );
    await assert.rejects(
      (async () => {
        try {
          await client.complete(base);
        } finally {
          sawStatus = 1;
        }
      })(),
      (error: ProviderError) => error.status === 429,
    );
    assert.equal(sawStatus, 1);
  });
});
