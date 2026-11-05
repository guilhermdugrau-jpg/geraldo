import type { Database } from '../database/database.ts';
import type { AISettings } from '../config/types.ts';

/** Espelha SystemSnapshot['whatsapp'] (estado reduzido pro painel). */
export type ModuleWhatsappState = 'disconnected' | 'qr' | 'connected';

export interface DashboardStats {
  ok: true;
  whatsapp: { state: ModuleWhatsappState; note: string };
  ai: { provider: string; model: string; configured: boolean };
  conversations: { total: number; last24h: number };
  messages: { total: number; last24h: number };
  media: { totalBytes: number; byCategory: Record<string, number> };
  tasks: { queued: number; running: number; done: number; failed: number; canceled: number };
}

export interface StatsDeps {
  db: Database;
  effectiveAI: () => AISettings;
  /** Estado REAL do WhatsApp (nada de "chega na ETAPA 2"). */
  whatsappInfo: () => { state: ModuleWhatsappState; note: string };
  /** Fila viva do TaskRunner (em memória). */
  taskCounts: () => { queued: number; running: number };
}

interface CountRow {
  n: unknown;
}

function num(rows: Array<{ n: unknown }>): number {
  const row = rows[0];
  return row === undefined ? 0 : Number(row.n);
}

/**
 * ETAPA 8: contagens agregadas reais do banco pro dashboard — SQL de
 * contagem barata (SQLite), nada de inventar número. Estado do WhatsApp
 * vem do serviço vivo; IA vem do overlay efetivo (mesma fonte do engine).
 */
export class StatsService {
  constructor(private readonly deps: StatsDeps) {}

  snapshot(now = new Date()): DashboardStats {
    const db = this.deps.db;
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const conversationsTotal = num(
      db
        .prepare(`SELECT COUNT(*) AS n FROM conversations`)
        .all() as unknown as Array<CountRow>,
    );
    const conversations24h = num(
      db
        .prepare(`SELECT COUNT(*) AS n FROM conversations WHERE updated_at >= ?`)
        .all(since24h) as unknown as Array<CountRow>,
    );
    const messagesTotal = num(
      db.prepare(`SELECT COUNT(*) AS n FROM messages`).all() as unknown as Array<CountRow>,
    );
    const messages24h = num(
      db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?`)
        .all(since24h) as unknown as Array<CountRow>,
    );

    const byCategory: Record<string, number> = {};
    let totalBytes = 0;
    for (const row of db
      .prepare(`SELECT category, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM media_files GROUP BY category`)
      .all() as unknown as Array<CountRow & { category: string; b: unknown }>) {
      byCategory[row.category] = Number(row.n);
      totalBytes += Number(row.b);
    }

    const taskStates: Record<'queued' | 'running' | 'done' | 'failed' | 'canceled', number> = {
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      canceled: 0,
    };
    const live = this.deps.taskCounts();
    taskStates.queued = Math.max(taskStates.queued, live.queued);
    taskStates.running = Math.max(taskStates.running, live.running);
    for (const row of db
      .prepare(`SELECT state, COUNT(*) AS n FROM tasks GROUP BY state`)
      .all() as unknown as Array<CountRow & { state: string }>) {
      // O banco é histórico (estado pode ter travado em 'running' se o
      // boot matou a fila) — a fila viva do runner é a fonte da verdade
      // para queued/running; done/failed/canceled só existem no banco.
      if (row.state === 'done' || row.state === 'failed' || row.state === 'canceled') {
        taskStates[row.state] = Number(row.n);
      } else if (row.state === 'running') {
        taskStates.running = Math.max(taskStates.running, Number(row.n));
      } else if (row.state === 'queued') {
        taskStates.queued = Math.max(taskStates.queued, Number(row.n));
      }
    }

    const ai = this.deps.effectiveAI();
    return {
      ok: true,
      whatsapp: this.deps.whatsappInfo(),
      ai: {
        provider: ai.provider,
        model: ai.model,
        configured: ai.provider !== 'disabled' && ai.model.trim() !== '',
      },
      conversations: { total: conversationsTotal, last24h: conversations24h },
      messages: { total: messagesTotal, last24h: messages24h },
      media: { totalBytes, byCategory },
      tasks: taskStates,
    };
  }
}
