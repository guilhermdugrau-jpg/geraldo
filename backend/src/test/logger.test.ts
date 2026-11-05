import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../logger/logger.ts';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'geraldo-log-'));
}

test('respeita nível mínimo, filtra busca e emite para listeners', () => {
  const logger = new Logger({ level: 'info', file: null, console: false });
  const seen: string[] = [];
  logger.onEntry((entry) => seen.push(`${entry.level}:${entry.module}:${entry.message}`));

  const child = logger.withModule('prova');
  child.debug('não pode aparecer');
  child.info('avenida Brasil');
  child.warn('alerta do cabra');
  child.error('quebrou tudo', { id: 7 });

  assert.equal(seen.length, 3);
  assert.equal(seen[0], 'info:prova:avenida Brasil');

  assert.equal(logger.recent({ level: 'error' }).length, 1);
  assert.equal(logger.recent({ search: 'avenida' }).length, 1);
  assert.equal(logger.recent({ search: 'nao-existe' }).length, 0);
  assert.equal(logger.recent({ module: 'outro' }).length, 0);
  assert.equal(logger.recent({ limit: 1 }).length, 1);

  const full = logger.recent({});
  assert.equal(full.length, 3);
  const erroFull = full.find((entry) => entry['level'] === 'error');
  assert.ok(erroFull?.meta?.includes('"id":7'));
});

test('escreve JSONL no arquivo (um objeto por linha)', async () => {
  const dir = tempDir();
  const file = join(dir, 'app.log');
  const logger = new Logger({ level: 'info', file, console: false });
  logger.withModule('arquivo').info('linha um', { chave: 'valor' });
  logger.withModule('arquivo').error('linha dois');
  await logger.close();

  assert.ok(existsSync(file));
  const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
  assert.equal(first['module'], 'arquivo');
  assert.equal(first['message'], 'linha um');
  assert.ok(typeof first['ts'] === 'string');
  const meta = JSON.parse(String(first['meta'])) as Record<string, unknown>;
  assert.equal(meta['chave'], 'valor');
});
