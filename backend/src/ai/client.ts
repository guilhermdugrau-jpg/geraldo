import { ProviderError, type ChatClient, type ChatCompletionOptions } from './types.ts';

/**
 * Monta a URL de /chat/completions compatível com:
 *  - OpenAI (baseUrl https://api.openai.com/v1)
 *  - Groq (https://api.groq.com/openai/v1)
 *  - Google AI Studio (https://generativelanguage.googleapis.com/v1beta/openai)
 *  - Z.ai (https://api.z.ai/api/paas/v4)
 *  - OpenRouter (https://openrouter.ai/api/v1)
 *  - Ollama (host puro: /v1 é somado)
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  if (clean.endsWith('/v1beta/openai') || clean.endsWith('/v1')) {
    return `${clean}/chat/completions`;
  }
  return `${clean}/v1/chat/completions`;
}

interface SimpleResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
  header(name: string): string | null;
}

type FetchFn = (url: string, init: RequestInit) => Promise<SimpleResponse>;

/** Extrai deltas de conteúdo de um bloco SSE ("data: {...}" ou "[DONE]"). */
export function sseBlockContent(block: string): string {
  const lines = block.split('\n');
  let content = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed === 'object' && parsed !== null) {
        const choices = (parsed as Record<string, unknown>)['choices'];
        if (Array.isArray(choices) && choices.length > 0) {
          const first = choices[0];
          if (typeof first === 'object' && first !== null) {
            const delta = (first as Record<string, unknown>)['delta'];
            if (typeof delta === 'object' && delta !== null) {
              const deltaContent = (delta as Record<string, unknown>)['content'];
              if (typeof deltaContent === 'string') content += deltaContent;
            }
          }
        }
      }
    } catch {
      // Bloco malformado: ignora e segue (providers às vezes mandam keep-alive).
    }
  }
  return content;
}

function choicesContent(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first === 'object' && first !== null) {
    const message = (first as Record<string, unknown>)['message'];
    if (typeof message === 'object' && message !== null) {
      const content = (message as Record<string, unknown>)['content'];
      if (typeof content === 'string' && content.length > 0) return content;
    }
    const text = (first as Record<string, unknown>)['text'];
    if (typeof text === 'string' && text.length > 0) return text;
  }
  return null;
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return 'provedor demorou demais (timeout)';
    }
    return error.message;
  }
  return String(error);
}

function toHeaderFn(response: unknown): (name: string) => string | null {
  const headerSource = response as {
    header?: unknown;
    headers?: unknown;
  };
  if (typeof headerSource.header === 'function') {
    return headerSource.header.bind(response);
  }
  if (headerSource.headers !== undefined && headerSource.headers !== null) {
    const headers = headerSource.headers as { get?: unknown };
    if (typeof headers.get === 'function') {
      return (name: string) => (headers.get as (n: string) => string | null)(name);
    }
    if (typeof headerSource.headers === 'object') {
      const map = headerSource.headers as Record<string, string | undefined>;
      return (name) => map[name.toLowerCase()] ?? null;
    }
  }
  return () => null;
}

export class OpenAICompatClient implements ChatClient {
  private controller: AbortController | null = null;

  constructor(
    private readonly fetchFn: FetchFn = ((url: string, init: RequestInit) =>
      fetch(url, init)) as unknown as FetchFn,
  ) {}

  async complete(options: ChatCompletionOptions): Promise<string> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs, 1000), 600000);
    this.controller = new AbortController();
    const timer = setTimeout(() => {
      this.controller?.abort();
    }, timeoutMs);
    try {
      const response = await this.fetchFn(chatCompletionsUrl(options.baseUrl), {
        method: 'POST',
        signal: this.controller.signal,
        headers: {
          'content-type': 'application/json',
          'accept': options.stream === true ? 'text/event-stream' : 'application/json',
          ...(options.apiKey !== undefined && options.apiKey !== ''
            ? { authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          ...(options.stream === true ? { stream: true } : {}),
        }),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        throw new ProviderError(
          `provedor respondeu HTTP ${response.status}${detail !== '' ? `: ${detail}` : ''}`,
          response.status,
        );
      }
      if (options.stream === true) {
        return await this.readStream(response);
      }
      const data: unknown = await response.json();
      const content = choicesContent(data);
      if (content === null) {
        throw new ProviderError('provedor respondeu sem conteúdo de texto');
      }
      return content;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(describeFetchError(error));
    } finally {
      clearTimeout(timer);
      this.controller = null;
    }
  }

  private async readStream(response: SimpleResponse): Promise<string> {
    const contentType = toHeaderFn(response)('content-type');
    if (contentType !== null && contentType.includes('application/json')) {
      // Provedor ignorou stream=true — resposta normal JSON.
      const data: unknown = await response.json();
      const single = choicesContent(data);
      if (single === null) {
        throw new ProviderError('provedor retornou JSON sem conteúdo em modo stream');
      }
      return single;
    }
    if (response.body === undefined || response.body === null) {
      throw new ProviderError('provedor não abriu corpo de stream');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) content += sseBlockContent(block);
      }
    } catch (error) {
      throw new ProviderError(`stream interrompido: ${describeFetchError(error)}`);
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') content += sseBlockContent(buffer);
    if (content === '') {
      throw new ProviderError('stream terminou sem conteúdo');
    }
    return content;
  }
}
