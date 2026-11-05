import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  UpdateEngine,
  cleanVersion,
  writeApplyScript,
  extractChecksumHash,
  type UpdateEngineDeps,
} from '../updates/updateEngine.ts';
import { extractZipBundle, githubFetchJson } from '../updates/netUtils.ts';
import { parseVersion, isNewerVersion } from '../updates/versionUtil.ts';
import {
  parseRelease,
  pickBundleAsset,
  pickChecksumAsset,
  pickReleaseForChannel,
} from '../updates/githubReleases.ts';
import { Logger } from '../logger/logger.ts';

const execAsync = promisify(execFile);

// ── versionUtil ─────────────────────────────────────────────────────────
describe('ETAPA 9: versionUtil', () => {
  it('parseVersion lê semver, prefixo v e datas do GitHub', () => {
    assert.deepEqual(parseVersion('0.1.0')?.segments, [0, 1, 0]);
    assert.deepEqual(parseVersion('v1.2.3')?.segments, [1, 2, 3]);
    assert.deepEqual(parseVersion('2026.10.26')?.segments, [2026, 10, 26]);
    assert.equal(parseVersion('1.2.3-rc1')?.prerelease, 'rc1');
    assert.equal(parseVersion('la banana'), null);
    assert.equal(parseVersion(''), null);
  });

  it('isNewerVersion: igual/antiga/mais nova e pré-release abaixo da final', () => {
    assert.equal(isNewerVersion('0.1.0', '0.1.0'), false);
    assert.equal(isNewerVersion('0.1.0', '0.1.1'), true);
    assert.equal(isNewerVersion('0.2.0', '0.1.9'), false);
    assert.equal(isNewerVersion('0.1.0', 'v0.2.0'), true);
    assert.equal(isNewerVersion('0.1.0', '2026.10.26'), true);
    assert.equal(isNewerVersion('1.2.3', '1.2.3-rc1'), false); // pré perde pra final igual
    assert.equal(isNewerVersion('1.2.3-rc1', '1.2.3'), true); // final ganha da pré
    assert.equal(isNewerVersion('1.2.3-rc1', '1.2.3-rc2'), true);
    // Versão local podre ou candidata sem semver: conservador, não atualiza.
    assert.equal(isNewerVersion('banana', '0.2.0'), false);
    assert.equal(isNewerVersion('0.1.0', 'banana'), false);
  });
});

// ── githubReleases ──────────────────────────────────────────────────────
function releaseRaw(overrides: Record<string, unknown> = {}, assets: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    tag_name: 'v0.2.0',
    name: 'Geraldo 0.2.0',
    prerelease: false,
    draft: false,
    published_at: '2026-10-26T12:00:00Z',
    html_url: 'https://github.com/lucasbr3/geraldo/releases/tag/v0.2.0',
    body: 'Correção de pumpkin e raiva no bagaceis',
    assets,
    ...overrides,
  };
}

const bundleAssetRaw = {
  name: 'geraldo-0.2.0.zip',
  size: 2048,
  browser_download_url: 'https://github.com/lucasbr3/geraldo/releases/download/v0.2.0/geraldo-0.2.0.zip',
  created_at: '2026-10-26T12:01:00Z',
  content_type: 'application/zip',
};

