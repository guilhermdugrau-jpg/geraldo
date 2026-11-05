/**
 * Resolvedor de ferramentas de VOZ (ETAPA 6): binário piper.exe e vozes
 * `.onnx` do Piper TTS (repo rhasspy/piper-voices no Hugging Face).
 *
 * O piper instalado do release 2023.11.14-2 fica em
 * `<dataDir>/piper/piper/piper.exe` (zip vem com a pasta `piper/` dentro) —
 * candidatos: env GERALDO_PIPER → layout instalado pelo Geraldo → PATH.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface PiperTool {
  piperPath: string | null;
  version: string | null;
  checkedAt: string;
}

export interface VoiceModel {
  /** ex.: "pt_BR-faber-medium" (nome do .onnx sem extensão). */
  id: string;
  label: string;
  quality: string;
  filePath: string;
  jsonPath: string;
  bytes: number;
}

export interface VoiceTools {
  piper: PiperTool;
  voices: VoiceModel[];
  voicesDir: string;
  hint: string | null;
}

/** Vozes pt_BR publicadas no HF (rhasspy/piper-voices, main). */
export const PIPER_PT_BR_VOICES = [
  { id: 'pt_BR-faber-medium', speaker: 'faber', quality: 'medium', label: 'Faber' },
  { id: 'pt_BR-cadu-medium', speaker: 'cadu', quality: 'medium', label: 'Cadu' },
  { id: 'pt_BR-jeff-medium', speaker: 'jeff', quality: 'medium', label: 'Jeff' },
  { id: 'pt_BR-edresson-low', speaker: 'edresson', quality: 'low', label: 'Edresson' },
] as const;

const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR';
const ZIP_URL =
  'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';

/** URLs honestas pros dois downloads (voz + config json) e pro zip do piper. */
export function pingFileUrls(voiceId: string): { onnx: string; json: string } | null {
  const entry = PIPER_PT_BR_VOICES.find((voice) => voice.id === voiceId);
  if (entry === undefined) return null;
  const base = `${HF_BASE}/${entry.speaker}/${entry.quality}/${voiceId}`;
  return { onnx: `${base}.onnx`, json: `${base}.onnx.json` };
}

export function piperZipUrl(): string {
  return ZIP_URL;
}

/** `--version` do piper de verdade; null = binário morto/ausente/inválido. */
export function probePiperVersion(exe: string, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess | null = null;
    let output = '';
    let done = false;
    const finish = (version: string | null): void => {
      if (done) return;
      done = true;
      try { child?.kill(); } catch { /* já saiu */ }
      resolvePromise(version);
    };
    // Arquivo não-executável/caminho podre lança EFTYPE sincronamente no Windows.
    try {
      child = spawn(exe, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(null);
      return;
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 && output.trim() !== '' ? output.trim() : null));
    const timer = setTimeout(() => finish(output.trim() !== '' ? output.trim() : null), timeoutMs);
    timer.unref();
  });
}

/** Vozes válidas no diretório: .onnx com .onnx.json do lado e tamanho real. */
export function listVoiceFiles(voicesDir: string): VoiceModel[] {
  let names: string[] = [];
  try {
    names = readdirSync(voicesDir);
  } catch {
    return [];
  }
  const voices: VoiceModel[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.onnx')) continue;
    const base = name.slice(0, -5);
    const jsonPath = join(voicesDir, `${base}.onnx.json`);
    const filePath = join(voicesDir, name);
    if (!existsSync(jsonPath)) continue;
    try {
      const bytes = statSync(filePath).size;
      const meta = PIPER_PT_BR_VOICES.find((voice) => voice.id === base);
      const quality = base.split('-').pop() ?? '';
      voices.push({
        id: base,
        label: meta?.label ?? base.replace(/^pt_BR-/, '').replace(`-${quality}`, ''),
        quality,
        filePath,
        jsonPath,
        bytes,
      });
    } catch {
      /* estatística falhou — segue o baile */
    }
  }
  return voices.sort((a, b) => a.id.localeCompare(b.id));
}

export interface PiperResolverOptions {
  env?: NodeJS.ProcessEnv;
  piperDir: string;
  voicesDir: string;
}

export async function resolveVoiceTools(options: PiperResolverOptions): Promise<VoiceTools> {
  const env = options.env ?? process.env;
  const candidates = [
    env['GERALDO_PIPER'] ?? null,
    join(options.piperDir, 'piper', 'piper.exe'),
    join(options.piperDir, 'piper.exe'),
    'piper',
  ];
  let piperPath: string | null = null;
  let version: string | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate.trim() === '') continue;
    const looksLikeName = !candidate.includes('\\') && !candidate.includes('/');
    if (looksLikeName) {
      // Nome nu: o PATH do processo resolve (spawn erra honesto).
      try {
        const versionProbe = await probePiperVersion(candidate);
        if (versionProbe === null) continue;
        piperPath = candidate;
        version = versionProbe;
        break;
      } catch {
        continue;
      }
    }
    if (!existsSync(candidate)) continue;
    const versionProbe = await probePiperVersion(candidate);
    if (versionProbe === null) continue;
    piperPath = candidate;
    version = versionProbe;
    break;
  }

  const voices = listVoiceFiles(options.voicesDir);
  const hints: string[] = [];
  if (piperPath === null) {
    hints.push('Piper ausente — instale pelo botão do painel (baixa o zip do release e extrai)');
  }
  if (voices.length === 0) {
    hints.push('nenhuma voz pt_BR instalada — baixa uma pelo painel (faber/cadu/jeff/edresson)');
  }

  return {
    piper: { piperPath, version, checkedAt: new Date().toISOString() },
    voices,
    voicesDir: options.voicesDir,
    hint: hints.length === 0 ? null : hints.join(' · '),
  };
}
