/**
 * MemeEngine (ETAPA 5): sons "instant" do MyInstants.
 *
 * Fluxo: busca (raspagem educada) → importação do mp3 pro catálogo
 * (`media_files`, categoria 'sound') → envio pro WhatsApp como áudio.
 * Tudo com limites honestos (tamanho máximo, timeout, gate) e erro real
 * quando o site bloqueia/não responde — sem lista inventada.
 */

import { existsSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Database } from '../database/database.ts';
import type { ChildLogger } from '../logger/logger.ts';
import {
  MYINSTANTS_USER_AGENT,
  PolitenessGate,
  type InstantHit,
} from '../search/instants.ts';

export const MAX_SOUND_BYTES = 20 * 1024 * 1024;

export interface MemeImportInput {
  title: string;
  url: string;
}

export type FetchBytesResult =
  | { ok: true; bytes: Buffer; contentType: string | null }
  | { ok: false; error: string };

export interface MemeEngineDeps {
  db: Database;
  log: ChildLogger;
  paths: { mediaDir: string };
  /** Busca curada (SearchEngine) — testes injetam fake. */
  search: (query: string) => Promise<InstantHit[]>;
  gate: PolitenessGate;
  sendAudio: (chatJid: string, filePath: string, label: string | null) => Promise<string>;
  fetchBytes?: (url: string) => Promise<FetchBytesResult>;
  nowMs?: () => number;
}

export interface SoundRecord {
  id: string;
  title: string;
  filePath: string;
  sourceUrl: string | null;
  bytes: number | null;
  createdAt: string;
}

function makeStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function slugTitle(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug === '' ? 'som' : slug;
}

/** Baixa o mp3 com UA manifesto + timeout (injetável pra testes). */
export const defaultFetchBytes = (timeoutMs = 45_000) =>
  async (url: string): Promise<FetchBytesResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': MYINSTANTS_USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, error: `fonte respondeu HTTP ${String(response.status)}` };
      }
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > MAX_SOUND_BYTES) {
        return {
          ok: false,
          error: `áudio grande demais (${declared} bytes; teto ${String(MAX_SOUND_BYTES)})`,
        };
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_SOUND_BYTES) {
        return {
          ok: false,
          error: `áudio grande demais (${String(buffer.length)} bytes; teto ${String(MAX_SOUND_BYTES)})`,
        };
      }
      return { ok: true, bytes: buffer, contentType: response.headers.get('content-type') };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, error: 'fonte não respondeu a tempo (timeout do download)' };
      }
      return { ok: false, error: describeError(error) };
    } finally {
      clearTimeout(timer);
    }
  };

export class MemeEngine {
  private readonly deps: MemeEngineDeps;

  constructor(deps: MemeEngineDeps) {
    this.deps = deps;
  }

  /** Busca REAL; gate de educação → recusa com espera pacífica (route vira 429). */
  async search(
    rawQuery: string,
  ): Promise<{ ok: false; waitMs: number } | { ok: true; items: InstantHit[] }> {
    const query = rawQuery.trim().slice(0, 80);
    if (query.length < 1) {
      throw new Error('pesquisa vazia — manda um nome de som');
    }
    const gate = this.deps.gate.tryPass(this.deps.nowMs?.() ?? Date.now());
    if (!gate.ok) {
      return { ok: false, waitMs: gate.waitMs };
    }
    const items = await this.deps.search(query);
    this.deps.log.info(`busca de sons "${query}": ${String(items.length)} resultado(s)`);
    return { ok: true, items };
  }

  /**
   * Importa um mp3 do MyInstants pro catálogo. URL tem que ser do próprio
   * site (host *.myinstants.com e caminho /media/sounds/) — nada de proxy
   * sorrateiro pra qualquer endereço.
   */
  async importSound(input: MemeImportInput): Promise<{ ok: false; waitMs: number } | { ok: true; id: string }> {
    const url = input.url.trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('URL inválida');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('URL do MyInstants deve ser https://');
    }
    if (!parsed.hostname.endsWith('myinstants.com') || !parsed.pathname.startsWith('/media/sounds/')) {
      throw new Error('URL não é um arquivo de som do MyInstants (/media/sounds/)');
    }

