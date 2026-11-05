import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from './database.ts';

export interface Migration {
  id: number;
  name: string;
  /** Comandos aplicados em uma única transação. */
  sql: string[];
  /** Quando true, faz backup do banco antes de aplicar (wipe/rename de dados). */
  backup: boolean;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: '001-fundacao',
    backup: false,
    sql: [
      `CREATE TABLE IF NOT EXISTS conversations (
        jid TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('private','group')),
        title TEXT,
        memory_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat TEXT NOT NULL REFERENCES conversations(jid),
        sender TEXT NOT NULL,
        sender_name TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('in','out')),
        kind TEXT NOT NULL DEFAULT 'text',
        body TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat, created_at)`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        chat TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','running','done','failed','canceled')),
        progress REAL NOT NULL DEFAULT 0,
        detail TEXT,
        result_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state)`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS media_files (
        id TEXT PRIMARY KEY,
        chat TEXT,
        category TEXT NOT NULL,
        source_url TEXT,
        file_path TEXT NOT NULL,
        mime TEXT,
        bytes INTEGER,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )`,
    ],
  },
  {
    id: 2,
    name: '002-mensagens-wamid',
    // Coluna adicional simples, mas backup roda de todo jeito (precaução).
    backup: true,
    sql: [
      `ALTER TABLE messages ADD COLUMN wamid TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wamid
        ON messages(wamid) WHERE wamid IS NOT NULL`,
    ],
  },
  {
    id: 3,
    name: '003-imagens-etapa7',
    // Tabela nova apenas — nenhum dado existente é mexido.
    backup: false,
    sql: [
      `CREATE TABLE IF NOT EXISTS image_meta (
        id TEXT PRIMARY KEY REFERENCES media_files(id),
        prompt TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        size TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_image_meta_created ON image_meta(created_at)`,
    ],
  },
];

export interface MigrationResult {
  applied: number[];
  backups: string[];
}

/**
 * Aplica migrações pendentes. Cada migração é atômica e registrada em
 * `migrations`; rodar de novo não aplica nada duplicado. Migrações
 * marcadas como backup geram uma cópia do banco antes.
 */
export function runMigrations(
  db: Database,
  options: { backupsDir: string; dbPath: string },
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL
  )`);

  const rows = db.prepare('SELECT id, name FROM migrations').all() as Array<{
    id: number;
    name: string;
  }>;
  const applied = new Set(rows.map((row) => Number(row.id)));

  const result: MigrationResult = { applied: [], backups: [] };
  const now = new Date().toISOString();

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue; // idempotente

    if (migration.backup) {
      mkdirSync(options.backupsDir, { recursive: true });
      const stamp = now.replace(/[:T]/g, '-').slice(0, 19);
      const backupPath = join(
        options.backupsDir,
        `db-pre-m${migration.id}-${stamp}.sqlite.bak`,
      );
      copyFileSync(options.dbPath, backupPath);
      result.backups.push(backupPath);
    }

    result.applied.push(migration.id);

    db.transaction(() => {
      for (const sql of migration.sql) db.exec(sql);
      db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        now,
      );
    });
  }

  return result;
}
