import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  pickBundleAsset,
  pickChecksumAsset,
  pickReleaseForChannel,
  type ReleaseAssetInfo,
} from './githubReleases.ts';
import { isNewerVersion } from './versionUtil.ts';
import type { ChildLogger } from '../logger/logger.ts';
import type { AppConfig, UpdatesChannel } from '../config/types.ts';

export type UpdatesSettings = AppConfig['updates'];

export interface StagedUpdateInfo {
  fileName: string;
  bytes: number;
  sha256: string;
  /** null = o release não tinha checksum pra conferir (não inventamos). */
  verified: boolean | null;
  version: string | null;
  stagedAt: string;
}

export interface UpdateCheckResult {
  ok: true;
  hasUpdate: boolean;
  current: string;
  latest: string;
  prerelease: boolean;
  publishedAt: string;
  releaseUrl: string;
  notes: string | null;
  asset: ReleaseAssetInfo | null;
  checksum: ReleaseAssetInfo | null;
}

export interface UpdateStatus {
  ok: true;
  owner: string;
  repo: string;
  channel: UpdatesChannel;
  autoCheck: boolean;
  intervalHours: number;
  currentVersion: string;
  configured: boolean;
  hint: string | null;
  staged: StagedUpdateInfo | null;
  pending: { version: string } | null;
  lastCheck: { at: string; hasUpdate: boolean; latest: string | null; hint: string | null } | null;
}

export interface UpdateEngineDeps {
  log: ChildLogger;
  getUpdates: () => UpdatesSettings;
  currentVersion: () => string;
  paths: {
    /** Diretório de trabalho do atualizador: <dataDir>/updates. */
    updatesDir: string;
    /** Raiz do CÓDIGO (onde vivem backend/ e frontend/) — dados ficam fora. */
    appDir: string;
  };
  fetchJson: (
    url: string,
    headers?: Record<string, string>,
  ) => Promise<{ ok: boolean; status: number; json: unknown }>;
  fetchBytes: (
    url: string,
    maxBytes: number,
  ) => Promise<{ ok: boolean; status: number | null; bytes: Buffer | null }>;
  extractZip: (zipPath: string, destDir: string) => Promise<void>;
  onEvent?: (event: string, data: unknown) => void;
}

/** Teto do pacote (dist compactado não deveria chegar perto disso). */
export const MAX_BUNDLE_BYTES = 400 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;

const GITHUB_HEADERS: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};

interface StagedMetadata extends StagedUpdateInfo {
  downloadUrl?: string;
}

interface ManifestFile {
  version: string;
  dirs: number;
  preparedAt: string;
}

type CheckOutcome = UpdateCheckResult | { ok: false; error: string; hint: string | null };

/**
 * ETAPA 9: atualizador automático via GitHub Releases (API pública —
 * SEM token pra ler). Regras duras do projeto vivem aqui:
 * - dados do usuário (%APPDATA%\Geraldo) NUNCA entram na troca — só
 *   backend/dist e frontend/dist;
 * - backup da versão atual antes do swap (rollback manual documentado);
 * - SHA-256 conferido quando o release traz `<pacote>.sha256`; sem
 *   checksum, o status diz `verified: null` em vez de fingir;
 * - aplicação via helper desatachado + reinício explícito (nada de
 *   trocar código por baixo do processo vivo).
 */
export class UpdateEngine {
  private lastCheck: UpdateStatus['lastCheck'] = null;
  private timer: NodeJS.Timeout | null = null;
  private downloading = false;

  constructor(private readonly deps: UpdateEngineDeps) {}

  status(): UpdateStatus {
    const settings = this.deps.getUpdates();
    const configured = settings.owner.trim() !== '' && settings.repo.trim() !== '';
    let hint: string | null = null;
    if (!configured) {
      hint = 'Configure o repositório no painel (owner/repo) — o Geraldo busca releases públicos sem login';
    } else if (this.lastCheck !== null && this.lastCheck.hint !== null) {
      hint = this.lastCheck.hint;
    } else if (this.lastCheck === null) {
      hint = 'Sem apuração ainda — clique "verificar" ou espere o automático';
    }

    return {
      ok: true,
      owner: settings.owner,
      repo: settings.repo,
      channel: settings.channel,
      autoCheck: settings.autoCheck,
      intervalHours: settings.intervalHours,
      currentVersion: this.deps.currentVersion(),
      configured,
      hint,
      staged: readStagedMetadata(this.deps.paths.updatesDir),
      pending: readManifestOrNull(this.deps.paths.updatesDir),
      lastCheck: this.lastCheck,
    };
  }