describe('ETAPA 9: githubReleases (puro)', () => {
  it('parseRelease extrai lançamentos e descarta lixo (draft, asset podre)', () => {
    const parsed = parseRelease(releaseRaw({}, [bundleAssetRaw, { name: 'podre.zip', size: -1 }, { banana: true }]));
    assert.ok(parsed !== null);
    assert.equal(parsed.tagName, 'v0.2.0');
    assert.equal(parsed.prerelease, false);
    assert.equal(parsed.assets.length, 1);
    assert.equal(parsed.assets[0]?.name, 'geraldo-0.2.0.zip');
    assert.equal(parsed.assets[0]?.createdAt, '2026-10-26T12:01:00Z');
    // draft não tem published_at — fora. Malformado — fora.
    assert.equal(parseRelease({ tag_name: 'x', published_at: '' }), null);
    assert.equal(parseRelease('qualquer coisa'), null);
  });

  it('canal stable ignora prerelease; beta/development pegam o que sair por último', () => {
    // lista em formato CRU (o que a API do GitHub entrega) — o pick é
    // quem parseia; testar com objeto pronto seria parse duplo falso.
    const stableRaw = releaseRaw({ tag_name: 'v0.1.0', published_at: '2026-10-01T00:00:00Z' });
    const preRaw = releaseRaw({ tag_name: 'v0.2.1-rc1', prerelease: true, published_at: '2026-11-01T00:00:00Z' });
    const list: unknown[] = [stableRaw, preRaw];
    assert.equal(pickReleaseForChannel(list, 'stable')?.tagName, 'v0.1.0');
    assert.equal(pickReleaseForChannel(list, 'beta')?.tagName, 'v0.2.1-rc1');
    assert.equal(pickReleaseForChannel(list, 'development')?.tagName, 'v0.2.1-rc1');
    assert.equal(pickReleaseForChannel([], 'stable'), null);
    assert.equal(pickReleaseForChannel(['fafe'], 'stable'), null);
  });

  it('pickBundleAsset escolhe o zip mais novo (created_at); empate cai alfabético', () => {
    const release = parseRelease(
      releaseRaw(
        {},
        [
          { ...bundleAssetRaw, name: 'novo-alem.zip', created_at: '2026-10-27T00:00:00Z' },
          { ...bundleAssetRaw, name: 'geraldo-0.2.0.zip', created_at: '2026-10-26T12:00:00Z' },
          { ...bundleAssetRaw, name: 'www.zip', created_at: 'data-vaga' },
        ],
      ),
    )!;
    assert.equal(pickBundleAsset(release)?.name, 'novo-alem.zip');
    const empate = parseRelease(
      releaseRaw(
        {},
        [
          { ...bundleAssetRaw, name: 'b.zip', created_at: '2026-10-27T00:00:00Z' },
          { ...bundleAssetRaw, name: 'a.zip', created_at: '2026-10-27T00:00:00Z' },
        ],
      ),
    )!;
    assert.equal(pickBundleAsset(empate)?.name, 'a.zip');
    const semZip = parseRelease(releaseRaw({}, [{ name: 'bundle.tar.gz', size: 10, browser_download_url: 'https://x/y', created_at: '' }]));
    assert.ok(semZip !== null);
    assert.equal(pickBundleAsset(semZip), null);
  });

  it('pickChecksumAsset casa `<pacote>.sha256` sem ligar pra caixa', () => {
    const release = parseRelease(releaseRaw({}, [bundleAssetRaw, { ...bundleAssetRaw, name: 'GERALDO-0.2.0.ZIP.SHA256' }]))!;
    assert.equal(pickChecksumAsset(release, 'geraldo-0.2.0.zip')?.name, 'GERALDO-0.2.0.ZIP.SHA256');
    assert.equal(pickChecksumAsset(release, 'outro.zip'), null);
  });

  it('extractChecksumHash aceita os formatos de checksum de praxe', () => {
    const hash = 'a'.repeat(64);
    const upper = 'B'.repeat(64);
    assert.equal(extractChecksumHash(`${hash}  geraldo-0.2.0.zip`, 'geraldo-0.2.0.zip'), hash);
    assert.equal(extractChecksumHash(`${hash} *geraldo-0.2.0.zip`, 'geraldo-0.2.0.zip'), hash);
    assert.equal(extractChecksumHash(hash, 'geraldo-0.2.0.zip'), hash);
    assert.equal(extractChecksumHash(hash.toUpperCase(), 'x.zip'), hash); // minúscula sempre
    assert.equal(extractChecksumHash(`${upper} outro-arquivo.zip`, 'geraldo.zip'), null); // nome diferente
    assert.equal(extractChecksumHash('banana', 'geraldo.zip'), null);
  });

  it('cleanVersion tira o v e só segura semver enxuto', () => {
    assert.equal(cleanVersion('v0.2.0'), '0.2.0');
    assert.equal(cleanVersion('0.2.1-rc1'), null);
    assert.equal(cleanVersion(' v 0.3 '), null);
  });
});

// ── UpdateEngine com fakes ──────────────────────────────────────────────
const logger = new Logger({ level: 'error', file: null, console: false });

