/**
 * SearchEngine (ETAPA 5): busca sons no MyInstants.
 *
 * O MyInstants não tem API pública — a rota documentada pela comunidade
 * é a página `?name=` parseada (anchors `.instant-link` + `play('...')`).
 * Este módulo raspa com User-Agent identificado, timeout curto e um
 * "gate" de educação (nada de marteleira no site alheio). fail = erro
 * honesto, nunca lista inventada.
 */

export interface InstantHit {
  title: string;
  mp3Url: string;
}

export interface PolitenessDecision {
  ok: boolean;
  waitMs: number;
}

export interface SearchPageFetcher {
  (url: string): Promise<{ status: number; body: string }>;
}

export const MYINSTANTS_BASE = 'https://www.myinstants.com';
export const MYINSTANTS_USER_AGENT =
  'GeraldoMemeEngine/1.0 (WhatsApp bot panel; respeita robots.txt; requisicoes esparsas)';
export const SEARCH_HTML_TIMEOUT_MS = 12_000;
export const MIN_SEARCH_GAP_MS = 2500;

export const SEARCH_URL = `${MYINSTANTS_BASE}/en/search/?name=`;

/** Gate de educação: força intervalo mínimo entre requisições de rede. */
export class PolitenessGate {
  private lastAllowedAt = Number.NEGATIVE_INFINITY;
  constructor(private readonly minGapMs: number = MIN_SEARCH_GAP_MS) {}

  tryPass(nowMs: number = Date.now()): PolitenessDecision {
    const waitMs = this.lastAllowedAt + this.minGapMs - nowMs;
    if (waitMs > 0) {
      return { ok: false, waitMs };
    }
    this.lastAllowedAt = nowMs;
    return { ok: true, waitMs: 0 };
  }
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/&#(\d+);/g, (_, code: string) => {
      const point = Number.parseInt(code, 10);
      return Number.isFinite(point) && point > 0 ? String.fromCodePoint(point) : '';
    });
}

function cleanTitle(raw: string): string {
  const text = decodeEntities(raw.replace(/<[^>]*>/g, ''));
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Parser puro do HTML de resultados (markup real nov/2026):
 * `<div class="instant"> <div class="circle small-button-background">…</div>
 * <button class="small-button" onclick="play('URL', 'loader-i', 'id')"…>
 * … <a …class="instant-link …">TÍTULO</a> …</div>`
 * Cada bloco vai até o próximo `<div class="instant"` — cortar na primeira
 * `</div>` perde o botão e dava zero resultado de boba.
 */
export function parseInstantsHtml(html: string, base: string = MYINSTANTS_BASE): InstantHit[] {
  const chunks = html.split(/<div\s+class="instant"/).slice(1);
  const hits: InstantHit[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    if (hits.length >= 12) break;

    const mp3Match = /play\('([^']+)'/i.exec(chunk);
    if (mp3Match === null) continue;
    const rawUrl = (mp3Match[1] ?? '').trim();
    if (rawUrl === '') continue;

    const innerText = cleanTitle(/class="[^"]*instant-link[^"]*"[^>]*>([^<]*)</.exec(chunk)?.[1] ?? '');
    const titleAttr = cleanTitle(/class="[^"]*instant-link[^"]*"[^>]*\stitle="([^"]*)"/.exec(chunk)?.[1] ?? '');
    const title = innerText !== '' ? innerText : titleAttr;

    let mp3Url: URL;
    try {
      if (/^https?:\/\//i.test(rawUrl)) {
        mp3Url = new URL(rawUrl);
      } else {
        mp3Url = new URL(rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`, base);
      }
    } catch {
      continue;
    }
    mp3Url.protocol = 'https:';

    const key = mp3Url.href;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ title: title === '' ? decodeURIComponent(key.split('/').pop() ?? key) : title, mp3Url: mp3Url.href });
  }
  return hits;
}

/** Busca real: baixa a página de resultados e devolve os sons encontrados. */
export async function searchInstants(
  rawQuery: string,
  fetchPage: SearchPageFetcher,
  timeoutMs = SEARCH_HTML_TIMEOUT_MS,
): Promise<InstantHit[]> {
  const query = rawQuery.trim().slice(0, 80);
  if (query.length < 1) return [];

  const response = await fetchPage(`${SEARCH_URL}${encodeURIComponent(query).replace(/%20/g, '+')}`);
  if (response.status !== 200) {
    throw new Error(
      `MyInstants respondeu HTTP ${String(response.status)} — pode ser bloqueio temporário (Cloudflare); tenta de novo em instantes`,
    );
  }
  return parseInstantsHtml(response.body);
}

/**
 * Adaptador padrão dessas chamadas: fetch global com UA manifesto do
 * Geraldo e timeout honesto (AbortController).
 */
export const myinstantsFetchPage: SearchPageFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_HTML_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': MYINSTANTS_USER_AGENT },
      signal: controller.signal,
    });
    const body = await response.text();
    return { status: response.status, body };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('MyInstants não respondeu a tempo (timeout da busca)');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
