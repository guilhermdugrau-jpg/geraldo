import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ChildLogger } from './logger.ts';

/** O Geraldo guarda 7 dias de log — depois disso apaga de verdade. */
export const LOG_KEEP_DAYS = 7;

const LOG_FILE_PATTERN = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/;

export interface PruneResult {
  removed: string[];
  kept: number;
  errored: string[];
}

/**
 * ETAPA 8: rotação por tempo dos logs JSONL (`app-AAAA-MM-DD.log`).
 * Só atinge arquivos com o padrão do Logger; qualquer outra coisa no
 * diretório é intocada (backup manual do usuário não é deletado).
 */
export function pruneOldLogFiles(
  logDir: string,
  keepDays: number,
  now = new Date(),
): PruneResult {
  const result: PruneResult = { removed: [], kept: 0, errored: [] };
  let entries: string[];
  try {
    entries = readdirSync(logDir);
  } catch {
    return result; // diretório sumiu/não dá pra ler: não derruba o Geraldo
  }

  // Corte: meia-noite de (hoje - keepDays). Log desse dia e mais novos
  // ficam; mais antigos vão embora.
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays);

  for (const name of entries) {
    const match = LOG_FILE_PATTERN.exec(name);
    if (match === null) continue;
    const fileDate = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    );
    if (Number.isNaN(fileDate.getTime())) {
      // Nome casa o regex mas a data é podre — não apaga (honesto).
      result.errored.push(name);
      continue;
    }
    if (fileDate < cutoff) {
      try {
        rmSync(join(logDir, name), { force: false });
        result.removed.push(name);
      } catch {
        result.errored.push(name);
      }
    } else {
      result.kept += 1;
    }
  }

  return result;
}

/** Tira o lixo na hora e revisa a cada 1h (timer não segura o processo). */
export function scheduleLogRetention(
  logDir: string,
  log: ChildLogger,
  opts: { keepDays?: number; intervalMs?: number } = {},
): void {
  const keepDays = opts.keepDays ?? LOG_KEEP_DAYS;
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
  const run = (): void => {
    try {
      const pruned = pruneOldLogFiles(logDir, keepDays);
      if (pruned.removed.length > 0) {
        log.info(`rotação de logs: ${String(pruned.removed.length)} arquivo(s) antigo(s) apagado(s) (> ${String(keepDays)} dias)`);
      }
      if (pruned.errored.length > 0) {
        log.warn(`rotação de logs: ${String(pruned.errored.length)} arquivo(s) não apagados (permissão/arquivo em uso)`);
      }
    } catch (error) {
      log.warn(`rotação de logs falhou (seco, sem derrubar nada): ${String(error)}`);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
}

/** Nome do arquivo de log do Logger (mantido aqui pra testes de rotação). */
export function isKeepFile(name: string, keepDays: number, now = new Date()): boolean {
  const match = LOG_FILE_PATTERN.exec(name);
  if (match === null) return true; // fora do padrão: nunca apagar por aqui
  const fileDate = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(fileDate.getTime())) return true;
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - keepDays);
  return fileDate >= cutoff;
}

/** Utilidade pra testes: idade de um arquivo em dias (via statSync). */
export function fileAgeDays(filePath: string, now = new Date()): number {
  const stat = statSync(filePath);
  return Math.floor((now.getTime() - stat.mtimeMs) / (24 * 60 * 60 * 1000));
}