  /** Rede real: releases do repo público — erro do GitHub volta honesto. */
  async check(): Promise<CheckOutcome> {
    const settings = this.deps.getUpdates();
    if (settings.owner.trim() === '' || settings.repo.trim() === '') {
      this.lastCheck = {
        at: new Date().toISOString(),
        hasUpdate: false,
        latest: null,
        hint: 'repositório não configurado — painel → Atualizações',
      };
      return { ok: false, error: 'Repositório não configurado (owner/repo) no painel', hint: null };
    }

    const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/releases?per_page=20`;
    let response: { ok: boolean; status: number; json: unknown };
    try {
      response = await this.deps.fetchJson(url, GITHUB_HEADERS);
    } catch (error) {
      this.lastCheck = {
        at: new Date().toISOString(),
        hasUpdate: false,
        latest: null,
        hint: `GitHub inacessível: ${describeUnknown(error)}`,
      };
      return { ok: false, error: `verificação falhou de rede: ${describeUnknown(error)}`, hint: null };
    }

    if (!response.ok) {
      const hint = githubErrorHint(response.status, settings.owner, settings.repo);
      this.lastCheck = { at: new Date().toISOString(), hasUpdate: false, latest: null, hint };
      return { ok: false, error: `GitHub respondeu HTTP ${String(response.status)}`, hint };
    }
    if (!Array.isArray(response.json)) {
      this.lastCheck = {
        at: new Date().toISOString(),
        hasUpdate: false,
        latest: null,
        hint: 'GitHub devolveu algo fora do esperado (não era lista de releases)',
      };
      return { ok: false, error: 'resposta do GitHub não é lista de releases', hint: null };
    }

    const chosen = pickReleaseForChannel(response.json, settings.channel);
    if (chosen === null) {
      this.lastCheck = {
        at: new Date().toISOString(),
        hasUpdate: false,
        latest: null,
        hint: `${settings.owner}/${settings.repo} não tem release publicada no canal "${settings.channel}" — publique a primeira (tag v0.1.0)`,
      };
      return { ok: false, error: 'nenhum release público nesse canal', hint: this.lastCheck.hint };
    }

    const asset = pickBundleAsset(chosen);
    const checksum = asset === null ? null : pickChecksumAsset(chosen, asset.name);
    const current = this.deps.currentVersion();
    const hasUpdate = isNewerVersion(current, chosen.tagName);
    this.lastCheck = {
      at: new Date().toISOString(),
      hasUpdate,
      latest: chosen.tagName,
      hint: hasUpdate && asset === null
        ? 'release nova não tem pacote .zip — é preciso publicar o bundle junto'
        : null,
    };
    this.deps.log.info(
      `verificação de atualização: atual=${current} · última=${chosen.tagName} · canal=${settings.channel} · nova=${String(hasUpdate)}`,
    );
    if (hasUpdate) {
      this.deps.onEvent?.('updates:available', { latest: chosen.tagName, current, channel: settings.channel });
    }
    return {
      ok: true,
      hasUpdate,
      current,
      latest: chosen.tagName,
      prerelease: chosen.prerelease,
      publishedAt: chosen.publishedAt,
      releaseUrl: chosen.htmlUrl,
      notes: chosen.notes,
      asset,
      checksum,
    };
  }

  /**
   * Verifica e baixa o pacote `.zip` do release apurado pra
   * `<updatesDir>/staged/`. Checksum do release é conferido de verdade
   * — hash furado recusa o pacote na hora; sem checksum, honestidade:
   * `verified: null`.
   */
  async stage(): Promise<StagedUpdateInfo> {
    if (this.downloading) {
      throw new Error('já tem download de atualização em andamento');
    }
    const found = await this.check();
    if (!found.ok) {
      throw new Error(`não dá pra baixar sem verificar antes: ${found.error}`);
    }
    if (!found.hasUpdate) {
      throw new Error(`sem atualização pra baixar (já tá na versão ${found.current})`);
    }
    if (found.asset === null) {
      throw new Error('o release novo não tem pacote .zip — publique o bundle junto do release');
    }
    const bundle = found.asset;
    if (bundle.size > MAX_BUNDLE_BYTES) {
      throw new Error(`pacote de ${String(bundle.size)} bytes passa do teto de ${String(MAX_BUNDLE_BYTES)}`);
    }

    this.downloading = true;
    try {
      const stagedDir = join(this.deps.paths.updatesDir, 'staged');
      mkdirSync(stagedDir, { recursive: true });
      const downloaded = await this.deps.fetchBytes(bundle.downloadUrl, MAX_BUNDLE_BYTES);
      if (!downloaded.ok || downloaded.bytes === null) {
        throw new Error(`baixa falhou (HTTP ${String(downloaded.status ?? '?')}) — nada foi guardado`);
      }

      const sha256 = createHash('sha256').update(downloaded.bytes).digest('hex');
      let verified: boolean | null = null;
      if (found.checksum !== null) {
        const checksumFetch = await this.deps.fetchBytes(found.checksum.downloadUrl, MAX_CHECKSUM_BYTES);
        const content = checksumFetch.ok && checksumFetch.bytes !== null
          ? checksumFetch.bytes.toString('utf8')
          : null;
        const expected = content !== null ? extractChecksumHash(content, bundle.name) : null;
        if (expected !== null) {
          verified = expected === sha256;
          if (verified === false) {
            throw new Error('SHA-256 do pacote NÃO bate com o checksum do release — recusado (nada foi guardado)');
          }
        }
      }

      writeFileSync(join(stagedDir, bundle.name), downloaded.bytes);
      const staged: StagedUpdateInfo = {
        fileName: bundle.name,
        bytes: downloaded.bytes.length,
        sha256,
        verified,
        version: cleanVersion(found.latest),
        stagedAt: new Date().toISOString(),
      };
      writeFileSync(
        join(stagedDir, 'staged.json'),
        JSON.stringify({ ...staged, downloadUrl: bundle.downloadUrl }, null, 2),
      );
      this.deps.log.info(
        `pacote de atualização baixado: ${bundle.name} (${String(downloaded.bytes.length)} bytes · checksum ${
          verified === null ? 'não conferido (sem checksum no release)' : verified ? 'confere' : 'recusado antes'
        })`,
      );
      return staged;
    } finally {
      this.downloading = false;
    }
  }

  /** Descarta o pacote baixado (e o staged.json junto). */
  discardStaged(): void {
    rmSync(join(this.deps.paths.updatesDir, 'staged'), { recursive: true, force: true });
    this.deps.log.info('pacote de atualização descartado');
  }

  /**
   * Extrai o pacote baixado e valida o conteúdo mínimo (version.txt +
   * backend/ + frontend/). Nada do código vivo é tocado aqui — a troca
   * fica com o helper desatachado no `apply()`.
   */
  async prepare(): Promise<{ version: string; dirs: number }> {
    const staged = readStagedMetadata(this.deps.paths.updatesDir);
    if (staged === null) {
      throw new Error('nada baixado ainda — aperte "baixar pacote" antes de preparar');
    }
    const zipPath = join(this.deps.paths.updatesDir, 'staged', staged.fileName);
    if (!existsSync(zipPath)) {
      throw new Error(`pacote sumiu do disco (${staged.fileName}) — baixa de novo`);
    }

    const pendingDir = join(this.deps.paths.updatesDir, 'pending');
    rmSync(pendingDir, { recursive: true, force: true });
    mkdirSync(pendingDir, { recursive: true });
    await this.deps.extractZip(zipPath, pendingDir);

    const versionPath = join(pendingDir, 'version.txt');
    if (!existsSync(versionPath)) {
      rmSync(pendingDir, { recursive: true, force: true });
      throw new Error('bundle sem version.txt — pacote estranho, recusado');
    }
    const bundleVersion = readFileSync(versionPath, 'utf8').trim().replace(/^v/i, '');
    if (!/^\d+(\.\d+)+$/.test(bundleVersion)) {
      rmSync(pendingDir, { recursive: true, force: true });
      throw new Error(`version.txt do bundle não trouxe versão legível ("${bundleVersion}") — recusado`);
    }

    let dirs = 0;
    for (const required of ['backend', 'frontend']) {
      if (!existsSync(join(pendingDir, required))) {
        rmSync(pendingDir, { recursive: true, force: true });
        throw new Error(`bundle sem ${required}/ — recusado (o pacote precisa dos dois)`);
      }
      dirs += 1;
    }

    writeFileSync(
      join(pendingDir, 'manifest.json'),
      JSON.stringify({ version: bundleVersion, dirs, preparedAt: new Date().toISOString() }, null, 2),
    );
    this.deps.log.info(
      `pacote preparado: versão ${bundleVersion} (${String(dirs)} partes) — pronto pra aplicar com reinício`,
    );
    return { version: bundleVersion, dirs };
  }

  /**
   * Dispara o helper DESATACHADO que troca backend/dist e
   * frontend/dist pelo pending/ (com backup antes). A rota devolve 202
   * e encerra este servidor logo depois — quem reabre é o START.bat.
   */
  apply(): { ok: true; message: string } {
    const manifest = readManifest(this.deps.paths.updatesDir);
    if (manifest === null) {
      throw new Error('nada preparado — baixe e prepare o pacote antes de aplicar');
    }
    const pendingDir = join(this.deps.paths.updatesDir, 'pending');
    const scriptPath = writeApplyScript(this.deps.paths.updatesDir, {
      pendingDir,
      appDir: this.deps.paths.appDir,
      currentVersion: this.deps.currentVersion(),
      newVersion: manifest.version,
    });
    const child = spawn('cmd', ['/c', 'start', '"Geraldo update"', '/MIN', scriptPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref?.();
    this.deps.log.warn(
      `helper de atualização disparado (versão ${manifest.version}) — este Geraldo fecha; reabrir com START.bat`,
    );
    return {
      ok: true,
      message: `aplicando ${manifest.version}: o Geraldo fecha em instantes — abre de novo com START.bat`,
    };
  }

  /** Automático (boot): confere a cada intervalHours quando configurado. */
  startAutoCheck(): void {
    const settings = this.deps.getUpdates();
    if (!settings.autoCheck) {
      this.deps.log.info('atualização automática desligada (config)');
      return;
    }
    if (settings.owner.trim() === '' || settings.repo.trim() === '') {
      this.deps.log.warn('atualização automática ligada, mas owner/repo vazio — começa quando configurar no painel');
      return;
    }
    const intervalMs = Math.max(settings.intervalHours, 1) * 60 * 60 * 1000;
    this.timer = setInterval(() => {
      if (this.downloading) return;
      void this.check().catch((error: unknown) => {
        this.deps.log.warn(
          `checagem automática falhou (tenta de novo em ${String(settings.intervalHours)}h): ${describeUnknown(error)}`,
        );
      });
    }, intervalMs);
    this.timer.unref?.();
    this.deps.log.info(
      `atualização automática ligada (${String(settings.intervalHours)} h) — canal ${settings.channel}`,
    );
  }

  stopAutoCheck(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ── helpers de disco/leitura ────────────────────────────────────────────

function readStagedMetadata(updatesDir: string): StagedMetadata | null {
  const metaPath = join(updatesDir, 'staged', 'staged.json');
  if (!existsSync(metaPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
    const fileName = typeof raw['fileName'] === 'string' ? raw['fileName'] : '';
    if (fileName === '') return null;
    return {
      fileName,
      bytes: typeof raw['bytes'] === 'number' ? raw['bytes'] : 0,
      sha256: typeof raw['sha256'] === 'string' ? raw['sha256'] : '',
      verified: typeof raw['verified'] === 'boolean' ? raw['verified'] : null,
      version: typeof raw['version'] === 'string' ? raw['version'] : null,
      stagedAt: typeof raw['stagedAt'] === 'string' ? raw['stagedAt'] : '',
      downloadUrl: typeof raw['downloadUrl'] === 'string' ? raw['downloadUrl'] : undefined,
    };
  } catch {
    return null;
  }
}

function readManifest(updatesDir: string): ManifestFile | null {
  const path = join(updatesDir, 'pending', 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const version = typeof raw['version'] === 'string' ? raw['version'] : '';
    return version === ''
      ? null
      : {
          version,
          dirs: typeof raw['dirs'] === 'number' ? raw['dirs'] : 0,
          preparedAt: typeof raw['preparedAt'] === 'string' ? raw['preparedAt'] : '',
        };
  } catch {
    return null;
  }
}

function readManifestOrNull(updatesDir: string): { version: string } | null {
  const manifest = readManifest(updatesDir);
  return manifest === null ? null : { version: manifest.version };
}

function githubErrorHint(status: number, owner: string, repo: string): string {
  if (status === 404) return `repositório ${owner}/${repo} não encontrado — owner/repo certos e repo público?`;
  if (status === 403) return 'GitHub recusou por limite (60 pedidos/h de acesso anônimo) — tenta mais tarde';
  if (status === 401) return 'GitHub pediu autenticação (endpoint restrito) — confere owner/repo';
  if (status === 301 || status === 302) return 'repositório movido/renomeado — atualiza owner/repo no painel';
  return 'GitHub respondeu inesperado — tenta de novo em instantes';
}

export function extractChecksumHash(content: string, bundleName: string): string | null {
  const lowered = bundleName.toLowerCase();
  for (const line of content.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (match === null || match[1] === undefined) continue;
    const hash = match[1].toLowerCase();
    const fileName = (match[2] ?? '').toLowerCase();
    if (fileName === '' || fileName === lowered) return hash;
  }
  const only = content.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(only) ? only : null;
}

/** 'v0.2.0' → '0.2.0'; só mantém semver enxuto (sem chute). */
export function cleanVersion(tagName: string): string | null {
  const text = tagName.trim().replace(/^v/i, '');
  return /^\d+(\.\d+)+$/.test(text) ? text : null;
}

// ── script do helper desatachado ────────────────────────────────────────

export interface ApplyScriptOpts {
  pendingDir: string;
  appDir: string;
  currentVersion: string;
  newVersion: string;
  /** Injetável nos testes (sandbox não pode dormir 2 s sem fim). */
  waitSeconds?: number;
}

/**
 * Escreve apply-update.cmd: backup das versões rodando → troca /MIR
 * dos dists. NÃO toca package.json, node_modules, banco, config nem
 * sessão (se um release mudar dependências, o UPDATE_GUIDE manda rodar
 * `npm install` — essa condição é documentada, não escondida).
 */
export function writeApplyScript(updatesDir: string, opts: ApplyScriptOpts): string {
  const backupDir = join(updatesDir, 'backups', `${opts.currentVersion}-antes-${stamp()}`);
  const wait = opts.waitSeconds ?? 2;
  const pendingBackend = join(opts.pendingDir, 'backend');
  const pendingFrontend = join(opts.pendingDir, 'frontend');
  const appBackendDist = join(opts.appDir, 'backend', 'dist');
  const appFrontendDist = join(opts.appDir, 'frontend', 'dist');
  const appBackendRoot = join(opts.appDir, 'backend');
  const lines = [
    '@echo off',
    'setlocal',
    'chcp 65001 >nul',
    `rem Geraldo AI - troca de versao ${opts.currentVersion} -> ${opts.newVersion}`,
    `rem Dados do usuario (%APPDATA%\\Geraldo: banco, config, sessao, logs) NAO sao tocados.`,
    `rem gerado em ${new Date().toISOString()}`,
    `timeout /t ${String(wait)} /nobreak >nul`,
    `mkdir "${backupDir}" 2>nul`,
    `robocopy "${appBackendDist}" "${join(backupDir, 'backend-dist')}" /E /NFL /NDL /NJH /NJS /NP >nul`,
    `robocopy "${appFrontendDist}" "${join(backupDir, 'frontend-dist')}" /E /NFL /NDL /NJH /NJS /NP >nul`,
    `robocopy "${pendingBackend}" "${appBackendDist}" /MIR /NFL /NDL /NJH /NJS /NP >nul`,
    `robocopy "${pendingFrontend}" "${appFrontendDist}" /MIR /NFL /NDL /NJH /NJS /NP >nul`,
    `copy /Y "${join(opts.pendingDir, 'version.txt')}" "${join(appBackendRoot, 'version.txt')}" >nul`,
    `if exist "${join(opts.pendingDir, 'START.bat')}" copy /Y "${join(opts.pendingDir, 'START.bat')}" "${join(opts.appDir, 'START.bat')}" >nul`,
    `if %ERRORLEVEL% GEQ 8 echo HOUVE FALHA na copia — backups da versao anterior ficam em ${backupDir} (restauravel).`,
    `echo Geraldo ${opts.newVersion}: pacote aplicado. Abra o painel pelo START.bat.`,
    'pause',
    'endlocal',
    'exit /b 0',
  ];
  const path = join(updatesDir, 'apply-update.cmd');
  writeFileSync(path, lines.join('\r\n') + '\r\n', 'utf8');
  return path;
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function describeUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
