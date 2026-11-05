import type { Database } from '../database/database.ts';
import type {
  AppConfig,
  LogLevel,
  AISettings,
  AIProviderName,
} from '../config/types.ts';
import { applyAISettings, applyUpdatesSettings } from '../config/types.ts';

/** Forma da seção updates (mesma do config; overlay do painel por cima). */
export type UpdatesSettingsShape = AppConfig['updates'];
import type { ChildLogger } from '../logger/logger.ts';

/** Valor que a UI devolve quando não quero trocar a API key. */
export const API_KEY_MASK = '********';

export interface PublicAISettings extends Omit<AISettings, 'apiKey'> {
  apiKey: string;
  hasApiKey: boolean;
  /** provider ativo + modelo configurado */
  canGenerate: boolean;
}

export interface PublicSettings {
  server: { host: string; port: number };
  log: { level: LogLevel };
  ai: PublicAISettings;
  whatsapp: { autoReconnect: boolean; respondInPrivate: boolean };
  /** ETAPA 9: mesma forma do config — mostra o overlay do banco aceso. */
  updates: UpdatesSettingsShape;
}

/**
 * Preferências editáveis do painel ficam no banco (tabela settings),
 * sobrepostas aos defaults do config. Hoje: seção `ai` (fonte única
 * para o AIEngine na ETAPA 3) + atalhos simples (nível de log, reconexão).
 */
export class SettingsService {
  private cache: AISettings | null = null;

  constructor(
    private readonly db: Database,
    private readonly getConfig: () => AppConfig,
    private readonly applyConfigPatch: (patch: {
      logLevel?: LogLevel;
      whatsappAutoReconnect?: boolean;
      whatsappRespondInPrivate?: boolean;
    }) => void,
    private readonly logger: ChildLogger,
    private readonly onChanged: () => void,
  ) {}

  /** Configurações efetivas de IA (config × overrides no banco). */
  effectiveAI(): AISettings {
    if (this.cache) return this.cache;
    const base: AISettings = structuredClone(this.getConfig().ai);
    const raw = this.readRow('ai');
    if (isUnknownRecord(raw)) {
      try {
        applyAISettings(base, raw);
      } catch (error) {
        this.logger.warn(`override de IA no banco inválido: ${String(error)}`);
      }
    }
    this.cache = base;
    return base;
  }

  /** Atualiza com whitelist; qualquer campo inválido é descartado. */
  updateAI(patch: Record<string, unknown>): PublicAISettings {
    const next: AISettings = structuredClone(this.effectiveAI());
    applyAISettings(next, patch);
    this.writeRow('ai', next);
    this.cache = next;
    this.logger.info('configurações de IA atualizadas', {
      provider: next.provider,
      model: next.model,
    });
    this.onChanged();
    return this.maskAI(next);
  }

  /** Configurações efetivas do atualizador (config × overlay do banco). */
  effectiveUpdates(): UpdatesSettingsShape {
    const base = structuredClone(this.getConfig().updates);
    const raw = this.readRow('updates');
    if (isUnknownRecord(raw)) {
      try {
        applyUpdatesSettings(base, raw);
      } catch (error) {
        this.logger.warn(`override de atualizações no banco inválido: ${String(error)}`);
      }
    }
    return base;
  }

  /** Atualiza a seção updates do painel com whitelist. */
  updateUpdates(patch: Record<string, unknown>): UpdatesSettingsShape {
    const next = structuredClone(this.effectiveUpdates());
    applyUpdatesSettings(next, patch);
    this.writeRow('updates', next);
    this.logger.info('configurações de updates atualizadas', {
      owner: next.owner,
      repo: next.repo,
      channel: next.channel,
    });
    this.onChanged();
    return next;
  }

  setLogLevel(level: LogLevel): void {
    this.applyConfigPatch({ logLevel: level });
  }

  setWhatsappAutoReconnect(value: boolean): void {
    this.applyConfigPatch({ whatsappAutoReconnect: value });
  }

  setWhatsappRespondInPrivate(value: boolean): void {
    this.applyConfigPatch({ whatsappRespondInPrivate: value });
  }

  /** Mapa completo para o painel — API keys sempre mascaradas. */
  getPublic(): PublicSettings {
    const config = this.getConfig();
    return {
      server: { host: config.server.host, port: config.server.port },
      log: { level: config.log.level },
      ai: this.maskAI(this.effectiveAI()),
      whatsapp: {
        autoReconnect: config.whatsapp.autoReconnect,
        respondInPrivate: config.whatsapp.respondInPrivate,
      },
      updates: this.effectiveUpdates(),
    };
  }

  private maskAI(ai: AISettings): PublicAISettings {
    const { apiKey, ...rest } = ai;
    return {
      ...rest,
      apiKey: apiKey !== '' ? API_KEY_MASK : '',
      hasApiKey: apiKey !== '',
      canGenerate: ai.provider !== 'disabled' && ai.model.trim() !== '',
    };
  }

  private readRow(key: string): unknown {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  }

  private writeRow(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
