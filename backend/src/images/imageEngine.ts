/**
 * ImageEngine (ETAPA 7): prompt → imagem no provedor de IA configurado.
 *
 * "Gera imagens quando tem serviço disponível" — sem provedor capaz ou
 * sem chave, erro honesto (nunca mock). Imagens vão pro catálogo
 * `media_files` (category 'image') com metadados em `image_meta`
 * (prompt/provedor/modelo/tamanho). Uma geração por vez (provedor
 * demora 5-20 s); SEM cache — prompt repetido gera imagem nova de
 * propósito (imagens são únicas por natureza).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database } from '../database/database.ts';
import type { ChildLogger } from '../logger/logger.ts';
import type { AISettings } from '../config/types.ts';
import { slugTitle } from '../media/memeEngine.ts';
import {
  DEFAULT_GEMINI_IMAGE_MODEL,
  ZAI_IMAGE_MODEL,
  describeImageSupport,
  generateWithProvider,
  sniffImageMime,
  type ImageApiFetch,
  type ImageGenerationDeps,
} from './providers.ts';

/** Teto de download da imagem final ( Golm-Image 1280² hd cabe com folga). */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export const MAX_PROMPT_CHARS = 1000;

export interface ImageEngineDeps {
  db: Database;
  log: ChildLogger;
  paths: { mediaDir: string };
  /** Config de IA do painel (provider/baseUrl/apiKey/timeoutMs/model). */
  getAI(): AISettings;
  sendImage: (chatJid: string, filePath: string, caption: string | null) => Promise<string>;
  /** HTTP p/ as APIs de geração — injetável pros testes. */
  fetchHttp?: ImageApiFetch;
  /** Download p/ URL temporária do provedor — injetável pros testes. */
  fetchBinary?: (url: string) => Promise<Buffer>;
}

export interface ImageStatus {
  provider: AISettings['provider'];
  capable: boolean;
  ready: boolean;
  hint: string | null;
  modelName: string;
  costNote: string | null;
}

