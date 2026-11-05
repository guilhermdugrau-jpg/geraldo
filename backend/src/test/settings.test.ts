import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../database/database.ts';
import { runMigrations } from '../database/migrations.ts';
import { ConfigStore } from '../config/store.ts';
import { resolvePaths } from '../config/paths.ts';
import { Logger } from '../logger/logger.ts';
import { SettingsService, API_KEY_MASK } from '../services/settingsService.ts';

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'geraldoset-'));
  const paths = resolvePaths(dataDir);
  const db = new Database(paths.dbPath);
  runMigrations(db, { backupsDir: paths.backupsDir, dbPath: paths.dbPath });
  const config = new ConfigStore(paths);
  const logger = new Logger({ level: 'info', file: null, console: false });
  const patched: Array<Record<string, unknown>> = [];
  const settings = new SettingsService(
    db,
    () => config.get(),
    (patch) => {
      patched.push(patch);
    },
    logger.withModule('settings'),
    () => undefined,
  );
  return { db, paths, config, logger, settings, patched };
}

test('defaults de IA vem do config até alguém alterar', () => {
  const { db, logger, settings } = setup();
  const ai = settings.effectiveAI();
  assert.equal(ai.provider, 'disabled');
  assert.equal(ai.apiKey, '');
  const pub = settings.getPublic();
  assert.equal(pub.ai.hasApiKey, false);
  assert.equal(pub.ai.canGenerate, false);
  db.close();
  logger.close();
});

test('updateAI persiste, mascara a key e computa canGenerate', () => {
  const { db, logger, settings } = setup();
  settings.updateAI({ provider: 'ollama', model: 'llama3:8b', temperature: 0.4 });

  const ai = settings.effectiveAI();
  assert.equal(ai.provider, 'ollama');
  assert.equal(ai.model, 'llama3:8b');
  assert.equal(ai.temperature, 0.4);

  const pub = settings.getPublic();
  assert.equal(pub.ai.canGenerate, true);

  settings.updateAI({ apiKey: 'sk-secreto-xyz' });
  const pub2 = settings.getPublic();
  assert.equal(pub2.ai.apiKey, API_KEY_MASK);
  assert.equal(pub2.ai.hasApiKey, true);
  assert.equal(settings.effectiveAI().apiKey, 'sk-secreto-xyz');
  db.close();
  logger.close();
});

test('API key mascarada vinda da UI não sobrescreve a real', () => {
  const { db, logger, settings } = setup();
  settings.updateAI({ provider: 'openai', apiKey: 'sk-real' });
  settings.updateAI({ apiKey: API_KEY_MASK });
  assert.equal(settings.effectiveAI().apiKey, 'sk-real');

  settings.updateAI({ clearApiKey: true });
  assert.equal(settings.effectiveAI().apiKey, '');
  assert.equal(settings.getPublic().ai.hasApiKey, false);
  db.close();
  logger.close();
});

test('campos inválidos são descartados na atualização', () => {
  const { db, logger, settings } = setup();
  settings.updateAI({ provider: 'ollama', model: 'modelo-base', temperature: 0.9 });
  settings.updateAI({ provider: 'cheat', temperature: 99, maxTokens: -1, timeoutMs: 1 });
  const ai = settings.effectiveAI();
  assert.equal(ai.provider, 'ollama');
  assert.equal(ai.temperature, 0.9);
  db.close();
  logger.close();
});

test('override fica no banco: nova instância herda', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'geraldoset-'));
  const paths = resolvePaths(dataDir);
  const db = new Database(paths.dbPath);
  runMigrations(db, { backupsDir: paths.backupsDir, dbPath: paths.dbPath });
  const config = new ConfigStore(paths);
  const logger = new Logger({ level: 'info', file: null, console: false });

  const first = new SettingsService(
    db,
    () => config.get(),
    () => undefined,
    logger.withModule('settings'),
    () => undefined,
  );
  first.updateAI({ provider: 'openai', model: 'gpt-test', baseUrl: 'https://api.exemplo/v1' });

  const second = new SettingsService(
    db,
    () => config.get(),
    () => undefined,
    logger.withModule('settings'),
    () => undefined,
  );
  const ai = second.effectiveAI();
  assert.equal(ai.provider, 'openai');
  assert.equal(ai.model, 'gpt-test');
  assert.equal(ai.baseUrl, 'https://api.exemplo/v1');

  db.close();
  logger.close();
});

test('setLogLevel e autoReconnect chegam via callback de config', () => {
  const { db, logger, settings, patched } = setup();
  settings.setLogLevel('debug');
  settings.setWhatsappAutoReconnect(false);
  assert.deepEqual(patched, [
    { logLevel: 'debug' },
    { whatsappAutoReconnect: false },
  ]);
  db.close();
  logger.close();
});
