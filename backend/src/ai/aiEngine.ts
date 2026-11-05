import type { AISettings } from '../config/types.ts';
import { OpenAICompatClient } from './client.ts';
import {
  DEFAULT_HISTORY_TURNS,
  FAILURE_REPLY,
  buildSystemPrompt,
  buildTranscript,
  trimTranscript,
} from './prompt.ts';
import { SlidingRateLimiter } from './rateLimiter.ts';
import { ProviderError, type ChatClient, type ChatMessage } from './types.ts';
import type { WhatsAppStore } from '../whatsapp/store.ts';
import type { WhatsAppMessageContext } from '../whatsapp/types.ts';
import type { ChildLogger } from '../logger/logger.ts';

export type SendFn = (chatJid: string, text: string, options?: { quoted?: unknown }) => Promise<void>;

export interface AIEngineDeps {
  getAI(): AISettings;
  store: WhatsAppStore;
  log: ChildLogger;
  client?: ChatClient;
  /** p/ testes */
  historyTurns?: number;
}

function buildConversationMessages(transcript: string): ChatMessage[] {
  const history =
    transcript === ''
      ? 'Primeira mensagem desta conversa.'
      : `Histórico recente desta conversa:\n${transcript}`;
  return [
    { role: 'system', content: buildSystemPrompt() },
    {
      role: 'user',
      content:
        `${history}\n---\n` +
        "Responda a ÚLTIMA mensagem (as linhas 'Geraldo:' são você; o autor mais recente é a pessoa).",
    },
  ];
}

export type AIEngineTestResult =
  | { ok: true; reply: string }
  | { ok: false; error: string };

/**
 * Orquestrador de respostas com IA (ETAPA 3).
 * - Só fala quando há provider+modelo configurados;
 * - Grupos: apenas menção/resposta ao Geraldo (o WhatsAppService já filtra);
 * - Memória por conversa respeita o toggle `memory_enabled`;
 * - Racionamento: teto global de chamadas/min + fila por conversa (sem dupla);
 * - Falha do provider → resposta honesta curta, nunca "inventa".
 */
export class AIEngine {
  private limiter: SlidingRateLimiter;
  private pendingChats = new Set<string>();
  private sendBound: SendFn | null = null;
  private client: ChatClient;

  callsMade = 0;
  callsFailed = 0;

  constructor(private readonly deps: AIEngineDeps) {
    this.limiter = new SlidingRateLimiter(30);
    this.client = deps.client ?? new OpenAICompatClient();
  }

  bindSend(send: SendFn): void {
    this.sendBound = send;
  }

  /** IA tem tudo pra funcionar? (provider + modelo). */
  canGenerate(): boolean {
    const ai = this.deps.getAI();
    return ai.provider !== 'disabled' && ai.model.trim() !== '';
  }

  describe(): { active: boolean; provider: string; model: string } {
    const ai = this.deps.getAI();
    return {
      active: this.canGenerate(),
      provider: ai.provider,
      model: ai.model,
    };
  }

  /**
   * Processa um gatilho já filtrado. Retorna true quando o Geraldo
   * respondeu (ou respondeu com o aviso de falha); false quando a IA
   * não está configurada (fallback do service entra).
   */
  async respond(context: WhatsAppMessageContext, raw: unknown): Promise<boolean> {
    if (!this.canGenerate()) return false;

    if (this.pendingChats.has(context.chatJid)) {
      this.deps.log.warn(`fila cheia: conversa ${context.chatJid} já tem resposta em andamento`);
      return true; // tratado: silêncio delibera em vez de duplicar resposta
    }
    const now = Date.now();
    if (!this.limiter.tryConsume(now)) {
      this.deps.log.warn(`trigger ticket estourado (${this.limiter.size}/min) — resposta descartada`);
      return true; // tratado
    }

    this.pendingChats.add(context.chatJid);
    try {
      const reply = await this.generateReply(context);
      if (reply === null) {
        await this.sendBound?.(context.chatJid, FAILURE_REPLY, { quoted: raw });
        return true;
      }
      await this.sendBound?.(context.chatJid, reply, { quoted: raw });
      return true;
    } catch (error) {
      this.callsFailed += 1;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.error(`falha ao gerar resposta: ${message}`);
      try {
        await this.sendBound?.(context.chatJid, FAILURE_REPLY, { quoted: raw });
      } catch (sendError) {
        this.deps.log.error(`falha ao mandar aviso de erro: ${String(sendError)}`);
      }
      return true;
    } finally {
      this.pendingChats.delete(context.chatJid);
    }
  }

  /** Gera texto; null = falha de provider (chamador trata aviso). */
  private async generateReply(context: WhatsAppMessageContext): Promise<string | null> {
    const ai = this.deps.getAI();
    const turns = this.deps.historyTurns ?? DEFAULT_HISTORY_TURNS;
    const history = this.deps.store.isMemoryEnabled(context.chatJid)
      ? this.deps.store.listMessages(context.chatJid, turns)
      : [];
    const transcript = trimTranscript(buildTranscript(history));
    const apiKey = ai.apiKey !== '' ? ai.apiKey : undefined;
    const messages = buildConversationMessages(transcript);

    this.callsMade += 1;
    try {
      return await this.client.complete({
        baseUrl: ai.baseUrl,
        apiKey,
        model: ai.model,
        messages,
        temperature: ai.temperature,
        maxTokens: ai.maxTokens,
        timeoutMs: ai.timeoutMs,
        stream: true,
      });
    } catch (error) {
      this.callsFailed += 1;
      if (error instanceof ProviderError) this.deps.log.warn(`provider: ${error.message}`);
      else if (error instanceof Error) this.deps.log.warn(`resposta: ${error.message}`);
      const fallback = ai.fallbackModel.trim();
      if (fallback === '' || fallback === ai.model.trim()) return null;
      try {
        this.callsMade += 1;
        this.deps.log.warn(`tentando modelo de reserva: ${fallback}`);
        return await this.client.complete({
          baseUrl: ai.baseUrl,
          apiKey,
          model: fallback,
          messages,
          temperature: ai.temperature,
          maxTokens: ai.maxTokens,
          timeoutMs: ai.timeoutMs,
          stream: true,
        });
      } catch (fallbackError) {
        this.callsFailed += 1;
        this.deps.log.warn(`fallback também falhou: ${String(fallbackError)}`);
        return null;
      }
    }
  }

  /** Botão "Testar IA" do painel — chamada real ao provider. */
  async testGenerate(prompt: string): Promise<AIEngineTestResult> {
    if (!this.canGenerate()) {
      return { ok: false, error: 'IA sem provider/modelo configurado em Configurações' };
    }
    const ai = this.deps.getAI();
    const text = prompt === '' ? 'Manda um oi curtinho para o patrão.' : prompt;
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: text },
    ];
    try {
      const reply = await this.client.complete({
        baseUrl: ai.baseUrl,
        apiKey: ai.apiKey !== '' ? ai.apiKey : undefined,
        model: ai.model,
        messages,
        temperature: ai.temperature,
        maxTokens: Math.min(ai.maxTokens, 256),
        timeoutMs: ai.timeoutMs,
        stream: false,
      });
      this.callsMade += 1;
      return { ok: true, reply };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.log.warn(`teste de IA falhou: ${message}`);
      return { ok: false, error: message };
    }
  }
}