    const gate = this.deps.gate.tryPass(this.deps.nowMs?.() ?? Date.now());
    if (!gate.ok) {
      return { ok: false, waitMs: gate.waitMs };
    }

    const fetchBytes = this.deps.fetchBytes ?? defaultFetchBytes();
    const fetched = await fetchBytes(url);
    if (!fetched.ok) {
      throw new Error(`falhou ao baixar o som: ${fetched.error}`);
    }

    const title = input.title.trim().slice(0, 200) || 'som';
    mkdirSync(this.deps.paths.mediaDir, { recursive: true });
    const ext = parsed.pathname.toLowerCase().endsWith('.ogg') ? '.ogg' : '.mp3';
    const base = `som-${slugTitle(title)}-${makeStamp()}`;
    let target = join(this.deps.paths.mediaDir, `${base}${ext}`);
    if (existsSync(target)) {
      target = join(this.deps.paths.mediaDir, `${base}-${randomBytes(3).toString('hex')}${ext}`);
    }
    writeFileSync(target, fetched.bytes);
    const id = `${makeStamp()}-${randomBytes(6).toString('hex')}`;
    const createdAt = new Date().toISOString();
    this.deps.db
      .prepare(
        'INSERT INTO media_files (id, chat, category, source_url, file_path, mime, bytes, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, 'sound', url, target, ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg', fetched.bytes.length, createdAt);
    this.deps.log.info(`som importado: ${title} (${String(fetched.bytes.length)} bytes) de ${url}`);
    return { ok: true, id };
  }

  listSounds(limit = 50): SoundRecord[] {
    const capped = Math.min(Math.max(limit, 1), 200);
    const rows = this.deps.db
      .prepare("SELECT * FROM media_files WHERE category = 'sound' ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(capped) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row['id']),
      title: titleFromPath(String(row['file_path'])),
      filePath: String(row['file_path']),
      sourceUrl: row['source_url'] === null ? null : String(row['source_url']),
      bytes: row['bytes'] === null ? null : Number(row['bytes']),
      createdAt: String(row['created_at']),
    }));
  }

  getSound(id: string): SoundRecord | null {
    const row = this.deps.db
      .prepare("SELECT * FROM media_files WHERE id = ? AND category = 'sound'")
      .get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      id: String(row['id']),
      title: titleFromPath(String(row['file_path'])),
      filePath: String(row['file_path']),
      sourceUrl: row['source_url'] === null ? null : String(row['source_url']),
      bytes: row['bytes'] === null ? null : Number(row['bytes']),
      createdAt: String(row['created_at']),
    };
  }

  /** Manda o som catalogado como áudio no WhatsApp. Erros caem honestos. */
  async send(soundId: string, chatJid: string): Promise<{ ok: true; wamid: string; title: string }> {
    const sound = this.getSound(soundId);
    if (sound === null) {
      throw new Error('som não encontrado no catálogo');
    }
    if (!existsSync(sound.filePath)) {
      throw new Error('o arquivo do som sumiu do disco');
    }
    if (chatJid.trim().length < 5 || !chatJid.includes('@')) {
      throw new Error('jid de destino inválido');
    }
    const wamid = await this.deps.sendAudio(chatJid.trim(), sound.filePath, sound.title);
    return { ok: true, wamid, title: sound.title };
  }

  remove(id: string): boolean {
    const sound = this.getSound(id);
    if (sound === null) return false;
    try {
      if (existsSync(sound.filePath)) rmSync(sound.filePath, { force: true });
      this.deps.db.prepare("DELETE FROM media_files WHERE id = ? AND category = 'sound'").run(id);
      return true;
    } catch {
      return false;
    }
  }
}

function titleFromPath(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const stem = name.replace(/^som-/, '').replace(/\.(mp3|ogg)$/i, '');
  return stem;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tamanho real do arquivo (útil pro painel exibir). */
export function soundSize(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}