export interface ImageRecord {
  id: string;
  title: string;
  prompt: string;
  provider: string;
  model: string;
  size: string | null;
  mime: string | null;
  bytes: number | null;
  filePath: string;
  createdAt: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function extForMime(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/webp') return '.webp';
  return '.png';
}

/** HTTP real com timeout vindo da config de IA. */
function makeHttpFetch(timeoutMs: number): ImageApiFetch {
  return async (url, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, 1_000));
    timer.unref?.();
    try {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        json = { raw: '(resposta não-JSON do provedor)' };
      }
      return { ok: response.ok, status: response.status, json };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Download real com teto honesto (URL provisória do provedor não pode estourar disco). */
async function defaultFetchBinary(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'GeraldoAI/1.0 (painel de imagens; download da imagem gerada)' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`download da imagem falhou com HTTP ${String(response.status)}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error(`imagem passou do teto (${String(MAX_IMAGE_BYTES)} bytes) — recusada`);
    }
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

export const ZAI_IMAGE_COST_NOTE = 'GLM-Image: US$ 0.015/imagem (preço oficial z.ai 05/11/2026) — consumido da sua chave';

export class ImageEngine {
  private readonly deps: ImageEngineDeps;
  private genBusy = false;

  constructor(deps: ImageEngineDeps) {
    this.deps = deps;
  }

  status(): ImageStatus {
    const ai = this.deps.getAI();
    const support = describeImageSupport(ai.provider);
    const modelName =
      ai.provider === 'openai'
        ? ai.model.trim() === ''
          ? 'gpt-image-1'
          : ai.model.trim()
        : ai.provider === 'gemini'
          ? DEFAULT_GEMINI_IMAGE_MODEL
          : ai.provider === 'zai'
            ? ZAI_IMAGE_MODEL
            : '';
    const costNote =
      ai.provider === 'zai'
        ? ZAI_IMAGE_COST_NOTE
        : ai.provider === 'gemini'
          ? 'cota do AI Studio por conta/modelo — erro de cota voltaria honesto'
          : null;
    const missingKey = support.capable && ai.apiKey.trim() === '';
    return {
      provider: ai.provider,
      capable: support.capable,
      ready: support.capable && !missingKey,
      hint:
        support.hint ??
        (missingKey ? 'chave de API vazia — coloca a chave do provedor em Configurações' : null),
      modelName,
      costNote,
    };
  }

  /**
   * Gera uma imagem com o provedor configurado; devolve o registro do
   * catálogo. Uma por vez (lock) — segunda chamada enquanto roda erra
   * honesta (rota vira 409).
   */
  async generate(rawPrompt: string, rawSize?: string): Promise<ImageRecord> {
    const prompt = rawPrompt.trim();
    if (prompt.length < 1) {
      throw new Error('prompt vazio — descreve a imagem');
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`prompt passa de ${String(MAX_PROMPT_CHARS)} caracteres`);
    }
    const size = this.normalizeSize(rawSize);

    if (this.genBusy) {
      throw new Error('imagem já sendo gerada — espera a fila andar (uma por vez)');
    }
    this.genBusy = true;
    try {
      const ai = this.deps.getAI();
      const callDeps: ImageGenerationDeps = {
        provider: ai.provider,
        baseUrl: ai.baseUrl,
        apiKey: ai.apiKey,
        timeoutMs: ai.timeoutMs,
        // No gateway openai-compat o modelo é do dono da chave (config de IA);
        // zai/gemini usam modelos de imagem fixos e documentados no status.
        model: ai.provider === 'openai' ? ai.model : '',
      };
      const made = await generateWithProvider(
        callDeps,
        this.deps.fetchHttp ?? makeHttpFetch(ai.timeoutMs),
        this.deps.fetchBinary ?? defaultFetchBinary,
        prompt,
      );

      const mime = sniffImageMime(made.bytes);
      if (mime === 'application/octet-stream') {
        throw new Error('provedor devolveu bytes que não parecem imagem — nada salvo');
      }

      mkdirSync(this.deps.paths.mediaDir, { recursive: true });
      const stamp = makeStamp();
      const rand = randomBytes(3).toString('hex');
      const clipId = `${stamp}-${rand}`;
      const fileName = `img-${slugTitle(prompt)}-${stamp}-${rand}${extForMime(mime)}`;
      const filePath = join(this.deps.paths.mediaDir, fileName);
      writeFileSync(filePath, made.bytes);
      const bytes = statSync(filePath).size;
      const createdAt = new Date().toISOString();

      this.deps.db
        .prepare(
          `INSERT INTO media_files (id, chat, category, source_url, file_path, mime, bytes, created_at)
           VALUES (?, NULL, 'image', NULL, ?, ?, ?, ?)`,
        )
        .run(clipId, filePath, mime, bytes, createdAt);
      this.deps.db
        .prepare(
          'INSERT INTO image_meta (id, prompt, provider, model, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(clipId, prompt, made.provider, made.model, size ?? null, createdAt);

      const preview = prompt.length > 48 ? `${prompt.slice(0, 45)}…` : prompt;
      this.deps.log.info(`imagem gerada: "${preview}" com ${made.provider}/${made.model} (${String(bytes)} bytes)`);
      return this.getImage(clipId) ?? {
        id: clipId,
        title: fileName,
        prompt,
        provider: made.provider,
        model: made.model,
        size: size ?? null,
        mime,
        bytes,
        filePath,
        createdAt,
      };
    } finally {
      this.genBusy = false;
    }
  }

  /** Grid do painel: imagens mais novas primeiro com metadados completos. */
  listImages(limit = 50): ImageRecord[] {
    const capped = Math.min(Math.max(limit, 1), 200);
    const rows = this.deps.db
      .prepare(
        `SELECT m.id AS id, m.file_path AS file_path, m.mime AS mime, m.bytes AS bytes,
                m.created_at AS created_at, i.prompt AS prompt, i.provider AS provider,
                i.model AS model, i.size AS size
         FROM media_files m JOIN image_meta i ON i.id = m.id
         WHERE m.category = 'image'
         ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      )
      .all(capped) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRecord(row));
  }

  getImage(id: string): ImageRecord | null {
    const row = this.deps.db
      .prepare(
        `SELECT m.id AS id, m.file_path AS file_path, m.mime AS mime, m.bytes AS bytes,
                m.created_at AS created_at, i.prompt AS prompt, i.provider AS provider,
                i.model AS model, i.size AS size
         FROM media_files m JOIN image_meta i ON i.id = m.id
         WHERE m.id = ? AND m.category = 'image'`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return this.rowToRecord(row);
  }

  /** Manda no chat como imagem com legenda opcional. Erros caem honestos. */
  async send(imageId: string, chatJid: string, caption?: string): Promise<{ ok: true; wamid: string }> {
    const image = this.getImage(imageId);
    if (image === null) {
      throw new Error('imagem não encontrada no catálogo');
    }
    if (!existsSync(image.filePath)) {
      throw new Error('o arquivo de imagem sumiu do disco');
    }
    if (chatJid.trim().length < 5 || !chatJid.includes('@')) {
      throw new Error('jid de destino inválido');
    }
    const wamid = await this.deps.sendImage(chatJid.trim(), image.filePath, caption ?? null);
    return { ok: true, wamid };
  }

  private normalizeSize(rawSize?: string): string | null {
    if (rawSize === undefined || rawSize.trim() === '') return null;
    const size = rawSize.trim();
    if (!/^\d{3,4}x\d{3,4}$/.test(size)) {
      throw new Error('tamanho tem que ser LARGURAxALTURA (ex.: 1280x1280) — só se aplica ao GLM-Image');
    }
    const dims = size.split('x').map((part) => Number(part));
    const w = dims[0] ?? 0;
    const h = dims[1] ?? 0;
    if (w < 512 || h < 512 || w > 2048 || h > 2048) {
      throw new Error('tamanho limitado a 512–2048 px por lado — o provedor aceita isso');
    }
    return size;
  }

  private rowToRecord(row: Record<string, unknown>): ImageRecord {
    const prompt = String(row['prompt']);
    const stamp = new Date(String(row['created_at']));
    const pad = (n: number): string => String(n).padStart(2, '0');
    const stampText = Number.isNaN(stamp.getTime())
      ? String(row['created_at'])
      : `${pad(stamp.getHours())}:${pad(stamp.getMinutes())} ${pad(stamp.getDate())}/${pad(stamp.getMonth() + 1)}`;
    return {
      id: String(row['id']),
      title: stampText,
      prompt,
      provider: String(row['provider']),
      model: String(row['model']),
      size: row['size'] === null ? null : String(row['size']),
      mime: row['mime'] === null ? null : String(row['mime']),
      bytes: row['bytes'] === null ? null : Number(row['bytes']),
      filePath: String(row['file_path']),
      createdAt: String(row['created_at']),
    };
  }
}
