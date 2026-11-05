import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChildLogger } from '../logger/logger.ts';
import type { Database } from '../database/database.ts';
import { mimeForExtension, parseYtDlpLine } from './progress.ts';
import { resolveMediaTools, type MediaTools } from './tools.ts';
import type { TaskHandler, TaskPayload, TaskRunner, RunningContext } from './runner.ts';

export interface MediaEngineDeps {
  runner: TaskRunner;
  log: ChildLogger;
  db: Database;
  paths: { mediaDir: string; tmpRoot?: string };
  /** Cacheia a detecção de ferramentas entre jobs. */
  resolveTools?: (opts?: { force?: boolean }) => Promise<MediaTools>;
  /** Injetável p/ testes; por padrão usa child_process.spawn. */
  spawn?: typeof nodeSpawn;
}

export interface StoredMediaFile {
  id: string;
  chat: string | null;
  category: string;
  sourceUrl: string | null;
  filePath: string;
  mime: string | null;
  bytes: number | null;
  createdAt: string;
}

export type MediaFormat = 'audio' | 'video';

const AUDIO_ARGS = (): string[] => [
  '--extract-audio',
  '--audio-format',
  'mp3',
  '--audio-quality',
  '192K',
  '-f',
  'bestaudio/best',
];
const VIDEO_ARGS: string[] = [
  '--remux-video',
  'mp4',
  '-f',
  'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
];

export class MediaEngine {
  private toolsCache: MediaTools | null = null;
  private readonly command: typeof nodeSpawn;

  constructor(deps: MediaEngineDeps) {
    this.deps = deps;
    this.command = deps.spawn ?? nodeSpawn;
  }

  private readonly deps: MediaEngineDeps;

  /** Liga o handler do download no runner (chamar uma vez no boot). */
  register(): void {
    this.deps.runner.register('media_download', async (payload, ctx) => {
      await this.runDownload(payload, ctx);
    });
  }

  toolsStatus({ force }: { force?: boolean } = {}): Promise<MediaTools> {
    if (this.toolsCache === null || force === true) {
      return this.deps.resolveTools !== undefined
        ? this.deps.resolveTools({ force: true }).then((tools) => {
            this.toolsCache = tools;
            return tools;
          })
        : Promise.resolve({
            ytdlpPath: null,
            ffmpegPath: null,
            ytdlpVersion: null,
            ffmpegVersion: null,
            checkedAt: new Date().toISOString(),
          });
    }
    return Promise.resolve(this.toolsCache);
  }

