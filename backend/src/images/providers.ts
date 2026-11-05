/**
 * Adaptadores de GERAÇÃO DE IMAGEM (ETAPA 7) por provedor de IA já
 * configurado no painel. "Quando tem serviço disponível" — sem provedor
 * capaz, erro honesto (nunca imagem mockada).
 *
 * Contratos reais (docs oficiais, revisados 05/11/2026):
 * - Z.ai GLM-Image: POST {baseUrl}/images/generations (Bearer) →
 *   `{ data: [{ url }] }` — URL TEMPORÁRIA (expira em 30 dias): baixar
 *   na hora. Custo publicado: US$ 0.015/imagem (hd ~20 s, standard
 *   5-10 s). Modelos: 'glm-image' (padrão) / linha CogView legada.
 * - Gemini (Google): POST https://generativelanguage.googleapis.com/
 *   v1beta/interactions com headers `x-goog-api-key` +
 *   `Api-Revision: 2026-05-20`; corpo `{ model, input }`; imagem sai
 *   em `output_image`.`data` (base64) — série "Nano Banana"
 *   (`gemini-nano-banana-2.1` primary). Cota grátis varia por
 *   conta/modelo — erro de cota vem honesto do provedor.
 * - OpenAI-compat custom: POST {baseUrl}/images/generations →
 *   `data[0].b64_json` (gpt-image-1) ou `data[0].url`. Modelo fica a
 *   cargo do dono da chave (campo model da config de IA).
 * Outros provedores (groq/ollama/openrouter/disabled) não têm geração
 * de imagem estável documentada → não prometido aqui.
 */

import type { AIProviderName } from '../config/types.ts';

/** Provedores com geração de imagem de verdade suportada aqui. */
export const IMAGE_CAPABLE_PROVIDERS: readonly AIProviderName[] = ['zai', 'gemini', 'openai'];

export interface ImageGenerationDeps {
  provider: AIProviderName;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  model: string;
}

export interface GeneratedImagePayload {
  /** Bytes da imagem (PNG/JPEG — magic detectado depois). */
  bytes: Buffer;
  provider: string;
  model: string;
}

const GEMINI_API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
/** Revisão da API "interactions" que traz saída de imagem nativa. */
const GEMINI_API_REVISION = '2026-05-20';
/** Modelo default da série documentada como "primary workhorse". */
export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-nano-banana-2.1';
export const ZAI_IMAGE_MODEL = 'glm-image';

export function describeImageSupport(provider: AIProviderName): { capable: boolean; hint: string | null } {
  if (provider === 'disabled') {
    return {
      capable: false,
      hint: 'IA desabilitada — escolha provedor em Configurações (zai, gemini ou openai-compat suportados p/ imagem)',
    };
  }
  if (provider === 'ollama') {
    return {
      capable: false,
      hint: 'Ollama local não tem gerador de imagem estável — troque o provedor p/ zai/gemini/openai-compat',
    };
  }
  if (provider === 'groq') {
    return {
      capable: false,
      hint: 'Groq não expõe geração de imagem no plano atual — use zai (GLM-Image) ou gemini',
    };
  }
  if (provider === 'openrouter') {
    return {
      capable: false,
      hint: 'OpenRouter free alternante p/ imagem — prefira zai (api.z.ai, US$ 0.015/imagem) ou gemini nativo',
    };
  }
  return { capable: true, hint: null };
}

export interface ImageApiFetch {
  (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean;
    status: number;
    json: unknown;
  }>;
}

/* ── Extratores puros (testáveis sem rede) ──────────────────────────── */

/** `{ data: [{ url }] }` do Z.ai (OpenAI-like) — null quando veio deforma torta. */
export function extractZaiPayloadUrl(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record['data']) || (record['data'] as unknown[]).length === 0) return null;
  const first = (record['data'] as unknown[])[0];
  if (first === null || typeof first !== 'object') return null;
  const url = (first as Record<string, unknown>)['url'];
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
}

