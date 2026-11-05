import { randomUUID } from 'node:crypto';
import type { Database } from '../database/database.ts';
import type { ChildLogger } from '../logger/logger.ts';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface JobRecord {
  id: string;
  chat: string | null;
  name: string;
  type: string;
  state: JobState;
  progress: number;
  detail: string | null;
  resultPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface JobUpdate {
  progress?: number;
  detail?: string | null;
  resultPath?: string | null;
}

export type CancelSignal = () => boolean;

export interface RunningContext {
  id: string;
  update(change: JobUpdate): void;
  /** true quando alguém chamou cancel(id). */
  canceled(): boolean;
}

export type TaskPayload = Record<string, unknown>;
export type TaskHandler = (payload: TaskPayload, ctx: RunningContext) => Promise<void>;

interface TaskRunnerDeps {
  db: Database;
  log: ChildLogger;
  /** Máquina fraca: 1 job de cada vez, por padrão. */
  concurrency?: number;
  onEvent?: (event: 'job:progress' | 'job:done', data: unknown) => void;
}

function isDbErrorUnique(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE') || message.includes('2067');
}

export class TaskRunner {
  private readonly handlers = new Map<string, TaskHandler>();
  private readonly queue: string[] = [];
  private readonly runningIds = new Set<string>();
  private readonly cancelRequests = new Set<string>();
  private readonly concurrency: number;
  private readonly db: Database;
  private draining = false;

  constructor(private readonly deps: TaskRunnerDeps) {
    this.concurrency = Math.max(1, deps.concurrency ?? 1);
    this.db = deps.db;
  }

  register(type: string, handler: TaskHandler): void {
    this.handlers.set(type, handler);
  }

  /** Só aceita tipos registrados — nada de job "tipo mistério". */
  enqueue(input: {
    type: string;
    name: string;
    payload: TaskPayload;
    chat?: string | null;
    id?: string;
  }): JobRecord | null {
    if (!this.handlers.has(input.type)) {
      this.deps.log.warn(`nenhum handler registrado para o tipo ${input.type}`);
      return null;
    }
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const row = {
      id,
      chat: input.chat ?? null,
      name: input.name.slice(0, 200),
      type: input.type,
      state: 'queued' as JobState,
      progress: 0,
      detail: JSON.stringify(input.payload),
      resultPath: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO tasks (id, chat, name, type, state, progress, detail, result_path, error, created_at, updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.id, row.chat, row.name, row.type, row.state, row.progress, row.detail, row.resultPath, row.error, row.createdAt, row.updatedAt, row.finishedAt);
    } catch (error) {
      if (isDbErrorUnique(error)) return this.get(id);
      throw error;
    }
    this.queue.push(id);
    this.drain();
    return this.get(id);
  }

  cancel(id: string): boolean {
    const record = this.get(id);
    if (record === null) return false;
    if (record.state === 'queued') {
      const idx = this.queue.indexOf(id);
      if (idx >= 0) this.queue.splice(idx, 1);
      this.writeState(id, 'canceled', { detail: null, error: 'cancelado antes de rodar' });
      this.deps.log.info(`job cancelado na fila: ${(record.resultPath ?? record.name).slice(0, 120)}`);
      this.drain();
      return true;
    }
    if (record.state === 'running') {
      this.cancelRequests.add(id);
      this.deps.log.info(`cancelamento pedido ao job em execução: ${id}`);
      return true;
    }
    return false;
  }

  get(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return null;
    return this.rowToRecord(row);
  }

  list(options: { limit?: number; states?: JobState[] } = {}): JobRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const all = this.db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC')
      .all() as Array<Record<string, unknown>>;
    const filtered = all.filter((row) => {
      if (options.states !== undefined && !options.states.includes(row['state'] as JobState)) {
        return false;
      }
      return true;
    });
    return filtered.slice(0, limit).map((row) => this.rowToRecord(row));
  }

  counts(): { queued: number; running: number } {
    return {
      queued: this.queue.length,
      running: this.runningIds.size,
    };
  }

  /** No boot: `running` de corrida passada vira canceled honesto; `queued` re-agenda. */
  resumePending(): { resumed: string[]; canceled: string[] } {
    const resumed: string[] = [];
    const canceled: string[] = [];
    for (const row of this.db
      .prepare("SELECT id, state, type FROM tasks WHERE state IN ('queued','running')")
      .all() as Array<{ id: string; state: string; type: string }>) {
      if (!this.handlers.has(row.type)) {
        this.writeState(row.id, 'canceled', { error: 'sem handler no boot (módulo desativado)' });
        canceled.push(row.id);
        continue;
      }
      if (row.state === 'running') {
        this.writeState(row.id, 'canceled', { error: 'interrompido pelo reinício do Geraldo' });
        canceled.push(row.id);
        continue;
      }
      this.queue.push(row.id);
      resumed.push(row.id);
    }
    if (resumed.length > 0 || canceled.length > 0) {
      this.deps.log.info(`fila do boot: ${resumed.length} re-agendada(s), ${canceled.length} interrompida(s)`);
    }
    this.drain();
    return { resumed, canceled };
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    const next = (): void => {
      if (this.runningIds.size >= this.concurrency) {
        this.draining = false;
        return;
      }
      const id = this.queue.shift();
      if (id === undefined) {
        this.draining = false;
        return;
      }
      void this.start(id).then(next);
    };
    next();
  }

  private async start(id: string): Promise<void> {
    const record = this.get(id);
    if (record === null) return;
    const handler = this.handlers.get(record.type);
    if (handler === undefined) {
      this.writeState(id, 'failed', { error: 'handler removido antes de rodar' });
      return;
    }
    let payload: TaskPayload = {};
    try {
      const parsed = record.detail === null ? {} : (JSON.parse(record.detail) as unknown);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        payload = parsed as TaskPayload;
      }
    } catch {
      payload = {};
    }
    this.writeState(id, 'running', {});
    this.runningIds.add(id);
    this.deps.onEvent?.('job:progress', this.get(id));
    const context: RunningContext = {
      id,
      update: (change) => this.applyUpdate(id, change),
      canceled: () => this.cancelRequests.has(id),
    };
    try {
      await handler(payload, context);
      const current = this.get(id);
      if (current === null || current.state !== 'running') return;
      this.writeState(id, 'done', { detail: null });
      this.deps.onEvent?.('job:done', this.get(id));
    } catch (error) {
      const current = this.get(id);
      if (current !== null && current.state !== 'running') return;
      const message = error instanceof Error ? error.message : String(error);
      const canceled = this.cancelRequests.has(id);
      this.writeState(id, canceled ? 'canceled' : 'failed', { error: message.slice(0, 500) });
      this.deps.onEvent?.('job:done', this.get(id));
    } finally {
      this.cancelRequests.delete(id);
      this.runningIds.delete(id);
    }
  }

  private applyUpdate(id: string, change: JobUpdate): void {
    const parts: string[] = [];
    const values: Array<string | number | null> = [];
    const now = new Date().toISOString();
    parts.push('updated_at = ?');
    values.push(now);
    if (change.progress !== undefined) {
      const clamped = Math.min(Math.max(change.progress, 0), 1);
      parts.push('progress = ?');
      values.push(clamped);
    }
    if (change.resultPath !== undefined) {
      parts.push('result_path = ?');
      values.push(change.resultPath);
    }
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${parts.join(', ')} WHERE id = ?`).run(...values);
    // `detail` progressivo NÃO vai pro banco: lá é payload p/ retomada;
    // texto de etapa segue no evento do painel.
    this.deps.onEvent?.('job:progress', {
      ...this.get(id),
      detail: change.detail ?? this.get(id)?.detail ?? null,
    });
  }

  private writeState(
    id: string,
    state: JobState,
    extra: { detail?: string | null; error?: string | null; resultPath?: string | null },
  ): void {
    const now = new Date().toISOString();
    const finished = state === 'done' || state === 'failed' || state === 'canceled';
    const values: Array<string | number | null> = [
      state,
      extra.error !== undefined && extra.error !== null ? extra.error : null,
      extra.resultPath !== undefined ? extra.resultPath : null,
      now,
    ];
    if (finished) values.push(now);
    values.push(id);
    this.db
      .prepare(
        `UPDATE tasks SET
           state = ?,
           error = COALESCE(?, error),
           result_path = COALESCE(?, result_path),
           updated_at = ?,
           finished_at = ${finished ? '?' : 'finished_at'}
         WHERE id = ?`,
      )
      .run(...values);
  }

  private rowToRecord(row: Record<string, unknown>): JobRecord {
    return {
      id: String(row['id']),
      chat: row['chat'] === null ? null : String(row['chat']),
      name: String(row['name']),
      type: String(row['type']),
      state: String(row['state']) as JobState,
      progress: Number(row['progress']),
      detail: row['detail'] === null ? null : String(row['detail']),
      resultPath: row['result_path'] === null ? null : String(row['result_path']),
      error: row['error'] === null ? null : String(row['error']),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
      finishedAt: row['finished_at'] === null ? null : String(row['finished_at']),
    };
  }
}

export type { JobUpdate as JobChange };
