import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Versão do Geraldo: prefere `version.txt` na raiz do backend (que o
 * ATUALIZADOR escreve ao trocar o dist — ETAPA 9) e cai pro
 * package.json do backend quando o arquivo não existe.
 */
export function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/utils/ ou dist/utils/ → dois '..' = raiz do backend/.
    const backendDir = join(here, '..', '..');
    const versionFile = join(backendDir, 'version.txt');
    if (existsSync(versionFile)) {
      const raw = readFileSync(versionFile, 'utf8').trim().replace(/^v/i, '');
      if (/^\d+(\.\d+)+$/.test(raw)) return raw;
    }
    const pkgFile = join(backendDir, 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(pkgFile, 'utf8'));
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string') return version;
    }
  } catch {
    /* usa fallback */
  }
  return '0.0.0-dev';
}
