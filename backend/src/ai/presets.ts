import type { AIProviderName } from '../config/types.ts';

/**
 * Presets públicos de provedor — SEM segredos (só IDs/URLs/documentação).
 * A escolha fica no painel; API key sempre entra manual e nunca em log/git.
 */
export interface AiProviderPreset {
  id: AIProviderName;
  label: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  needsApiKey: boolean;
  apiKeyHint: string;
  notes: string;
}

export const AI_PRESETS: AiProviderPreset[] = [
  {
    id: 'groq',
    label: 'Groq — gpt-oss-120b (grátis, rápido)',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    fallbackModel: 'qwen/qwen3.8-27b',
    needsApiKey: true,
    apiKeyHint: 'console.groq.com/keys (plano grátis, sem cartão)',
    notes:
      'Plano gratuito permanente: 30 req/min, ~1.000 req/dia, 8K tokens/min. ' +
      'gpt-oss-120b suporta tool use, JSON mode, reasoning e streaming (docs Groq). ' +
      'Sem visão no plano grátis no momento.',
  },
  {
    id: 'gemini',
    label: 'Google AI Studio — Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.8-flash',
    fallbackModel: 'gemini-3.5-flash-lite',
    needsApiKey: true,
    apiKeyHint: 'aistudio.google.com/apikey (chave grátis)',
    notes:
      'Endpoint OpenAI-compat do Google. Cotas grátis por modelo/projeto ' +
      '(gemini-3.8-flash pequena ~20/dia; Flash-Lite maior ~500/dia). ' +
      'Qualidade alta com visão nativa; fallback Flash-Lite cobre volume.',
  },
  {
    id: 'zai',
    label: 'Z.ai — GLM Flash ($0)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-4.7-flash',
    fallbackModel: 'glm-4.5-flash',
    needsApiKey: true,
    apiKeyHint: 'z.ai (portal internacional, e-mail; sem cartão)',
    notes:
      'Linha GLM Flash é $0/token permanente. Limites por concorrência da conta. ' +
      'Visão disponível no glm-4.6v-flash (também $0). Respeita plano/local.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter — GLM-5.3-flash-free (preservado)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'z-ai/glm-5.3-flash-free',
    fallbackModel: 'nvidia/nemotron-3.5-lightning:free',
    needsApiKey: true,
    apiKeyHint: 'openrouter.ai/keys (50 req/dia grátis; 1.000/dia após US$ 10 uma vez)',
    notes:
      'Agregador multimodelo. Preset mantém o GLM que já roda no projeto como opção. ' +
      'Modelos :free variam; capacidade compartilhada oscila em horário pico.',
  },
  {
    id: 'ollama',
    label: 'Ollama local (sem internet)',
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    fallbackModel: 'llama3.2:1b',
    needsApiKey: false,
    apiKeyHint: '',
    notes:
      'Roda no próprio mini-PC (i5-2400) — privacidade total, sem cota, ' +
      'mas qualidade e velocidade dependem do modelo pequeno local.' +
      ' Comando: ollama pull llama3.2. Caminho /v1/chat/completions já somado.',
  },
  {
    id: 'openai',
    label: 'API compatível OpenAI (custom)',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    fallbackModel: '',
    needsApiKey: true,
    apiKeyHint: 'sua própria chave de serviço compatível OpenAI',
    notes: 'Gateway genérico: qualquer /v1/chat/completions funciona aqui.',
  },
  {
    id: 'disabled',
    label: 'Sem IA (padrão — bot não responde além do caderno)',
    baseUrl: '',
    model: '',
    fallbackModel: '',
    needsApiKey: false,
    apiKeyHint: '',
    notes: 'Comportamento honesto da ETAPA 2: saudação no privado, grupos em silêncio.',
  },
];
