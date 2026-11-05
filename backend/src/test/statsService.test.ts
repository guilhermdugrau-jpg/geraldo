/**
 * ETAPA 8: testes do StatsService — contagens reais do banco, nada de
 * número estimado. Banco temporário com migrações válidas, dados
 * semeados e estados de WhatsApp/IA/tarefas injetados à mão.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../database/database.ts';
import { runMigrations } from '../database/migrations.ts';
import { StatsService, type StatsDeps } from '../services/statsService.ts';
import type { AISettings } from '../config/types.ts';

function ai(overrides: Partial<AISettings> = {}): AISettings {
  return {
    provider: 'zai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-4.7',
    fallbackModel: '',
    apiKey: 'k',
    temperature: 0.7,
    maxTokens: 2048,
    timeoutMs: 30_000,
    ...overrides,
  } as AISettings;
}

function makeStats(db: Database, overrides: Partial<StatsDeps> = {}): StatsService {
  return new StatsService({
    db,
    effectiveAI: () => ai(),
    whatsappInfo: () => ({ state: 'connected', note: 'conectado de verdade' }),
    taskCounts: () => ({ queued: 0, running: 0 }),
    ...overrides,
  });
}

/** Semeia dados com timestamps relativos a agora (ISO). */
function seed(db: Database): void {
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO conversations (jid, type, title, memory_enabled, created_at, updated_at)
     VALUES (?, 'private', 'Lucas', 1, ?, ?)`,
  ).run('551199999@s.whatsapp.net', oldIso, nowIso);
  db.prepare(
    `INSERT INTO conversations (jid, type, title, memory_enabled, created_at, updated_at)
     VALUES (?, 'group', 'Bodegueiros', 1, ?, ?)`,
  ).run('551299999-987654321@g.us', oldIso, oldIso);

  db.prepare(
    `INSERT INTO messages (chat, sender, direction, kind, body, created_at)
     VALUES (?, '551199999@s.whatsapp.net', 'in', 'text', 'oi', ?)`,
  ).run('551199999@s.whatsapp.net', oldIso);
  db.prepare(
    `INSERT INTO messages (chat, sender, direction, kind, body, created_at)
     VALUES (?, '551199999@s.whatsapp.net', 'in', 'text', 'fala aí velho', ?)`,
  ).run('551199999@s.whatsapp.net', nowIso);
  db.prepare(
    `INSERT INTO messages (chat, sender, direction, kind, body, created_at)
     VALUES (?, 'geraldo', 'out', 'text', 'salve!', ?)`,
  ).run('551199999@s.whatsapp.net', nowIso);

  db.prepare(
    `INSERT INTO media_files (id, chat, category, source_url, file_path, mime, bytes, created_at)
     VALUES (?, NULL, 'sound', NULL, 'vine-boom.mp3', 'audio/mpeg', 12000, ?)`,
  ).run('som-1', nowIso);
  db.prepare(
    `INSERT INTO media_files (id, chat, category, source_url, file_path, mime, bytes, created_at)
     VALUES (?, NULL, 'image', NULL, 'gato.png', 'image/png', 240000, ?)`,
  ).run('img-1', nowIso);
  db.prepare(
    `INSERT INTO media_files (id, chat, category, source_url, file_path, mime, bytes, created_at)
     VALUES (?, NULL, 'video', NULL, 'cascavel.mp4', 'video/mp4', NULL, ?)`,
  ).run('vid-1', nowIso);

  db.prepare(
    `INSERT INTO tasks (id, chat, name, type, state, detail, result_path, created_at, updated_at)
     VALUES (?, NULL, 'cascavel.mp4', 'media_download', 'done', NULL, 'c:\\media\\cascavel.mp4', ?, ?)`,
  ).run('task-done-1', oldIso, nowIso);
  db.prepare(
    `INSERT INTO tasks (id, chat, name, type, state, detail, result_path, error, created_at, updated_at)
     VALUES (?, NULL, 'falhou.mp4', 'media_download', 'failed', NULL, NULL, 'HTTP 404', ?, ?)`,
  ).run('task-bad-1', oldIso, nowIso);
}

test('banco limpo → zeros honestos e estado injetado do WhatsApp/IA', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geraldostats-'));
  const db = new Database(join(dir, 'g.db'));
  runMigrations(db, { backupsDir: join(dir, 'backups'), dbPath: join(dir, 'g.db') });

  const stats = makeStats(db).snapshot();
  assert.equal(stats.conversations.total, 0);
  assert.equal(stats.messages.total, 0);
  assert.equal(stats.media.totalBytes, 0);
  assert.deepEqual(stats.media.byCategory, {});
  assert.equal(stats.tasks.queued, 0);
  assert.equal(stats.tasks.failed, 0);
  assert.equal(stats.whatsapp.state, 'connected');
  assert.equal(stats.whatsapp.note, 'conectado de verdade');
  assert.equal(stats.ai.provider, 'zai');
  assert.equal(stats.ai.configured, true);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('dados semeados → contagens corretas (conversas, mensagens 24h, mídia por categoria)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geraldostats-'));
  const db = new Database(join(dir, 'g.db'));
  runMigrations(db, { backupsDir: join(dir, 'backups'), dbPath: join(dir, 'g.db') });
  seed(db);

  const stats = makeStats(db).snapshot();
  assert.equal(stats.conversations.total, 2);
  assert.equal(stats.conversations.last24h, 1); // grupo ficou velho (3 dias)
  assert.equal(stats.messages.total, 3);
  assert.equal(stats.messages.last24h, 2);
  assert.equal(stats.media.totalBytes, 252000); // vídeo sem bytes conta como 0
  assert.equal(stats.media.byCategory['sound'], 1);
  assert.equal(stats.media.byCategory['image'], 1);
  assert.equal(stats.media.byCategory['video'], 1);
  assert.equal(stats.tasks.done, 1);
  assert.equal(stats.tasks.failed, 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('fila viva manda em queued/running (resíduo velho no banco aparece sem fila viva)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geraldostats-'));
  const db = new Database(join(dir, 'g.db'));
  runMigrations(db, { backupsDir: join(dir, 'backups'), dbPath: join(dir, 'g.db') });

  db.prepare(
    `INSERT INTO tasks (id, chat, name, type, state, detail, result_path, created_at, updated_at)
     VALUES (?, NULL, 'fantasma.mp4', 'media_download', 'running', NULL, NULL, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z')`,
  ).run('task-ghost');

  const comFilaViva = makeStats(db, {
    taskCounts: () => ({ queued: 2, running: 3 }),
  }).snapshot();
  assert.equal(comFilaViva.tasks.queued, 2);
  assert.equal(comFilaViva.tasks.running, 3);

  const semFilaViva = makeStats(db, {
    taskCounts: () => ({ queued: 0, running: 0 }),
  }).snapshot();
  // Sem fila viva, o registro do banco é o que resta (honesto).
  assert.equal(semFilaViva.tasks.running, 1);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('IA desabilitada aparece honesta (configured false)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'geraldostats-'));
  const db = new Database(join(dir, 'g.db'));
  runMigrations(db, { backupsDir: join(dir, 'backups'), dbPath: join(dir, 'g.db') });

  const stats = makeStats(db, {
    effectiveAI: () => ai({ provider: 'disabled', apiKey: '', model: '' }),
  }).snapshot();
  assert.equal(stats.ai.provider, 'disabled');
  assert.equal(stats.ai.configured, false);

  db.close();
  rmSync(dir, { recursive: true, force: true });
});