/** Extrai dados base64 de imagem de uma resposta do Gemini "interactions". */
function inlineImageFromNode(node: unknown): { data: string; mime: string } | null {
  if (node === null || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  // Formato Novo (interactions): { type: 'image', data, mime_type }
  const data = record['data'];
  const mime = record['mime_type'] ?? record['mimeType'];
  if (typeof data === 'string' && typeof mime === 'string' && mime.startsWith('image/')) {
    return { data, mime };
  }
  // Formato generateContent clássico: { inlineData: { mimeType, data } }
  const inline = record['inlineData'];
  if (inline !== null && typeof inline === 'object') {
    const inlineRecord = inline as Record<string, unknown>;
    const inlineMime = inlineRecord['mimeType'];
    const inlineData = inlineRecord['data'];
    if (typeof inlineMime === 'string' && typeof inlineData === 'string' && inlineMime.startsWith('image/')) {
      return { data: inlineData, mime: inlineMime };
    }
  }
  return null;
}

/**
 * Procurar imagem na resposta do Gemini: raiz `output_image` primeiro
 * (documentado), depois varredura honesta por qualquer bloco de imagem
 * inline (formatos variam entre revisões — nunca devolve invented).
 */
export function extractGeminiImage(payload: unknown): { data: string; mime: string } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;
  const direct = inlineImageFromNode(root['output_image']);
  if (direct !== null) return direct;
  const seen = new Set<unknown>();
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const found = inlineImageFromNode(node);
    if (found !== null) return found;
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) queue.push(value);
    }
  }
  return null;
}

/* ── Adaptadores reais (rede) ───────────────────────────────────────── */

async function fetchJson(
  fetch: ImageApiFetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`provedor respondeu HTTP ${String(response.status)}`);
  }
  return { status: response.status, json: response.json };
}

/** Detecta MIME real pelo magic bytes (provedores mentem com content-type). */
export function sniffImageMime(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return 'image/jpeg';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii').toLowerCase() === 'riff') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

/** Gera com o provedor aceite e devolve bytes da imagem (sem salvar em disco aqui). */
export async function generateWithProvider(
  deps: ImageGenerationDeps,
  fetchHttp: ImageApiFetch,
  fetchBinary: (url: string) => Promise<Buffer>,
  prompt: string,
): Promise<GeneratedImagePayload> {
  if (!IMAGE_CAPABLE_PROVIDERS.includes(deps.provider)) {
    const support = describeImageSupport(deps.provider);
    throw new Error(support.hint ?? 'provedor sem geração de imagem');
  }
  if (deps.apiKey.trim() === '') {
    throw new Error('chave de API vazia — Configure o provedor em Configurações (sem chave não há imagem)');
  }

  if (deps.provider === 'zai') {
    const base = deps.baseUrl === '' ? 'https://api.z.ai/api/paas/v4' : deps.baseUrl.replace(/\/+$/, '');
    const { json } = await fetchJson(
      fetchHttp,
      `${base}/images/generations`,
      { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' },
      { model: ZAI_IMAGE_MODEL, prompt, size: '1280x1280', quality: 'standard' },
    );
    const url = extractZaiPayloadUrl(json);
    if (url === null) {
      throw new Error('provedor não devolveu URL de imagem — resposta inesperada honesta');
    }
    const bytes = await fetchBinary(url); // link expira em 30 dias: baixa agora
    return { bytes, provider: 'zai', model: ZAI_IMAGE_MODEL };
  }

  if (deps.provider === 'gemini') {
    const model = deps.model.trim() === '' ? DEFAULT_GEMINI_IMAGE_MODEL : deps.model.trim();
    const { json } = await fetchJson(
      fetchHttp,
      `${GEMINI_API_ROOT}/interactions`,
      {
        'x-goog-api-key': deps.apiKey,
        'content-type': 'application/json',
        'Api-Revision': GEMINI_API_REVISION,
      },
      { model, input: [{ type: 'text', text: prompt }] },
    );
    const image = extractGeminiImage(json);
    if (image === null) {
      throw new Error('resposta do Gemini veio sem imagem — nada inventado aqui');
    }
    return { bytes: Buffer.from(image.data, 'base64'), provider: 'gemini', model };
  }

  // openai-compat custom
  const base = deps.baseUrl === '' ? 'https://api.openai.com/v1' : deps.baseUrl.replace(/\/+$/, '');
  const model = deps.model.trim() === '' ? 'gpt-image-1' : deps.model.trim();
  const { json } = await fetchJson(
    fetchHttp,
    `${base}/images/generations`,
    { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json' },
    { model, prompt, size: '1024x1024' },
  );
  const record = json as Record<string, unknown> | null;
  const entries = record !== null && Array.isArray(record['data']) ? (record['data'] as unknown[]) : [];
  const first = entries[0];
  if (first !== null && typeof first === 'object') {
    const b64 = (first as Record<string, unknown>)['b64_json'];
    if (typeof b64 === 'string' && b64.length > 0) {
      return { bytes: Buffer.from(b64, 'base64'), provider: 'openai', model };
    }
    const url = (first as Record<string, unknown>)['url'];
    if (typeof url === 'string' && url.startsWith('http')) {
      const bytes = await fetchBinary(url);
      return { bytes, provider: 'openai', model };
    }
  }
  throw new Error('resposta do provedor openai-compat veio sem imagem (b64_json/url)');
}
