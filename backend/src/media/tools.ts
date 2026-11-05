import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface MediaTools {
  ytdlpPath: string | null;
  ffmpegPath: string | null;
  ytdlpVersion: string | null;
  ffmpegVersion: string | null;
  checkedAt: string;
}

export interface ToolResolverOptions {
  overrideYtdlp?: string;
  overrideFfmpeg?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

const VERSION_TIMEOUT_MS = 6000;

/**
 * Função de versão honesta: -1 = não existe/corrupção.
 * Os caminhos candidatos seguem a ordem: override de config/env →
 * executável no PATH → locais conhecidos de instalação do winget.
 */
export type VersionVerifier = (exe: string, tool: string) => Promise<string | null>;

export async function resolveMediaTools(
  options: ToolResolverOptions = {},
  verifyVersion: VersionVerifier = runVersionProbe,
): Promise<MediaTools> {
  const env = options.env ?? process.env;
  const localAppData = env['LOCALAPPDATA'] ?? '';

  const ytdlp = await findFirst([
    options.overrideYtdlp ?? null,
    env['GERALDO_YTDLP'] ?? null,
    'yt-dlp',
    localAppData === '' ? null : join(localAppData, 'Microsoft\\WinGet\\Packages', 'yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe', 'yt-dlp.exe'),
  ], 'yt-dlp', verifyVersion);

  const ffmpeg = await findFirst([
    options.overrideFfmpeg ?? null,
    env['GERALDO_FFMPEG'] ?? null,
    'ffmpeg',
    ...(localAppData === '' ? [] : wingetFfmpegCandidates(localAppData)),
  ], 'ffmpeg', verifyVersion);

  return {
    ytdlpPath: ytdlp?.path ?? null,
    ffmpegPath: ffmpeg?.path ?? null,
    ytdlpVersion: ytdlp?.version ?? null,
    ffmpegVersion: ffmpeg?.version ?? null,
    checkedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}

function wingetFfmpegCandidates(localAppData: string): string[] {
  const packagesDir = join(localAppData, 'Microsoft', 'WinGet', 'Packages');
  const out: string[] = [];
  const packages = safeReadDir(packagesDir);
  for (const pkg of packages.filter((name) => /^Gyan\.FFmpeg|^yt-dlp\.FFmpeg/.test(name))) {
    const dir = join(packagesDir, pkg);
    for (const nested of safeReadDir(dir)) {
      const bin = join(dir, nested, 'bin', 'ffmpeg.exe');
      out.push(bin);
    }
  }
  return out;
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

interface FoundTool {
  path: string;
  version: string | null;
}

async function findFirst(candidates: Array<string | null>, name: string, verifyVersion: VersionVerifier): Promise<FoundTool | null> {
  for (const candidate of candidates) {
    if (candidate === null || candidate.trim() === '') continue;
    const tool = await probeCandidate(candidate, name, verifyVersion);
    if (tool !== null) return tool;
  }
  return null;
}

async function probeCandidate(candidate: string, name: string, verifyVersion: VersionVerifier): Promise<FoundTool | null> {
  const looksLikePath = !candidate.includes('\\') && !candidate.includes('/') && !candidate.toLowerCase().endsWith('.exe');
  if (looksLikePath) {
    // Nome nu → procura no PATH real do processo.
    const found = await findOnPath(candidate);
    if (found === null) return null;
    const version = await verifyVersion(found, name);
    return version === null ? null : { path: found, version };
  }
  if (!existsSync(candidate)) return null;
  const version = await verifyVersion(candidate, name);
  if (version === null) return null;
  if (!candidate.toLowerCase().endsWith(`${name}.exe`) && !candidate.toLowerCase().endsWith(name)) {
    // Arquivo presente mas não é o binário pedido — desumonesto aceitar.
    return null;
  }
  return { path: candidate, version };
}

function findOnPath(tool: string): Promise<string | null> {
  const where = spawn('where', [tool], { windowsHide: true });
  return collectProbeOutput(where).then((output) => {
    const first = output.split(/\r?\n/).find((line) => line.trim() !== '');
    if (first === undefined || !existsSync(first.trim())) return null;
    return first.trim();
  });
}

/** ffmpeg legado aceita só `-version`; yt-dlp aceita `--version`. */
export function versionArgsFor(tool: string): string[] {
  return tool === 'ffmpeg' ? ['-version'] : ['--version'];
}

function runVersionProbe(exe: string, tool: string): Promise<string | null> {
  const child = spawn(exe, versionArgsFor(tool), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  // yt-dlp/ffmpeg gelados (disco lento, antivírus) podem levar >1s pra imprimir versão.
  return collectProbeOutput(child, 3500).then((line) => (line.trim() === '' ? null : line.split(/\r?\n/)[0]?.trim() ?? null));
}

function collectProbeOutput(child: ReturnType<typeof spawn>, killAfterMs = VERSION_TIMEOUT_MS): Promise<string> {
  return new Promise((resolvePromise) => {
    let output = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        /* já saiu */
      }
      resolvePromise(output);
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', finish);
    child.on('close', finish);
    const timer = setTimeout(finish, killAfterMs);
    timer.unref();
  });
}