const defaultUpdates = {
  channel: 'stable' as const,
  autoCheck: true,
  intervalHours: 6,
  owner: 'lucasbr3',
  repo: 'geraldo',
};

interface Harness {
  engine: UpdateEngine;
  deps: UpdateEngineDeps;
  root: string;
  updatesDir: string;
  appDir: string;
}

function makeHarness(updatesOverride: Partial<typeof defaultUpdates> = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'geraldo-upd-'));
  const updatesDir = join(root, 'updates');
  mkdirSync(updatesDir, { recursive: true });
  const appDir = join(root, 'app');
  const deps: UpdateEngineDeps = {
    log: logger.withModule('updates'),
    getUpdates: () => ({ ...structuredClone(defaultUpdates), ...structuredClone({ ...updatesOverride }) }),
    currentVersion: () => '0.1.0',
    paths: { updatesDir, appDir },
    fetchJson: (_url, _headers) =>
      Promise.resolve({ ok: true, status: 200, json: [releaseRaw({}, [bundleAssetRaw])] }),
    fetchBytes: (_url, _maxBytes) =>
      Promise.resolve({ ok: true, status: 200, bytes: Buffer.from('CONTEÚDO DO PACOTE DE TESTE') }),
    extractZip: async (zipPath: string, destDir: string) => {
      void zipPath;
      mkdirSync(join(destDir, 'backend'), { recursive: true });
      mkdirSync(join(destDir, 'frontend'), { recursive: true });
      writeFileSync(join(destDir, 'version.txt'), '0.2.0\n');
      writeFileSync(join(destDir, 'backend', 'index.js'), 'console.log("novo");\n');
      writeFileSync(join(destDir, 'frontend', 'index.html'), '<html>novo</html>\n');
    },
  };
  const engine = new UpdateEngine(deps);
  return { engine, deps, root, updatesDir, appDir };
}

const checksumRaw = {
  ...bundleAssetRaw,
  name: 'geraldo-0.2.0.zip.sha256',
  size: 65,
  browser_download_url: 'https://github.com/lucasbr3/geraldo/releases/download/v0.2.0/geraldo-0.2.0.zip.sha256',
};

describe('ETAPA 9: UpdateEngine.check (rede falsificada)', () => {
  it('happy path: nova versão, asset e checksum vindos do mesmo release', async () => {
    const h = makeHarness();
    h.deps.fetchJson = (_url) =>
      Promise.resolve({ ok: true, status: 200, json: [releaseRaw({}, [bundleAssetRaw, checksumRaw])] });
    const result = await h.engine.check();
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.hasUpdate, true);
      assert.equal(result.latest, 'v0.2.0');
      assert.equal(result.current, '0.1.0');
      assert.equal(result.asset?.name, 'geraldo-0.2.0.zip');
      assert.equal(result.checksum?.name, 'geraldo-0.2.0.zip.sha256');
      assert.ok(result.notes !== null && result.notes.length > 0);
    }
    const standings = h.engine.status();
    assert.equal(standings.lastCheck?.hasUpdate, true);
    assert.equal(standings.pending, null);
    assert.match(standings.lastCheck?.at ?? '', /^\d{4}-/);
  });

  it('URL usada é a de releases públicos (sem token, per_page=20)', async () => {
    const h = makeHarness();
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    h.deps.fetchJson = (url, headers) => {
      seenUrl = url;
      seenHeaders = headers ?? {};
      return Promise.resolve({ ok: true, status: 200, json: [] });
    };
    await h.engine.check();
    assert.equal(seenUrl, 'https://api.github.com/repos/lucasbr3/geraldo/releases?per_page=20');
    assert.equal(seenHeaders['X-GitHub-Api-Version'], '2022-11-28');
  });

  it('404/403/contrário: erro legal com hint real', async () => {
    const h = makeHarness();
    h.deps.fetchJson = () => Promise.resolve({ ok: false, status: 404, json: null });
    const missing = await h.engine.check();
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.hint ?? 'vazio', /repositório lucasbr3\/geraldo não encontrado/);

    h.deps.fetchJson = () => Promise.resolve({ ok: false, status: 403, json: null });
    const limited = await h.engine.check();
    if (!limited.ok) assert.match(limited.hint ?? 'vazio', /limite/);

    h.deps.fetchJson = () => Promise.resolve({ ok: true, status: 200, json: [] });
    const empty = await h.engine.check();
    if (!empty.ok) assert.match(empty.hint ?? 'vazio', /não tem release publicada/);
  });

  it('sem owner/repo: recusa honesta antes de qualquer rede', async () => {
    const h = makeHarness({ owner: '', repo: '' });
    h.deps.fetchJson = () => {
      throw new Error('não deveria ter chamado a rede');
    };
    const result = await h.engine.check();
    assert.equal(result.ok, false);
    assert.match(result.error, /não configurado/);
    assert.equal(h.engine.status().configured, false);
    assert.match(h.engine.status().hint ?? '', /Configure o repositório/);
  });
});

