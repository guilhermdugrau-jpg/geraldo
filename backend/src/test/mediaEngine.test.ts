import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { Database } from '../database/database.ts';
import { runMigrations } from '../database/migrations.ts';
import { Logger } from '../logger/logger.ts';
import { TaskRunner } from '../media/runner.ts';
import { MediaEngine } from '../media/mediaEngine.ts';
import { versionArgsFor } from '../media/tools.ts';

type EmitLine = (chunk: Buffer) => void;

interface FakeChild {
  stdout: { on(event: 'data', cb: EmitLine): void };
  stderr: { on(event: 'data', cb: EmitLine): void };
  on(event: 'close', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (error: Error) => void): void;
  kill(): void;
}

interface FakeSpawnOptions {
  stdoutText: string;
  stderrText?: string;
  exitCode: number;
  /** Grava arquivo no jobDir (derivado do -o do yt-dlp real). */
  writeWhenDone?: (jobDir: string, ext: string) => void;
}

function fakeSpawnFactory(options: FakeSpawnOptions): (...args: unknown[]) => FakeChild {
  return (...spawnArgs: unknown[]) => {
    let stdoutHandler: EmitLine | null = null;
    let stderrHandler: EmitLine | null = null;
    let closeHandler: ((code: number | null) => void) | null = null;
    const child: FakeChild = {
      stdout: { on: (_e, cb) => { stdoutHandler = cb; } },
      stderr: { on: (_e, cb) => { stderrHandler = cb; } },
      on: (event, cb) => {
        if (event === 'close') closeHandler = cb as (code: number | null) => void;
      },
      kill: () => undefined,
    };
    setTimeout(() => {
      const args = spawnArgs[1] as string[] | undefined;
      const outArg = args?.find((a) => typeof a === 'string' && a.includes('dl.%(ext)s')) ?? null;
      if (outArg !== null && options.writeWhenDone !== undefined) {
        options.writeWhenDone(outArg.slice(0, -1 - 'dl.%(ext)s'.length + 1), 'mp3');
      }
      if (stdoutHandler !== null && options.stdoutText !== '') stdoutHandler(Buffer.from(options.stdoutText));
      if (stderrHandler !== null && (options.stderrText ?? '') !== '') stderrHandler(Buffer.from(options.stderrText ?? ''));
      closeHandler?.(options.exitCode);
    }, 25);
    return child;
  };
}

const FAKE_AUDIO = Buffer.from('MP3 FAKE DE TESTE (bytes simulados para o smoke)');
const HAPPY_STDOUT = [
  '[download]   1.0% of  1.00MiB',
  '[download]  50.0% of  1.00MiB',
  '[download] 100% of 1.00MiB',
  '[ExtractAudio] Destination: progress file',
  '',
].join('\n');

const dir = mkdtempSync(join(tmpdir(), 'geraldomedia-'));
const mediaDir = join(dir, 'media');
mkdirSync(mediaDir, { recursive: true });
const db = new Database(join(dir, 'test.db'));
runMigrations(db, { backupsDir: join(dir, 'backups'), dbPath: join(dir, 'test.db') });
const logger = new Logger({ level: 'error', file: null, console: false });
const log = logger.withModule('test');

after(() => {
  db.close();
  void logger.close();
});

function flush(ms = 100): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** Condição com prazo determinístico — nada de sleep fixo cego. */
async function waitFor(condition: () => boolean, timeoutMs = 4000, step = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('espera decepção: condição do job não chegou a tempo');
    }
    await flush(step);
  }
}

function buildEngine(overrides: {
  fakeSpawn?: (...args: unknown[]) => FakeChild;
  tools?: { ytdlpPath: string | null; ffmpegPath: string | null };
} = {}): { engine: MediaEngine; runner: TaskRunner } {
  const runner = new TaskRunner({ db, log, concurrency: 1 });
  const tools = overrides.tools ?? { ytdlpPath: null, ffmpegPath: null };
  const engine = new MediaEngine({
    runner,
    log,
    db,
    paths: { mediaDir, tmpRoot: dir },
    resolveTools: async () => ({
      ytdlpPath: tools.ytdlpPath,
      ffmpegPath: tools.ffmpegPath,
      ytdlpVersion: tools.ytdlpPath === null ? null : 'fake-ytdlp',
      ffmpegVersion: tools.ffmpegPath === null ? null : 'fake-ffmpeg',
      checkedAt: new Date().toISOString(),
    }),
    ...((overrides.fakeSpawn !== undefined)
      ? { spawn: ((...args: unknown[]) => overrides.fakeSpawn?.(...args) ?? undefined) as unknown as typeof import('node:child_process').spawn }
      : {}),
  });
  engine.register();
  return { engine, runner };
}

