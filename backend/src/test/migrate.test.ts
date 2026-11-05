import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../database/database.ts';
import { MIGRATIONS, runMigrations, type Migration } from '../database/migrations.ts';

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), 'geraldodb-'));
  return { dir, db: new Database(join(dir, 'g.db')) };
}

test('migração 001 cria todas as tabelas de fundação', () => {
  const { dir, db } = tempDb();
  const result = runMigrations(db, {
    backupsDir: join(dir, 'backups'),
    dbPath: join(dir, 'g.db'),
  });
  // Registro real (sem contagem dura): IDs na ordem da lista do código.
  assert.deepEqual(result.applied, MIGRATIONS.map((migration) => migration.id));

  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  for (const expected of [
    'conversations',
    'messages',
    'tasks',
    'settings',
    'media_files',
    'migrations',
    // ETAPAs posteriores adicionam suas tabelas — DRIFT honesto se faltar:
    'image_meta',
  ]) {
    assert.ok(tables.includes(expected), `faltou tabela ${expected}`);
  }
  db.close();
});

test('rodar migrações duas vezes é idempotente', () => {
  const { dir, db } = tempDb();
  const first = runMigrations(db, {
    backupsDir: join(dir, 'backups'),
    dbPath: join(dir, 'g.db'),
  });
  const second = runMigrations(db, {
    backupsDir: join(dir, 'backups'),
    dbPath: join(dir, 'g.db'),
  });
  assert.equal(first.applied.length, MIGRATIONS.length);
  assert.equal(second.applied.length, 0);
  db.close();
});

test('conversas e mensagens respeitam FK e CHECK', () => {
  const { dir, db } = tempDb();
  runMigrations(db, { backupsDir: join(dir, 'backups'), dbPath: join(dir, 'g.db') });
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO conversations (jid, type, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('5511999@s.whatsapp.net', 'private', 'Teste', now, now);

  db.prepare(
    `INSERT INTO messages (chat, sender, sender_name, direction, kind, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('5511999@s.whatsapp.net', '5511999@s.whatsapp.net', 'Cabra', 'in', 'text', 'fala, pretende', now);

  const row = db.prepare('SELECT body FROM messages LIMIT 1').get() as { body: string };
  assert.equal(row.body, 'fala, pretende');

  assert.throws(() => {
    db.prepare(
      `INSERT INTO messages (chat, sender, direction, kind, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('sem-conversa@x', 'ninguém@x', 'in', 'text', 'fosso', now);
  });
  assert.throws(() => {
    db.prepare(
      `INSERT INTO conversations (jid, type, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('x@y', 'hackado', now, now);
  });
  db.close();
});

test('migração com flag de backup gera arquivo de cópia antes de aplicar', () => {
  const { dir, db } = tempDb();
  const backupsDir = join(dir, 'backups');
  const fake: Migration = {
    id: 99,
    name: 'test-com-backup',
    backup: true,
    sql: ['CREATE TABLE _probe_backup(x INTEGER)'],
  };
  const result = runMigrations(db, { backupsDir, dbPath: join(dir, 'g.db') }, [fake]);
  assert.deepEqual(result.applied, [99]);
  assert.equal(result.backups.length, 1);
  assert.ok(existsSync(result.backups[0] ?? 'nenhum'));
  assert.ok(readdirSync(backupsDir).length >= 1);
  assert.ok(db.prepare('SELECT count(x) AS n FROM _probe_backup').get() !== undefined);
  db.close();
});

test('lista real de migrações é sequencial e sem duplicatas', () => {
  const ids = MIGRATIONS.map((migration) => migration.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.deepEqual(ids, [...new Set(ids)]);
});