describe('ETAPA 9: UpdateEngine.stage/prepare', () => {
  it('stage sem checksum no release: guarda zip + staged.json com verified null', async () => {
    const h = makeHarness();
    const staged = await h.engine.stage();
    assert.equal(staged.verified, null);
    assert.equal(staged.version, '0.2.0');
    const meta = JSON.parse(readFileSync(join(h.updatesDir, 'staged', 'staged.json'), 'utf8')) as { fileName: string };
    const zipDisk = readFileSync(join(h.updatesDir, 'staged', meta.fileName), 'utf8');
    assert.equal(zipDisk, 'CONTEÚDO DO PACOTE DE TESTE');
  });

  it('stage com checksum OK: verified true; checksum furado: recusa e não guarda nada', async () => {
    const { createHash } = await import('node:crypto');

    const okHarness = makeHarness();
    okHarness.deps.fetchJson = (_url) =>
      Promise.resolve({ ok: true, status: 200, json: [releaseRaw({}, [bundleAssetRaw, checksumRaw])] });
    const payload = Buffer.from('PACOTE VERIFICADO');
    const hash = createHash('sha256').update(payload).digest('hex');
    okHarness.deps.fetchBytes = (url) =>
      Promise.resolve(
        url.endsWith('.sha256')
          ? { ok: true, status: 200, bytes: Buffer.from(`${hash}  geraldo-0.2.0.zip\n`) }
          : { ok: true, status: 200, bytes: payload },
      );
    const staged = await okHarness.engine.stage();
    assert.equal(staged.verified, true);

    const bad = makeHarness();
    bad.deps.fetchJson = (_url) =>
      Promise.resolve({ ok: true, status: 200, json: [releaseRaw({}, [bundleAssetRaw, checksumRaw])] });
    bad.deps.fetchBytes = (url) =>
      Promise.resolve(
        url.endsWith('.sha256')
          ? { ok: true, status: 200, bytes: Buffer.from(`${'f'.repeat(64)}  geraldo-0.2.0.zip\n`) }
          : { ok: true, status: 200, bytes: Buffer.from('vira-lata') },
      );
    await assert.rejects(bad.engine.stage(), /SHA-256 .*(recusado)/);
    assert.equal(existsSync(join(bad.updatesDir, 'staged', 'staged.json')), false);
    assert.equal(existsSync(join(bad.updatesDir, 'staged', 'geraldo-0.2.0.zip')), false);
  });

  it('checksum indisponível na rede: continua com verified null (sem inventar)', async () => {
    const h = makeHarness();
    h.deps.fetchJson = (_url) =>
      Promise.resolve({ ok: true, status: 200, json: [releaseRaw({}, [bundleAssetRaw, checksumRaw])] });
    h.deps.fetchBytes = (url) =>
      Promise.resolve(
        url.endsWith('.sha256')
          ? { ok: false, status: null, bytes: null }
          : { ok: true, status: 200, bytes: Buffer.from('sem conferência') },
      );
    const staged = await h.engine.stage();
    assert.equal(staged.verified, null);
  });

  it('stage concorrente: o segundo recusa na hora', async () => {
    const h = makeHarness();
    // holder em objeto: o TS não acompanha atribuição em callback de
    // Promise (variável solta vira "null" pra ele), propriedade resolve.
    const gate: { release: (() => void) | null } = { release: null };
    const guard = new Promise<void>((resolvePromise) => {
      gate.release = resolvePromise;
    });
    h.deps.fetchBytes = () => guard.then(() => ({ ok: true, status: 200, bytes: Buffer.from('lento') }));
    const first = h.engine.stage().catch((error: unknown) => String(error));
    await new Promise((r) => setTimeout(r, 5));
    await h.engine
      .stage()
      .catch((error: unknown) => assert.match(String(error), /em andamento/));
    if (gate.release === null) throw new Error('gate deveria estar injetado');
    gate.release();
    await first;
  });

  it('stage quando não tem atualização: recusa; release sem zip também', async () => {
    const h = makeHarness();
    h.deps.fetchJson = (_url) =>
      Promise.resolve({ ok: true, status: 200, json: [releaseRaw({ tag_name: 'v0.1.0' }, [bundleAssetRaw])] });
    await assert.rejects(h.engine.stage(), /sem atualização pra baixar/);

    const noAsset = makeHarness();
    noAsset.deps.fetchJson = (_url) =>
      Promise.resolve({ ok: true, status: 200, json: [releaseRaw({}, [])] });
    await assert.rejects(noAsset.engine.stage(), /não tem pacote \.zip/);
  });

  it('prepare: valida version.txt + backend + frontend e escreve manifest', async () => {
    const h = makeHarness();
    await h.engine.stage();
    const made = await h.engine.prepare();
    assert.equal(made.version, '0.2.0');
    assert.equal(made.dirs, 2);
    const manifest = JSON.parse(readFileSync(join(h.updatesDir, 'pending', 'manifest.json'), 'utf8')) as { version: string };
    assert.equal(manifest.version, '0.2.0');
    assert.equal(h.engine.status().pending?.version, '0.2.0');
  });

  it('prepare recusa bundles podres (sem version.txt, sem backend, versão inválida, nada baixado)', async () => {
    const runCase = async (buildExtract: (destDir: string) => void): Promise<string> => {
      const h = makeHarness();
      h.deps.extractZip = async (_zipPath: string, destDir: string) => {
        buildExtract(destDir);
      };
      await h.engine.stage();
      try {
        await h.engine.prepare();
        return 'NÃO REJEITOU';
      } catch (error: unknown) {
        return String(error);
      }
    };

    const noVersion = await runCase((dest) => {
      mkdirSync(join(dest, 'backend'), { recursive: true });
      mkdirSync(join(dest, 'frontend'), { recursive: true });
    });
    assert.match(noVersion, /version\.txt/);

    const noBackend = await runCase((dest) => {
      mkdirSync(join(dest, 'frontend'), { recursive: true });
      writeFileSync(join(dest, 'version.txt'), '0.2.0\n');
    });
    assert.match(noBackend, /backend/);

    const versãoPodre = await runCase((dest) => {
      mkdirSync(join(dest, 'backend'), { recursive: true });
      mkdirSync(join(dest, 'frontend'), { recursive: true });
      writeFileSync(join(dest, 'version.txt'), 'banana\n');
    });
    assert.match(versãoPodre, /versão legível/);

    const h = makeHarness();
    await assert.rejects(h.engine.prepare(), /nada baixado/);
  });

  it('discardStaged limpa o staged; apply sem prepare recusa', async () => {
    const h = makeHarness();
    assert.throws(() => h.engine.apply(), /nada preparado/);
    await h.engine.stage();
    h.engine.discardStaged();
    assert.equal(existsSync(join(h.updatesDir, 'staged', 'staged.json')), false);
  });

  it('engine.apply escreve o script e o helper roda sem derrubar o processo do teste', async () => {
    const h = makeHarness();
    await h.engine.stage();
    await h.engine.prepare();
    const started = h.engine.apply();
    assert.equal(started.ok, true);
    assert.match(started.message, /START\.bat/);
    assert.equal(existsSync(join(h.updatesDir, 'apply-update.cmd')), true);
  });
});