describe('MediaEngine — regras de entrada', () => {
  it('URL sem http(s) é recusada na entrada (sem fila)', () => {
    const { engine } = buildEngine();
    const refusals = [
      'file:///C:/windows/system32/x.mp4',
      'example.com/y.mp3',
      'ftp://host/z.mp4',
      '',
    ].map((url) => engine.enqueueDownload({ url, format: 'audio' }));
    for (const result of refusals) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(result.error.length > 0);
    }
  });

  it('formato inválido é recusado', () => {
    const { engine } = buildEngine();
    const result = engine.enqueueDownload({ url: 'https://exemplo.com/a.mp3', format: 'foto' as never });
    assert.equal(result.ok, false);
  });
});

describe('MediaEngine — execução honesta', () => {
  it('sem tools o job falha com a instrução de instalação', async () => {
    const { engine, runner } = buildEngine();
    const enqueued = engine.enqueueDownload({ url: 'https://x.com/m.mp3', format: 'audio' });
    assert.ok(enqueued.ok);
    if (enqueued.ok) {
      await flush();
      const job = runner.get(enqueued.id);
      assert.equal(job?.state, 'failed');
      assert.ok(String(job?.error).includes('ferramentas ausentes'));
    }
    assert.equal(engine.listFiles().length, 0);
  });

  it('áudio (caminho feliz): progresso, mp3 catalogado e arquivo movido pro mediaDir', async () => {
    const { engine, runner } = buildEngine({
      tools: { ytdlpPath: 'C:\\tool\\yt-dlp.exe', ffmpegPath: 'C:\\tool\\ffmpeg.exe' },
      fakeSpawn: fakeSpawnFactory({
        stdoutText: HAPPY_STDOUT,
        exitCode: 0,
        writeWhenDone: (jobDir) => {
          writeFileSync(join(jobDir, 'dl.mp3'), FAKE_AUDIO);
        },
      }),
    });
    const enqueued = engine.enqueueDownload({ url: 'https://x.com/musica.mp3', format: 'audio' });
    assert.ok(enqueued.ok);
    if (!enqueued.ok) return;

    const job = runner.get(enqueued.id);
    if (job === null) return assert.fail('job não catalogado');
    await waitFor(() => (runner.get(enqueued.id)?.state ?? 'queued') === 'done');
    const finished = runner.get(enqueued.id);
    assert.ok((finished?.progress ?? 0) > 0.85);

    const files = engine.listFiles();
    assert.equal(files.length, 1);
    const stored = files[0];
    if (stored === undefined) return assert.fail('catálogo vazio');
    assert.equal(stored.category, 'audio');
    assert.equal(stored.mime, 'audio/mpeg');
    assert.ok(stored.filePath.startsWith(mediaDir));
    assert.ok(existsSync(stored.filePath));
    assert.ok(readFileSync(stored.filePath).equals(FAKE_AUDIO));
    assert.equal(stored.bytes, FAKE_AUDIO.length);
    assert.ok(stored.sourceUrl?.includes('x.com/musica.mp3'));
  });

  it('vídeo remux mp4: catálogo categoria video + mime mp4', async () => {
    const FAKE_VIDEO = Buffer.from('MP4 FAKE');
    const { engine, runner } = buildEngine({
      tools: { ytdlpPath: 'C:\\tool\\yt-dlp.exe', ffmpegPath: 'C:\\tool\\ffmpeg.exe' },
      fakeSpawn: fakeSpawnFactory({
        stdoutText: '[download] 100% of 2.00MiB',
        exitCode: 0,
        writeWhenDone: (jobDir) => {
          writeFileSync(join(jobDir, 'dl.mp4'), FAKE_VIDEO);
        },
      }),
    });
    const enqueued = engine.enqueueDownload({ url: 'https://v.com/clip', format: 'video' });
    assert.ok(enqueued.ok);
    if (!enqueued.ok) return;
    const job = runner.get(enqueued.id);
    if (job === null) return assert.fail('job não catalogado');
    await waitFor(() => (runner.get(enqueued.id)?.state ?? 'queued') !== 'running');
    const finished = runner.get(enqueued.id);
    assert.equal(finished?.state, 'done');
    const files = engine.listFiles();
    const video = files.find((f) => f.category === 'video');
    assert.ok(video !== undefined);
    assert.equal(video?.mime, 'video/mp4');
  });

  it('yt-dlp morre (código 1) → failed com a rejeição real da fonte', async () => {
    const runner = new TaskRunner({ db, log });
    const engine = new MediaEngine({
      runner,
      log,
      db,
      paths: { mediaDir, tmpRoot: dir },
      resolveTools: async () => ({
        ytdlpPath: 'C:\\tool\\yt-dlp.exe',
        ffmpegPath: 'C:\\tool\\ffmpeg.exe',
        ytdlpVersion: null,
        ffmpegVersion: null,
        checkedAt: '',
      }),
      spawn: fakeSpawnFactory({
        stdoutText: '[download]   3.0% of 1.00MiB',
        stderrText: 'ERROR: [youtube] vídeo indisponível',
        exitCode: 1,
      }) as unknown as typeof import('node:child_process').spawn,
    });
    engine.register();
    const filesBefore = engine.listFiles().length;
    const enqueued = engine.enqueueDownload({ url: 'https://v.com/y', format: 'video' });
    assert.ok(enqueued.ok);
    if (!enqueued.ok) return;
    await waitFor(() => (runner.get(enqueued.id)?.state ?? 'queued') === 'failed');
    const job = runner.get(enqueued.id);
    assert.ok(String(job?.error).includes('código 1'));
    assert.ok(String(job?.error).includes('vídeo indisponível'));
    assert.equal(engine.listFiles().length, filesBefore);
  });

  it('toolsStatus cacheia a detecção (uma chamada de resolver só)', () => {
    let resolverCalls = 0;
    const runner = new TaskRunner({ db, log });
    const engine = new MediaEngine({
      runner,
      log,
      db,
      paths: { mediaDir, tmpRoot: dir },
      resolveTools: async () => {
        resolverCalls += 1;
        return {
          ytdlpPath: 'C:\\tool\\yt-dlp.exe',
          ffmpegPath: 'C:\\tool\\ffmpeg.exe',
          ytdlpVersion: 'v',
          ffmpegVersion: 'v',
          checkedAt: '',
        };
      },
    });
    return engine.toolsStatus().then((first) => {
      return engine.toolsStatus().then((second) => {
        assert.equal(first.ytdlpPath, second.ytdlpPath);
        assert.equal(resolverCalls, 1);
        return engine.toolsStatus({ force: true }).then(() => {
          assert.equal(resolverCalls, 2);
        });
      });
    });
  });

  it('flags de versão: ffmpeg legado exige -version (regressão do eco raro)', () => {
    assert.deepEqual(versionArgsFor('ffmpeg'), ['-version']);
    assert.deepEqual(versionArgsFor('yt-dlp'), ['--version']);
  });

  it('spawn do Engine manda flags saneiras (sem shell, sem playlist)', async () => {
    let seenArgs: string[] | null = null;
    const makeEngine = (): { engine: MediaEngine; runner: TaskRunner } => {
      const runner = new TaskRunner({ db, log });
      const spawnFn = ((...args: unknown[]) => {
        seenArgs = args[1] as string[];
        const child: FakeChild = {
          stdout: { on: () => undefined },
          stderr: { on: () => undefined },
          on: (event, cb) => {
            if (event === 'close') (cb as (code: number | null) => void)(1);
          },
          kill: () => undefined,
        };
        return child as unknown as ChildProcess;
      }) as unknown as typeof import('node:child_process').spawn;
      const engine = new MediaEngine({
        runner,
        log,
        db,
        paths: { mediaDir, tmpRoot: dir },
        resolveTools: async () => ({
          ytdlpPath: 'C:\\tool\\yt-dlp.exe',
          ffmpegPath: 'C:\\tool\\ffmpeg.exe',
          ytdlpVersion: null,
          ffmpegVersion: null,
          checkedAt: '',
        }),
        spawn: spawnFn,
      });
      engine.register();
      return { engine, runner };
    };
    const { engine, runner } = makeEngine();
    const enqueued = engine.enqueueDownload({ url: 'https://x.com/lista', format: 'audio' });
    assert.ok(enqueued.ok);
    await flush(150);
    assert.ok(seenArgs !== null);
    const args: string[] = seenArgs ?? [];
    assert.ok(args.some((argument) => argument === '--no-playlist'));
    assert.ok(args.some((argument) => argument === '--ffmpeg-location'));
    assert.ok(args.some((argument) => argument === 'C:\\tool'));
    assert.equal(args.at(-1), 'https://x.com/lista');
    const job = typeof enqueued.ok === 'boolean' && enqueued.ok === true ? runner.get(enqueued.id) : null;
    assert.equal(job?.state, 'failed');
  });
});
