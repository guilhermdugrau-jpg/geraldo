import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../database/database.ts';
import { runMigrations } from '../database/migrations.ts';
import { Logger } from '../logger/logger.ts';
import { TaskRunner } from '../media/runner.ts';
import type { RunningContext } from '../media/runner.ts';

const dir = mkdtempSync(join(tmpdir(), 'geraldotask-'));
const db = new Database(join(dir, 'test.db'));
runMigrations(db, { backupsDir: join(dir, 'backups'), dbPath: join(dir, 'test.db') });
const logger = new Logger({ level: 'error', file: null, console: false });
const log = logger.withModule('test');

function flush(ms = 250): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

after(() => {
  db.close();
  void logger.close();
});

describe('TaskRunner — fila persistente', () => {
  it('job registrado, roda, grava state/progress e emite eventos', async () => {
    const events: string[] = [];
    const runner = new TaskRunner({
      db,
      log,
      onEvent: (event) => {
        events.push(event);
      },
    });
    runner.register('echo', async (payload, ctx) => {
      ctx.update({ progress: 0.5, detail: 'no meio' });
      ctx.update({ progress: 1 });
    });
    const queued = runner.enqueue({ type: 'echo', name: 'echo test', payload: { hi: true } });
    assert.ok(queued !== null);
    await flush();

    const record = runner.get(queued.id);
    assert.equal(record?.state, 'done');
    assert.equal(record?.progress, 1);
    assert.ok(record?.finishedAt !== null);
    assert.ok(events.includes('job:progress'));
    assert.ok(events.includes('job:done'));
    assert.equal(runner.counts().running, 0);

    const rowDetail = runner.get(queued.id)?.detail ?? '';
    assert.equal(rowDetail, '{"hi":true}');
  });

  it('handler que estoura deixa failed com a mensagem real', async () => {
    const runner = new TaskRunner({ db, log });
    runner.register('boom', async (payload) => {
      if (typeof payload === 'object' && payload !== null && payload['quality'] !== 'midia') {
        throw new Error('yt-dlp saiu com código 1: não tem nada aqui');
      }
    });
    const queued = runner.enqueue({ type: 'boom', name: 'faltando tool', payload: { quality: 'midia' } });
    const bad = runner.enqueue({ type: 'boom', name: 'quebra', payload: { quality: 'livre' } });
    assert.ok(queued !== null && bad !== null);
    await flush();

    assert.equal(runner.get(queued.id)?.state, 'done');
    const failed = runner.get(bad.id);
    assert.equal(failed?.state, 'failed');
    assert.ok(String(failed?.error).includes('código 1'));
  });

  it('cancela na fila (antes de rodar) e o estado fica canceled', async () => {
    const runner = new TaskRunner({ db, log, concurrency: 1 });
    let execuçãoDoPrimeiro = 0;
    runner.register('sleepy', async (_payload, ctx) => {
      execuçãoDoPrimeiro += 1;
      let guard = 0;
      while (!ctx.canceled() && guard < 8) {
        guard += 1;
        await flush(20);
      }
      if (ctx.canceled()) {
        throw new Error('cancelado em plena execução');
      }
    });
    const first = runner.enqueue({ type: 'sleepy', name: 'duramente', payload: {} });
    const second = runner.enqueue({ type: 'sleepy', name: 'na fila', payload: {} });
    assert.ok(first !== null && second !== null);
    const cancelled = runner.cancel(second.id);
    assert.equal(cancelled, true);
    await flush(400);
    assert.equal(runner.get(second.id)?.state, 'canceled');
    assert.ok(execuçãoDoPrimeiro >= 1);
    assert.equal(runner.get(first.id)?.state, 'done');
  });

  it('resumePending: running de corrida antiga vira canceled; queued re-agenda', async () => {
    const seed = (id: string, state: string): void => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO tasks (id, chat, name, type, state, progress, detail, result_path, error, created_at, updated_at, finished_at)
         VALUES (?, NULL, ?, 'video_remux', ?, 0, '{}', NULL, NULL, ?, ?, NULL)`,
      ).run(id, `seed ${id}`, state, now, now);
    };
    // Corrida antiga de running "fantasma" + fila que sobreviveu ao boot.
    seed('ghost-running', 'running');
    seed('to-resume', 'queued');

    const ghostRunner = new TaskRunner({ db, log });
    ghostRunner.register('video_remux', async () => {
      await flush(20);
    });
    const resumed = ghostRunner.resumePending();
    assert.ok(resumed.canceled.includes('ghost-running'));
    assert.ok(resumed.resumed.includes('to-resume'));
    await flush(150);
    assert.equal(ghostRunner.get('ghost-running')?.state, 'canceled');
    assert.equal(ghostRunner.get('to-resume')?.state, 'done');
  });

  it('sem handler registrado: enqueue recusa honesta', () => {
    const runner = new TaskRunner({ db, log });
    const refused = runner.enqueue({ type: 'x_unknown', name: 'nope', payload: {} });
    assert.equal(refused, null);
  });
});
