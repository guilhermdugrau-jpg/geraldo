/**
 * VoiceEngine (ETAPA 6): texto → voz com Piper TTS local.
 *
 * Pipeline: texto (stdin) → piper → WAV 22050 mono → ffmpeg → OGG Opus
 * 16 kHz mono (formato de nota de voz do WhatsApp) → catálogo
 * `media_files` (category 'voice'). Um sintetizado por vez (i5-2400)
 * e cache por hash (mesmo texto+voz não re-sintetiza).
 */

import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { Database } from '../database/database.ts';
import type { ChildLogger } from '../logger/logger.ts';
import {
  PIPER_PT_BR_VOICES,
  listVoiceFiles,
  piperZipUrl,
  pingFileUrls,
  resolveVoiceTools,
  type PiperTool,
  type VoiceModel,
  type VoiceTools,
} from './tools.ts';

export const MAX_VOICE_TEXT_CHARS = 400;
/** Teto de download: zip do piper (22 MB) e vozes (~63 MB) cabem folgados. */
export const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;

export interface VoiceEngineDeps {
  db: Database;
  log: ChildLogger;
  paths: { piperDir: string; voicesDir: string; mediaDir: string };
  env?: NodeJS.ProcessEnv;
  /** ffmpeg resolver do MediaEngine (ETAPA 4) — convertido pra OGG. */
  resolveFfmpeg: () => Promise<string | null>;
  sendVoiceNote: (chatJid: string, filePath: string, label: string | null) => Promise<string>;
  fetchBinary?: (url: string, destPath: string) => Promise<void>;
  /** Injetável pros testes — default spawn real do piper. */
  synthRun?: (args: SynthesisRunArgs) => Promise<void>;
  /** Injetável pros testes — default spawn real do ffmpeg (WAV → OGG Opus). */
  convertAudio?: (wavPath: string, oggPath: string) => Promise<void>;
  /** Injetável pros testes — default resolve piper via status/PATH/env. */
  resolvePiperPath?: () => Promise<string | null>;
}

export interface SynthesisRunArgs {
  piperPath: string;
  modelPath: string;
  text: string;
  wavPath: string;
}

export interface VoiceToolState {
  piper: PiperTool;
  voices: VoiceModel[];
  hint: string | null;
  ready: boolean;
}