// ── script de diferença: gera E RODA de verdade no sandbox ─────────────
describe('ETAPA 9: writeApplyScript (troca real executada)', () => {
  it('gera cmd com backup + /MIR + version.txt e aplica de verdade', async () => {
    const root = mkdtempSync(join(tmpdir(), 'geraldo-apply-'));
    const updatesDir = join(root, 'updates');
    const appDir = join(root, 'app');
    const pendingDir = join(root, 'pending');
    mkdirSync(join(appDir, 'backend', 'dist'), { recursive: true });
    mkdirSync(join(appDir, 'frontend', 'dist'), { recursive: true });
    mkdirSync(join(pendingDir, 'backend'), { recursive: true });
    mkdirSync(join(pendingDir, 'frontend'), { recursive: true });
    mkdirSync(updatesDir, { recursive: true });
    writeFileSync(join(appDir, 'backend', 'dist', 'index.js'), 'console.log("VELHO");\n');
    writeFileSync(join(appDir, 'frontend', 'dist', 'index.html'), '<html>VELHO</html>\n');
    writeFileSync(join(pendingDir, 'version.txt'), '0.2.0\n');
    writeFileSync(join(pendingDir, 'backend', 'index.js'), 'console.log("NOVO");\n');
    writeFileSync(join(pendingDir, 'frontend', 'index.html'), '<html>NOVO</html>\n');

    const scriptPath = writeApplyScript(updatesDir, {
      pendingDir,
      appDir,
      currentVersion: '0.1.0',
      newVersion: '0.2.0',
      waitSeconds: 1,
    });
    const script = readFileSync(scriptPath, 'utf8');
    assert.match(script, /\/MIR /);
    assert.match(script, /version\.txt/);
    assert.match(script, /GEQ 8/);
    assert.match(script, /%APPDATA%/);

    // executa o cmd DE VERDADE — esse teste que prova o swap + backup.
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn('cmd', ['/c', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const killer = setTimeout(() => rejectPromise(new Error('apply-update.cmd demorou demais')), 45_000);
      child.on('close', (code) => {
        clearTimeout(killer);
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`cmd saiu ${String(code)}`));
      });
      child.on('error', rejectPromise);
    });

    assert.equal(
      readFileSync(join(appDir, 'backend', 'dist', 'index.js'), 'utf8'),
      'console.log("NOVO");\n',
    );
    assert.equal(
      readFileSync(join(appDir, 'frontend', 'dist', 'index.html'), 'utf8'),
      '<html>NOVO</html>\n',
    );
    assert.equal(readFileSync(join(appDir, 'backend', 'version.txt'), 'utf8').trim(), '0.2.0');
    const backups = readdirSync(join(updatesDir, 'backups'));
    assert.equal(backups.length, 1);
    assert.match(backups[0] ?? '', /^0\.1\.0-antes-/);
    const backupRoot = join(updatesDir, 'backups', backups[0] ?? 'a');
    assert.equal(readFileSync(join(backupRoot, 'backend-dist', 'index.js'), 'utf8'), 'console.log("VELHO");\n');
    assert.equal(readFileSync(join(backupRoot, 'frontend-dist', 'index.html'), 'utf8'), '<html>VELHO</html>\n');
  });
});

