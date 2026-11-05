import { join, resolve } from 'node:path';

export interface ResolvedPaths {
  /** Raiz de todos os dados do usuário (config, banco, logs, sessão...). */
  dataDir: string;
  logDir: string;
  configPath: string;
  dbPath: string;
  sessionDir: string;
  mediaDir: string;
  backupsDir: string;
  /** ETAPA 6: binário do Piper TTS + vozes .onnx devidos. */
  piperDir: string;
  voicesDir: string;
  /** ETAPA 9: pacotes baixados/pendentes/backups do atualizador. */
  updatesDir: string;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env['GERALDO_DATA_DIR'] && env['GERALDO_DATA_DIR'].trim() !== '') {
    return resolve(env['GERALDO_DATA_DIR']);
  }
  const appData = env['APPDATA'];
  if (appData && appData.trim() !== '') return join(appData, 'Geraldo');
  // Fallbacks não-Windows (dev/testes)
  return resolve('data');
}

export function resolvePaths(dataDir: string): ResolvedPaths {
  return {
    dataDir,
    logDir: join(dataDir, 'logs'),
    configPath: join(dataDir, 'config.json'),
    dbPath: join(dataDir, 'geraldo.db'),
    sessionDir: join(dataDir, 'whatsapp-session'),
    mediaDir: join(dataDir, 'media'),
    backupsDir: join(dataDir, 'backups'),
    piperDir: join(dataDir, 'piper'),
    voicesDir: join(dataDir, 'voices'),
    updatesDir: join(dataDir, 'updates'),
  };
}
