import { DatabaseSync, type StatementSync } from 'node:sqlite';

/**
 * Facade sobre node:sqlite (módulo nativo do Node 24 — sem dependência
 * binária de terceiros, ideal para a máquina alvo).
 * Sempre aplica pragmas de durabilidade/consistência na abertura.
 */
export class Database {
  readonly handle: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.handle = new DatabaseSync(path);
    this.handle.exec('PRAGMA journal_mode = WAL;');
    this.handle.exec('PRAGMA foreign_keys = ON;');
    this.handle.exec('PRAGMA busy_timeout = 5000;');
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.handle.prepare(sql);
  }

  /** Executa a função dentro de uma transação; qualquer erro faz rollback. */
  transaction<T>(fn: () => T): T {
    this.handle.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.handle.exec('COMMIT;');
      return result;
    } catch (error) {
      try {
        this.handle.exec('ROLLBACK;');
      } catch {
        /* rollback já concluído ou transação não aberta — nada a fazer */
      }
      throw error;
    }
  }

  close(): void {
    this.handle.close();
  }
}
