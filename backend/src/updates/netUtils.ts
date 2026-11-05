/**
 * Rede do atualizador (ETAPA 9) — wrappers de `fetch` com teto e
 * timeout, no mesmo espírito do downloadBinary do voiceEngine. Aqui
 * NÃO entra token nenhum: a API de releases pública é anônima.
 */
import { spawn } from 'node:child_process';

export interface GithubJsonResponse {
  ok: boolean;
  status: number;
  json: unknown;
}

export interface GithubBytesResponse {
  ok: boolean;
  status: number | null;
  bytes: Buffer | null;
}

const USER_AGENT = 'GeraldoAI-updater/0.1 (Windows; Node)';

/** GET JSON com timeout curto (API do GitHub pública). */
export async function githubFetchJson(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<GithubJsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { ...headers, 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
    const json: unknown = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** GET binário com teto de bytes — passa do teto → falha e NÃO guarda. */
export async function githubFetchBytes(
  url: string,
  maxBytes: number,
  timeoutMs = 10 * 60 * 1000,
): Promise<GithubBytesResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, bytes: null };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      return { ok: false, status: response.status, bytes: null };
    }
    return { ok: true, status: response.status, bytes: buffer };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extração via tar.exe (bsdtar lê zip no Windows 10+; zero
 * dependência) — mesmo padrão do voiceEngine.
 */
export function extractZipBundle(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let stderr = '';
    const child = spawn('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      rejectPromise(new Error(`tar inacessível: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`tar falhou extraindo o pacote de atualização: ${stderr.slice(-200)}`));
    });
  });
}