export interface VoiceClip {
  id: string;
  title: string;
  filePath: string;
  bytes: number | null;
  createdAt: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class VoiceEngine {
  private readonly deps: VoiceEngineDeps;
  private synthBusy = false;
  private installBusy = false;
  private cache = new Map<string, string>(); // hash → media_files id

  constructor(deps: VoiceEngineDeps) {
    this.deps = deps;
  }

  async status(): Promise<VoiceToolState> {
    const tools = await resolveVoiceTools({
      env: this.deps.env ?? process.env,
      piperDir: this.deps.paths.piperDir,
      voicesDir: this.deps.paths.voicesDir,
    });
    const ready = tools.piper.piperPath !== null && tools.voices.length > 0;
    return {
      piper: tools.piper,
      voices: tools.voices,
      hint: tools.hint,
      ready,
    };
  }

  /** Instala piper + uma voz de escolha (honesto: baixado do HF/GitHub). */
  async installAssets(voiceId = 'pt_BR-faber-medium'): Promise<void> {
    if (this.installBusy) {
      throw new Error('instalação já em andamento — acompanha nos logs');
    }
    this.installBusy = true;
    try {
      await this.ensurePiperBinary();
      await this.downloadVoice(voiceId);
    } finally {
      this.installBusy = false;
    }
  }

  private async ensurePiperBinary(): Promise<void> {
    const probes = [
      join(this.deps.paths.piperDir, 'piper', 'piper.exe'),
      join(this.deps.paths.piperDir, 'piper.exe'),
    ];
    for (const probe of probes) {
      if (existsSync(probe)) {
        this.deps.log.info(`piper já existia em ${probe} — pulo o download`);
        return;
      }
    }
    const url = piperZipUrl();
    const zipPath = join(this.deps.paths.piperDir, 'piper.zip');
    mkdirSync(this.deps.paths.piperDir, { recursive: true });
    this.deps.log.info(`baixando piper: ${url}`);
    await (this.deps.fetchBinary ?? downloadBinary)(url, zipPath);
    await extractZip(zipPath, this.deps.paths.piperDir);
    unlinkSync(zipPath);
    for (const probe of probes) {
      if (existsSync(probe)) {
        this.deps.log.info(`piper extraído em ${probe}`);
        return;
      }
    }
    throw new Error('zip baixado mas piper.exe não apareceu — instalação honestamente falhou');
  }

  async downloadVoice(voiceId: string): Promise<void> {
    const urls = pingFileUrls(voiceId);
    if (urls === null) {
      throw new Error(`voz desconhecida: ${voiceId} (opções: ${PIPER_PT_BR_VOICES.map((v) => v.id).join(', ')})`);
    }
    mkdirSync(this.deps.paths.voicesDir, { recursive: true });
    const onnxPath = join(this.deps.paths.voicesDir, `${voiceId}.onnx`);
    const jsonPath = join(this.deps.paths.voicesDir, `${voiceId}.onnx.json`);
    if (existsSync(onnxPath) && existsSync(jsonPath)) {
      this.deps.log.info(`voz ${voiceId} já instalada`);
      return;
    }
    this.deps.log.info(`baixando voz ${voiceId}...`);
    await (this.deps.fetchBinary ?? downloadBinary)(urls.onnx, onnxPath);
    await (this.deps.fetchBinary ?? downloadBinary)(urls.json, jsonPath);
    const size = statSync(onnxPath).size;
    if (size < 10_000_000) {
      throw new Error(`vozes são ~60 MB e a baixada veio com ${String(size)} bytes — download injurioso`);
    }
    this.deps.log.info(`voz ${voiceId} instalada (${String(size)} bytes)`);
  }

  /**
   * Sintetiza texto com a voz pedida (default: a primeira instalada).
   * Retorna o id no catálogo (cache por texto+voz).
   */
  async synthesize(rawText: string, voiceId?: string): Promise<{ id: string; voice: string; cached: boolean }> {
    const text = rawText.trim();
    if (text.length < 1) {
      throw new Error('texto vazio — manda uma fala');
    }
    if (text.length > MAX_VOICE_TEXT_CHARS) {
      throw new Error(`texto passa de ${String(MAX_VOICE_TEXT_CHARS)} caracteres — curta a prosa`);
    }

    const voices = listVoiceFiles(this.deps.paths.voicesDir);
    if (voices.length === 0) {
      throw new Error('nenhuma voz instalada — "Instalar Piper + voz" no painel (ou env GERALDO_PIPER/vozes)');
    }
    const wantsSpecific = voiceId !== undefined && voiceId.trim() !== '';
    const requested = wantsSpecific ? voices.find((v) => v.id === voiceId) : undefined;
    if (wantsSpecific && requested === undefined) {
      throw new Error(`voz ${voiceId} não instalada — opções: ${voices.map((v) => v.id).join(', ')}`);
    }
    const voice = requested ?? voices[0];
    if (voice === undefined) {
      throw new Error('nenhuma voz instalada — "Instalar Piper + voz" no painel (ou env GERALDO_PIPER/vozes)');
    }

    const hash = createHash('sha256').update(`${voice.id}::${text}`).digest('hex').slice(0, 24);
    const cachedId = this.cache.get(hash);
    if (cachedId !== undefined) {
      const existing = this.getClip(cachedId);
      if (existing !== null && existsSync(existing.filePath)) {
        return { id: cachedId, voice: voice.id, cached: true };
      }
      this.cache.delete(hash);
    }

    if (this.synthBusy) {
      throw new Error('voz já sintetizando — espera a fila andar (uma por vez, máquina fraca)');
    }
    this.synthBusy = true;
    let clipId: string;
    try {
      const piperPath = await this.piperPathOrThrow();

      mkdirSync(this.deps.paths.mediaDir, { recursive: true });
      const stamp = makeStamp();
      const rand = randomBytes(3).toString('hex');
      const oggName = `voz-${stamp}-${rand}.ogg`;
      const oggPath = join(this.deps.paths.mediaDir, oggName);
      const tmpDir = join(this.deps.paths.mediaDir, `voice-${stamp}-${rand}`);
      const wavPath = join(tmpDir, 'fala.wav');
      mkdirSync(tmpDir, { recursive: true });

      const run = this.deps.synthRun ?? defaultSynthRun;
      await run({ piperPath, modelPath: voice.filePath, text, wavPath });

      if (this.deps.convertAudio !== undefined) {
        await this.deps.convertAudio(wavPath, oggPath);
      } else {
        const ffmpegPath = await this.deps.resolveFfmpeg();
        if (ffmpegPath === null) {
          throw new Error('ffmpeg ausente — instale yt-dlp (winget) que traz ffmpeg junto');
        }
        await defaultConvertAudio(ffmpegPath, wavPath, oggPath);
      }
      try { rmDirSafe(tmpDir); } catch { /* tmp fica pra limpeza futura */ }

      clipId = `${stamp}-${rand}`;
      const createdAt = new Date().toISOString();
      const bytes = statSync(oggPath).size;
      this.deps.db
        .prepare('INSERT INTO media_files (id, chat, category, source_url, file_path, mime, bytes, created_at) VALUES (?, NULL, ?, NULL, ?, ?, ?, ?)')
        .run(clipId, 'voice', oggPath, 'audio/ogg', bytes, createdAt);
      const preview = text.length > 48 ? `${text.slice(0, 45)}…` : text;
      this.deps.log.info(`voz gerada: "${preview}" com ${voice.id} (${String(bytes)} bytes)`);
      this.cache.set(hash, clipId);
    } finally {
      this.synthBusy = false;
    }
    return { id: clipId, voice: voice.id, cached: false };
  }

  listClips(limit = 50): VoiceClip[] {
    const capped = Math.min(Math.max(limit, 1), 200);
    const rows = this.deps.db
      .prepare("SELECT * FROM media_files WHERE category = 'voice' ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(capped) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row['id']),
      title: titleFromVoicePath(String(row['file_path'])),
      filePath: String(row['file_path']),
      bytes: row['bytes'] === null ? null : Number(row['bytes']),
      createdAt: String(row['created_at']),
    }));
  }

  getClip(id: string): VoiceClip | null {
    const row = this.deps.db
      .prepare("SELECT * FROM media_files WHERE id = ? AND category = 'voice'")
      .get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return {
      id: String(row['id']),
      title: titleFromVoicePath(String(row['file_path'])),
      filePath: String(row['file_path']),
      bytes: row['bytes'] === null ? null : Number(row['bytes']),
      createdAt: String(row['created_at']),
    };
  }

  /** Manda o clip como NOTA DE VOZ (ptt) no chat. Erros caem honestos. */
  async send(clipId: string, chatJid: string): Promise<{ ok: true; wamid: string }> {
    const clip = this.getClip(clipId);
    if (clip === null) {
      throw new Error('áudio não encontrado no catálogo');
    }
    if (!existsSync(clip.filePath)) {
      throw new Error('o arquivo de voz sumiu do disco');
    }
    if (chatJid.trim().length < 5 || !chatJid.includes('@')) {
      throw new Error('jid de destino inválido');
    }
    const wamid = await this.deps.sendVoiceNote(chatJid.trim(), clip.filePath, clip.title);
    return { ok: true, wamid };
  }

  private async piperPathOrThrow(): Promise<string> {
    if (this.deps.resolvePiperPath !== undefined) {
      const injected = await this.deps.resolvePiperPath();
      if (injected === null) {
        throw new Error('piper não achado — instala pelo painel (ou env GERALDO_PIPER apontando pro exe)');
      }
      return injected;
    }
    const status = await this.status();
    if (status.piper.piperPath === null) {
      throw new Error('piper não achado — instala pelo painel (ou env GERALDO_PIPER apontando pro exe)');
    }
    return status.piper.piperPath;
  }
}