// ── rede real local (tar.exe, sem internet) ────────────────────────────
describe('ETAPA 9: extractZipBundle (tar.exe de verdade)', () => {
  it('gera zip real com tar e extrai de volta', async () => {
    const root = mkdtempSync(join(tmpdir(), 'geraldo-tar-'));
    const srcDir = join(root, 'src');
    const destDir = join(root, 'dest');
    mkdirSync(join(srcDir, 'backend'), { recursive: true });
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(srcDir, 'version.txt'), '0.3.0\n');
    writeFileSync(join(srcDir, 'backend', 'index.js'), 'console.log("tar");\n');
    const zipPath = join(root, 'bundle.zip');
    await execAsync('tar', ['-a', '-cf', zipPath, '-C', srcDir, '.']);
    await extractZipBundle(zipPath, destDir);
    assert.equal(readFileSync(join(destDir, 'version.txt'), 'utf8').trim(), '0.3.0');
    assert.equal(readFileSync(join(destDir, 'backend', 'index.js'), 'utf8').trim(), 'console.log("tar");');
  });

  it('githubFetchJson contra endpoint morto: falha honesta (estrutura das respostas ok)', async () => {
    // Porta 9 (discard) — undici recusa sem conectar; o wrapper NÃO
    // engole o erro (o engine decide o que fazer com ele).
    await assert.rejects(githubFetchJson('http://127.0.0.1:9/imposs-word', {}, 300));
  });
});