  enqueueDownload(input: {
    url: string;
    format: MediaFormat;
    chat?: string | null;
  }): { ok: false; error: string } | { ok: true; id: string } {
    const url = input.url.trim();
    const format = input.format;
    if (format !== 'audio' && format !== 'video') {
      return { ok: false, error: 'Formato inválido (só audio ou video)' };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'URL deve começar com http:// ou https://' };
    }
    if (url.length > 600) {
      return { ok: false, error: 'URL muito comprida' };
    }
    const job = this.deps.runner.enqueue({
      type: 'media_download',
      name: `download ${format} ${url.slice(0, 60)}`,
      payload: { url, format },
      chat: input.chat ?? null,
    });
    if (job === null) {
      return { ok: false, error: 'sem fila registrada para download' };
    }
    return { ok: true, id: job.id };
  }

  listFiles(options: { limit?: number } = {}): StoredMediaFile[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const rows = this.deps.db
      .prepare('SELECT * FROM media_files ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToMediaFile(row));
  }

  getFile(id: string): StoredMediaFile | null {
    const row = this.deps.db.prepare('SELECT * FROM media_files WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    return this.rowToMediaFile(row);
  }

  private rowToMediaFile(row: Record<string, unknown>): StoredMediaFile {
    return {
      id: String(row['id']),
      chat: row['chat'] === null ? null : String(row['chat']),
      category: String(row['category']),
      sourceUrl: row['source_url'] === null ? null : String(row['source_url']),
      filePath: String(row['file_path']),
      mime: row['mime'] === null ? null : String(row['mime']),
      bytes: row['bytes'] === null ? null : Number(row['bytes']),
      createdAt: String(row['created_at']),
    };
  }

  /** Executa a tarefa do job (dono do tempo, spawn e câmera de progresso). */
  private async runDownload(payload: TaskPayload, ctx: RunningContext): Promise<void> {
    const url = typeof payload['url'] === 'string' ? payload['url'] : '';
    const format = payload['format'] === 'video' ? 'video' : 'audio';
    if (url === '') {
      throw new Error('download sem URL no payload');
    }

    // Cache-first: boot já validou as versões; re-detectar a cada tarefa
    // re-probeia os executáveis (yt-dlp gelado fecha tonto) e falha de boba.
    let tools = await this.toolsStatus();
    if (tools.ytdlpPath === null || tools.ffmpegPath === null) {
      tools =
        this.deps.resolveTools !== undefined
          ? await this.deps.resolveTools({ force: true })
          : tools;
    }
    const ytdlp = tools.ytdlpPath;
    const ffmpeg = tools.ffmpegPath;
    if (ytdlp === null || ffmpeg === null) {
      throw new Error(
        'ferramentas ausentes: yt-dlp/ffmpeg não achados — instale com "winget install yt-dlp.yt-dlp" e tente de novo',
      );
    }

    mkdirSync(this.deps.paths.mediaDir, { recursive: true });
    const jobDir = mkdtempSync(join(this.deps.paths.tmpRoot ?? tmpdir(), 'geraldomedia-'));
    const outBase = join(jobDir, 'dl');
    const args = [
      '--newline',
      '--progress',
      '--ffmpeg-location',
      dirname(ffmpeg),
      '--no-playlist',
      '--no-warnings',
      '--max-filesize',
      '500M',
      '-o',
      `${outBase}.%(ext)s`,
      ...(format === 'audio' ? AUDIO_ARGS() : VIDEO_ARGS),
      url,
    ];

    ctx.update({ progress: 0.01, detail: 'abrindo conexão com a fonte...' });
    if (ctx.canceled()) {
      throw new Error('cancelado antes de rodar');
    }

    const child = this.command(ytdlp, args, { windowsHide: true });
    const lines: string[] = [];
    const remember = (text: string): void => {
      if (text.trim() === '') return;
      lines.push(text);
      if (lines.length > 10) lines.shift();
    };
    child.stdout?.on('data', (chunk: Buffer) => this.absorbProgress(chunk.toString('utf8'), ctx, remember));
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/\r?\n/)) remember(raw);
    });

    const exitCode = await new Promise<number | null>((resolvePromise) => {
      const cancelWatch = setInterval(() => {
        if (ctx.canceled()) {
          child.kill();
        }
      }, 400);
      cancelWatch.unref();
      child.on('error', () => {
        clearInterval(cancelWatch);
        resolvePromise(-1);
      });
      child.on('close', (code) => {
        clearInterval(cancelWatch);
        resolvePromise(code);
      });
    });

    if (ctx.canceled()) {
      throw new Error('cancelado em plena execução');
    }
    if (exitCode !== 0) {
      const detail = lines.filter((line) => line.trim() !== '').join(' | ').slice(0, 480);
      throw new Error(`yt-dlp saiu com código ${String(exitCode)}${detail !== '' ? `: ${detail}` : ''}`);
    }

    const produced = this.findOutputFile(jobDir, format);
    if (produced === null) {
      throw new Error('yt-dlp terminou, mas não deixou arquivo no diretório temporário');
    }
    const bytes = statSync(produced).size;
    try {
      const fileId = randomUUID();
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..*$/, '');
      const targetName = `${stamp}-${fileId.slice(0, 6)}.${extensionFor(produced, format)}`;
      const targetPath = join(this.deps.paths.mediaDir, targetName);
      renameSync(produced, targetPath);
      ctx.update({ progress: 1, resultPath: targetPath, detail: `${basename(targetPath)} (${formatBytes(bytes)})` });
      const now = new Date().toISOString();
      this.deps.db
        .prepare(
          `INSERT INTO media_files (id, chat, category, source_url, file_path, mime, bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fileId,
          null,
          format,
          url,
          targetPath,
          mimeForExtension(targetPath.split('.').pop() ?? ''),
          bytes,
          now,
        );
      this.deps.log.info(`download pronto: ${targetName} (${formatBytes(bytes)}) de ${url.slice(0, 60)}`);
    } finally {
      try {
        rmSync(jobDir, { recursive: true, force: true });
      } catch {
        /* sujeira de tmp é tolerável */
      }
    }
  }

  private findOutputFile(jobDir: string, format: MediaFormat): string | null {
    const expected = join(jobDir, `dl.${format === 'audio' ? 'mp3' : 'mp4'}`);
    try {
      if (statSync(expected).isFile()) return expected;
    } catch {
      /* cai no fallback */
    }
    const files = readdirSync(jobDir).filter((name) => name.startsWith('dl.'));
    const latest = files.length > 0 ? files[files.length - 1] : undefined;
    if (latest === undefined) return null;
    return join(jobDir, latest);
  }

  private absorbProgress(
    output: string,
    ctx: RunningContext,
    remember: (text: string) => void,
  ): void {
    for (const raw of output.split(/\r?\n/)) {
      const parsed = parseYtDlpLine(raw);
      if (parsed.text !== '') remember(parsed.text);
      if (parsed.kind === 'download' && parsed.progress !== null) {
        ctx.update({ progress: Math.min(parsed.progress * 0.85 + 0.01, 0.85) });
      } else if (parsed.kind === 'convert') {
        ctx.update({ progress: 0.92, detail: 'convertendo com FFmpeg...' });
      }
    }
  }
}

function extensionFor(path: string, format: MediaFormat): string {
  const wanted = format === 'audio' ? 'mp3' : 'mp4';
  const ext = path.split('.').pop() ?? '';
  if (ext === '' || ext === 'part' || ext === 'ytdl') return wanted;
  return ext;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
