import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_CONFIG, mergeConfigPatch, isRecord, type AppConfig } from './types.ts';
import type { ResolvedPaths } from './paths.ts';

/**
 * Guarda a configuração em dataDir/config.json.
 * Nunca registra os valores no log (a chamada é quem decide).
 */
export class ConfigStore {
  private startupNotice: string | null = null;
  private readonly path: string;
  private readonly config: AppConfig;

  constructor(paths: ResolvedPaths) {
    this.path = paths.configPath;
    this.config = structuredClone(DEFAULT_CONFIG);
    this.load();
  }

  get(): AppConfig {
    return this.config;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (isRecord(raw)) mergeConfigPatch(this.config, raw);
    } catch (error) {
      // Config corrompida: move para .broken e segue com defaults.
      try {
        renameSync(this.path, `${this.path}.broken`);
      } catch {
        /* não interrompe o boot por causa disso */
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.startupNotice = `config.json inválido (movido para config.json.broken): ${detail}`;
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.config, null, 2) + '\n', 'utf8');
  }

  /** Avisos gerados na carga (ex.: config quebrada). */
  popStartupNotice(): string | null {
    const notice = this.startupNotice;
    this.startupNotice = null;
    return notice;
  }
}