async function defaultSynthRun(args: SynthesisRunArgs): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child: ChildProcess = spawn(
      args.piperPath,
      ['--model', args.modelPath, '--output_file', args.wavPath],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0 && existsSync(args.wavPath)) { resolvePromise(); return; }
      rejectPromise(new Error(`piper falhou (sai ${String(code ?? 'null')}): ${stderr.slice(-200)}`));
    });
    if (child.stdin === null) {
      rejectPromise(new Error('stdin do piper não abriu'));
      return;
    }
    child.stdin.write(args.text);
    child.stdin.end();
  });
}

/** Conversão default WAV → OGG Opus 16k mono (nota de voz do WhatsApp). */
async function defaultConvertAudio(ffmpegPath: string, wavPath: string, oggPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const ff = spawn(
      ffmpegPath,
      ['-y', '-v', 'error', '-i', wavPath, '-c:a', 'libopus', '-b:a', '48k', '-ar', '16000', '-ac', '1', oggPath],
      { windowsHide: true },
    );
    let stderr = '';
    ff.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    ff.on('error', rejectPromise);
    ff.on('close', (code) => {
      if (code === 0 && existsSync(oggPath)) { resolvePromise(); return; }
      rejectPromise(new Error(`ffmpeg falhou (sai ${String(code ?? 'null')}): ${stderr.slice(-200)}`));
    });
  });
}

/** Download streaming com teto — curl estragando o dia não. */
async function downloadBinary(url: string, destPath: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'GeraldoAI/1.0 (painel de voz; download de ativos TTS)' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`servidor respondeu HTTP ${String(response.status)} baixando ${url}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_BYTES) {
      throw new Error(`download passou do teto (${String(MAX_DOWNLOAD_BYTES)} bytes)`);
    }
    const partial = `${destPath}.part`;
    writeFileSync(partial, buffer);
    renameSync(partial, destPath);
  } finally {
    clearTimeout(timer);
  }
}

/** Extração via tar.exe (bsdtar lê zip no Windows 10+; zero dependência). */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) { resolvePromise(); return; }
      rejectPromise(new Error(`tar falhou extraindo o zip do piper: ${stderr.slice(-200)}`));
    });
  });
}

function makeStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function rmDirSafe(dir: string): void {
  try {
    // cuidado: só o tmp de síntese (voice-<stamp>), nunca raízes do usuário
    if (dir.includes('voice-')) rmSync(dir, { recursive: true, force: true });
  } catch {
    /* cleanup best-effort — se falhou, fica pra limpeza futura */
  }
}

function titleFromVoicePath(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  return name.replace(/^voz-/, '').replace(/\.ogg$/i, '');
}
