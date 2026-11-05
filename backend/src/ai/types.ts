/** Tipos do AIEngine — SEM dependência de nenhum SDK de provider. */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** true → server-sent events (o cliente junta os deltas). */
  stream?: boolean;
}

export interface ChatClient {
  complete(options: ChatCompletionOptions): Promise<string>;
}

/** Falha do provedor com código HTTP (quando existir). */
export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}
