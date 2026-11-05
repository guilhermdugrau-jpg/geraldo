import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigStore } from '../config/store.ts';
import { resolvePaths } from '../config/paths.ts';
import { Logger } from '../logger/logger.ts';
import { Database } from '../database/database.ts';
import { runMigrations } from '../database/migrations.ts';
import { AuthService, hashPassword } from '../security/auth.ts';
import { generateTokenSecret } from '../security/auth.ts';
import { SettingsService } from '../services/settingsService.ts';
import { SystemStatusService } from '../services/systemStatus.ts';
import { StatsService } from '../services/statsService.ts';
import { TaskRunner } from '../media/runner.ts';
import { MediaEngine } from '../media/mediaEngine.ts';
import { MemeEngine } from '../media/memeEngine.ts';
import { PolitenessGate } from '../search/instants.ts';
import { VoiceEngine } from '../voice/voiceEngine.ts';
import { ImageEngine } from '../images/imageEngine.ts';
import { UpdateEngine } from '../updates/updateEngine.ts';
import { createApp } from '../httpApp.ts';
import type { AppContext } from '../types.ts';

const PASSWORD = 'cakung-teste-123';
const dataDir = mkdtempSync(join(tmpdir(), 'geraldosmoke-'));
const paths = resolvePaths(dataDir);
const config = new ConfigStore(paths);
config.get().log.level = 'error';
configDataDefaults();

function configDataDefaults() {
  const data = config.get();
  data.security.dashboardPasswordHash = hashPassword(PASSWORD);
  data.security.tokenSecret = generateTokenSecret();
}

const db = new Database(paths.dbPath);
runMigrations(db, { backupsDir: paths.backupsDir, dbPath: paths.dbPath });
const logger = new Logger({ level: 'error', file: null, console: false });
const authService = new AuthService({
  tokenSecret: config.get().security.tokenSecret,
  passwordHash: config.get().security.dashboardPasswordHash,
});

const apiConfigPatch = (): void => undefined;
const settings = new SettingsService(
  db,
  () => config.get(),
  apiConfigPatch,
  logger.withModule('settings'),
  () => undefined,
);

// ETAPA 4: fila real de mídia (sem yt-dlp/ffmpeg na máquina de teste →
// enfileirar um download legítimo tem de finalizar FAILED com erro honesto).
const taskRunner = new TaskRunner({ db, log: logger.withModule('tasks'), concurrency: 1 });
const mediaEngine = new MediaEngine({
  runner: taskRunner,
  log: logger.withModule('media'),
  db,
  paths: { mediaDir: paths.mediaDir },
});
mediaEngine.register();

// ETAPA 5: MemeEngine simulado — busca fake educada (gate real de 3 s p/
// testar o 429), import fake gravando linha no banco e envio honesto de erro.
const memeSearchFake = async (query: string) =>
  query === 'boom'
    ? [{ title: 'VINE BOOM', mp3Url: 'https://www.myinstants.com/media/sounds/vine-boom.mp3' }]
    : [];
const memeEngine = new MemeEngine({
  db,
  log: logger.withModule('memes'),
  paths: { mediaDir: paths.mediaDir },
  search: memeSearchFake,
  gate: new PolitenessGate(3000),
  sendAudio: async () => {
    throw new Error('WhatsApp não está conectado');
  },
  fetchBytes: async (url) => {
    if (url === 'https://www.myinstants.com/media/sounds/vine-boom.mp3') {
      return { ok: true, bytes: Buffer.from('FAKE MP3 VINE BOOM'), contentType: 'audio/mpeg' };
    }
    return { ok: false, error: 'fonte respondeu HTTP 404' };
  },
});

// ETAPA 6: voz simulada — sem piper na máquina de teste → status honesto e
// síntese falha "estalada"; flush p/ cache/spawn conferidos em voiceEngine.
const voiceEngine = new VoiceEngine({
  db,
  log: logger.withModule('voice'),
  paths: { piperDir: join(paths.dataDir, 'piper'), voicesDir: join(paths.dataDir, 'voices'), mediaDir: paths.mediaDir },
  resolveFfmpeg: async () => null,
  sendVoiceNote: async () => {
    throw new Error('WhatsApp não está conectado');
  },
  synthRun: async () => {
    throw new Error('piper não achado — instala pelo painel');
  },
});

// ETAPA 7: imagens com config real do smoke (provider default do config =
// 'disabled') → status honesto e geração recusada com instrução; os
// caminhos felizes de provedor ficam em imageEngine.test.ts com fakes.
const imageEngine = new ImageEngine({
  db,
  log: logger.withModule('images'),
  paths: { mediaDir: paths.mediaDir },
  getAI: () => config.get().ai,
  sendImage: async () => {
    throw new Error('WhatsApp não está conectado');
  },
  fetchHttp: async () => {
    throw new Error('provedor não deveria ser chamado com IA desabilitada');
  },
});

// ETAPA 9: atualizador com rede falsificada (nunca vai à internet nos
// testes) e fs de verdade na pasta temporária — o fluxo de rota e o
// overlay de settings são provados aqui; o motor completo tem suíte
// dedicada em updates.test.ts.
let applyHookCalls = 0;
const updatesEngine = new UpdateEngine({
  log: logger.withModule('updates'),
  getUpdates: () => settings.effectiveUpdates(),
  currentVersion: () => '0.1.0-test',
  paths: { updatesDir: join(paths.dataDir, 'updates'), appDir: join(dataDir, 'app-fantasma') },
  fetchJson: async () => ({ ok: false, status: 401, json: null }),
  fetchBytes: async () => ({ ok: false, status: null, bytes: null }),
  extractZip: async (zipPath: string) => {
    void zipPath;
    throw new Error('extração não deveria rodar no smoke');
  },
});

const ctx: AppContext = {
  logger,
  log: logger.withModule('api'),
  config,
  db,
  authService,
  settings,
  status: new SystemStatusService({
    version: () => '0.1.0-test',
    startedAt: () => new Date().toISOString(),
    paths: { dataDir },
    effectiveAI: () => settings.effectiveAI(),
    // ETAPA 8: painel não pode cravar estado do WhatsApp — injeta o do
    // serviço vivo (fake aqui no teste, sempre desconectado nessa cena).
    whatsappInfo: () => ({ state: 'disconnected' as const, note: 'desconectado' }),
  }),
  // ETAPA 8: contagens reais do banco do teste (vazio = zeros honestos).
  stats: new StatsService({
    db,
    effectiveAI: () => settings.effectiveAI(),
    whatsappInfo: () => ({ state: 'disconnected', note: 'desconectado' }),
    taskCounts: () => taskRunner.counts(),
  }),
  paths,
  // ETAPA 2: runtime WhatsApp simulado (as rotas não são alcançadas aqui).
  whatsapp: {
    service: {
      info: () => ({ state: 'disconnected', phone: null, note: 'desconectado', qr: null }),
      hasSession: () => false,
    },
    store: {
      listChats: () => [],
      listMessages: () => [],
    },
    bridge: { emit: () => undefined },
  } as unknown as AppContext['whatsapp'],
  ai: {
    testGenerate: async () => ({ ok: false, error: 'IA simulada no teste' }),
  } as unknown as AppContext['ai'],
  media: {
    runner: taskRunner,
    engine: mediaEngine,
    bridge: { emit: () => undefined },
  },
  memes: memeEngine,
  voice: voiceEngine,
  images: imageEngine,
  updates: updatesEngine,
  updatesOnApply: () => {
    applyHookCalls += 1;
  },
  broadcastSettings: () => undefined,
  securityHooks: {
    changePassword: (newPassword) => {
      // Espelha o hook de produção (ETAPA 8): o segredo do token roda
      // junto da senha — token velho morre na hora (testado embaixo).
      const tokenSecret = generateTokenSecret();
      const passwordHash = hashPassword(newPassword);
      config.get().security.dashboardPasswordHash = passwordHash;
      config.get().security.tokenSecret = tokenSecret;
      config.save();
      return { tokenSecret, passwordHash };
    },
    currentSecrets: () => ({
      tokenSecret: config.get().security.tokenSecret,
      passwordHash: config.get().security.dashboardPasswordHash,
    }),
  },
};

let server: Server;
let baseUrl: string;
let token = '';

async function jsonFetch(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.body !== undefined ? (init.method ?? 'POST') : (init.method ?? 'GET'),
    headers: {
      'content-type': 'application/json',
      ...(init.auth && token !== '' ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : (init.body ?? undefined),
  } as RequestInit);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

describe('smoke da API/REST', () => {
  before(async () => {
    const app = createApp(ctx);
    server = createServer(app);
    await new Promise<void>((resolvePromise) => {
      server.listen(0, '127.0.0.1', () => resolvePromise());
    });
    const info = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${info.port}`;
  });

  after(() => {
    server.close();
    db.close();
    logger.close();
  });

  it('health é público', async () => {
    const { status, body } = await jsonFetch('/api/health');
    assert.equal(status, 200);
    assert.equal(body['ok'], true);
    assert.equal(body['name'], 'Geraldo AI');
  });

  it('rota protegida sem token responde 401', async () => {
    const { status } = await jsonFetch('/api/settings');
    assert.equal(status, 401);
  });

  it('login errado dá 401; login certo dá token', async () => {
    const wrong = await jsonFetch('/api/auth/login', { body: { password: 'errado' } });
    assert.equal(wrong.status, 401);

    const right = await jsonFetch('/api/auth/login', { body: { password: PASSWORD } });
    assert.equal(right.status, 200);
    assert.equal(right.body['ok'], true);
    token = String(right.body['token'] ?? '');
    assert.ok(token.includes('.'));
  });

  it('/auth/me mostra expiração', async () => {
    const { body } = await jsonFetch('/api/auth/me', { auth: true });
    assert.equal(body['sub'], 'dashboard');
    assert.ok(typeof body['expiresAt'] === 'string');
  });

  it('GET/PUT settings com whitelist e máscara', async () => {
    const get = await jsonFetch('/api/settings', { auth: true });
    const ai = get.body['ai'] as Record<string, unknown>;
    assert.equal(ai['provider'], 'disabled');

    const put = await jsonFetch('/api/settings', {
      method: 'PUT',
      body: { ai: { provider: 'ollama', model: 'pequeno' } },
      auth: true,
    });
    assert.equal(put.status, 200);
    const nextAI = put.body['ai'] as Record<string, unknown>;
    assert.equal(nextAI['provider'], 'ollama');

    const bad = await jsonFetch('/api/settings', {
      method: 'PUT',
      body: { chaveMaluca: true },
      auth: true,
    });
    assert.equal(bad.status, 400);
  });

  it('troca de senha exige senha atual correta e mata o token velho (ETAPA 8)', async () => {
    const wrong = await jsonFetch('/api/security/password', {
      method: 'PUT',
      body: { currentPassword: 'qualquer-coisa', newPassword: 'outra-senha-8' },
      auth: true,
    });
    assert.equal(wrong.status, 401);

    const right = await jsonFetch('/api/security/password', {
      method: 'PUT',
      body: { currentPassword: PASSWORD, newPassword: 'nova-senha-12345' },
      auth: true,
    });
    assert.equal(right.status, 200);
    assert.equal(right.body['ok'], true);

    // Revogação: token emitido antes da troca não passa depois dela.
    const old = await jsonFetch('/api/auth/me', { auth: true });
    assert.equal(old.status, 401);

    // Re-login com a senha nova e o token novo entra em cena pro resto
    // da suíte (as proximas rotas exigem Bearer válido).
    const again = await jsonFetch('/api/auth/login', { body: { password: 'nova-senha-12345' } });
    assert.equal(again.status, 200);
    const nextToken = again.body['token'];
    assert.equal(typeof nextToken, 'string');
    token = String(nextToken);
    const me = await jsonFetch('/api/auth/me', { auth: true });
    assert.equal(me.status, 200);
  });

  it('/system/status traz snapshot honesto', async () => {
    const { body } = await jsonFetch('/api/system/status', { auth: true });
    assert.equal(body['name'], 'Geraldo AI');
    assert.equal((body['whatsapp'] as Record<string, unknown>)['state'], 'disconnected');
    assert.equal((body['ai'] as Record<string, unknown>)['provider'], 'ollama');
  });

  it('GET /stats traz contagens reais zeradas em banco limpo (ETAPA 8)', async () => {
    const { status, body } = await jsonFetch('/api/stats', { auth: true });
    assert.equal(status, 200);
    assert.equal(body['ok'], true);
    const conversations = body['conversations'] as Record<string, unknown>;
    assert.equal(conversations['total'], 0);
    assert.equal(conversations['last24h'], 0);
    const messages = body['messages'] as Record<string, unknown>;
    assert.equal(messages['total'], 0);
    const media = body['media'] as Record<string, unknown>;
    assert.equal(media['totalBytes'], 0);
    const tasks = body['tasks'] as Record<string, unknown>;
    assert.ok(tasks['done'] !== undefined && tasks['failed'] !== undefined);
    const whatsapp = body['whatsapp'] as Record<string, unknown>;
    assert.equal(whatsapp['state'], 'disconnected');
  });

  it('painel servido por HTML carrega CSP apertada (ETAPA 8)', async () => {
    const response = await fetch(`${baseUrl}/`);
    const contentType = String(response.headers.get('content-type') ?? '');
    const csp = response.headers.get('content-security-policy');
    if (contentType.includes('text/html')) {
      // Com build de frontend presente, helmet injeta a CSP do ETAPA 8.
      assert.ok(csp !== null, 'esperava CSP quando o HTML é servido');
      assert.ok(csp.includes("default-src 'self'"));
      assert.ok(csp.includes("frame-ancestors 'none'"));
    } else {
      // Sem dist do frontend no ambiente: nada de CSP forjada.
      assert.equal(csp, null);
    }
  });

  it('rota desconhecida no /api responde 404 JSON', async () => {
    const { status, body } = await jsonFetch('/api/inexistente', { auth: true });
    assert.equal(status, 404);
    assert.equal(body['ok'], false);
  });

  it('/media/tools admite honestamente que não há ferramentas', async () => {
    const { body } = await jsonFetch('/api/media/tools', { auth: true });
    assert.equal(body['ok'], true);
    assert.equal(body['ready'], false);
    assert.ok(typeof body['hint'] === 'string' && body['hint'].includes('winget'));
  });

  it('POST /media/download recusa URL sem http(s)', async () => {
    const bad = await jsonFetch('/api/media/download', {
      method: 'POST',
      body: { url: 'file:///C:/segredo.mp4', format: 'audio' },
      auth: true,
    });
    assert.equal(bad.status, 400);

    const noScheme = await jsonFetch('/api/media/download', {
      method: 'POST',
      body: { url: 'example.com/musica', format: 'audio' },
      auth: true,
    });
    assert.equal(noScheme.status, 400);
  });

  it('POST /media/download enfileira e a fila falha honesta sem yt-dlp', async () => {
    const post = await jsonFetch('/api/media/download', {
      method: 'POST',
      body: { url: 'https://example.com/musica.mp4', format: 'audio' },
      auth: true,
    });
    assert.equal(post.status, 202);
    const jobId = post.body['jobId'];
    assert.ok(typeof jobId === 'string');

    let finalState = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      const listing = await jsonFetch(`/api/media/jobs/${String(jobId)}`, { auth: true });
      const job = listing.body['job'] as Record<string, unknown>;
      finalState = String(job['state'] ?? '');
      if (finalState === 'failed' || finalState === 'done' || finalState === 'canceled') break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.equal(finalState, 'failed');

    const detail = await jsonFetch(`/api/media/jobs/${String(jobId)}`, { auth: true });
    const job = detail.body['job'] as Record<string, unknown>;
    const error = String(job['error'] ?? '');
    assert.ok(error.includes('ferramentas ausentes') || error.includes('não achados'));
  });

  it('/media/files vazio e /media/files/:id 404 honesto', async () => {
    const list = await jsonFetch('/api/media/files', { auth: true });
    assert.equal(Array.isArray(list.body['files']), true);
    assert.equal((list.body['files'] as unknown[]).length, 0);

    const missing = await jsonFetch('/api/media/files/nao-existe/file', { auth: true });
    assert.equal(missing.status, 404);
  });

  it('/memes/search retorna hits do fake, query vazia é 500 honesto', async () => {
    const query = await jsonFetch('/api/memes/search?q=boom', { auth: true });
    assert.equal(query.status, 200);
    assert.equal(Array.isArray(query.body['items']), true);
    assert.equal((query.body['items'] as unknown[]).length, 1);

    const empty = await jsonFetch('/api/memes/search?q=', { auth: true });
    assert.equal(empty.status, 500);
    assert.ok(String(empty.body['error']).includes('pesquisa vazia'));
  });

  it('gate de educação vira 429 quando o clipe aperta duas buscas', async () => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3100)); // limpa busca anterior
    const first = await jsonFetch('/api/memes/search?q=boom', { auth: true });
    assert.equal(first.status, 200);

    const second = await jsonFetch('/api/memes/search?q=boom', { auth: true });
    assert.equal(second.status, 429);
    assert.ok(typeof (second.body as Record<string, unknown>)['waitMs'] === 'number');
  });

  it('POST /memes/import grava o som no catálogo; URL estranha é rejeitada', async () => {
    const bad = await jsonFetch('/api/memes/import', {
      method: 'POST',
      body: { title: 'Tentativa', url: 'https://media-esteira.hue/infu.mp3' },
      auth: true,
    });
    assert.equal(bad.status, 500);
    assert.ok(String(bad.body['error']).includes('/media/sounds/'));

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3100)); // gate libera
    const good = await jsonFetch('/api/memes/import', {
      method: 'POST',
      body: {
        title: 'Vine Boom',
        url: 'https://www.myinstants.com/media/sounds/vine-boom.mp3',
      },
      auth: true,
    });
    assert.equal(good.status, 201);
    assert.ok(typeof good.body['id'] === 'string');

    const sounds = await jsonFetch('/api/memes/sounds', { auth: true });
    const arr = (sounds.body['sounds'] as Array<Record<string, unknown>>) ?? [];
    assert.equal(arr.length, 1);
    assert.ok(String(arr[0]?.['title']).includes('vine-boom'));
  });

  it('POST /memes/send sem WhatsApp conectado responde 409 honesto', async () => {
    const sounds = await jsonFetch('/api/memes/sounds', { auth: true });
    const arr = (sounds.body['sounds'] as Array<Record<string, unknown>>) ?? [];
    const id = arr[0]?.['id'];
    assert.ok(typeof id === 'string');

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 3100)); // gate libera
    const sent = await jsonFetch('/api/memes/send', {
      method: 'POST',
      body: { soundId: String(id), jid: '551199999@s.whatsapp.net' },
      auth: true,
    });
    assert.equal(sent.status, 409);
    assert.ok(String(sent.body['error']).includes('não está conectado'));
  });

  it('/voice/status sem piper/voz é honesto (ready false + hint)', async () => {
    const status = await jsonFetch('/api/voice/status', { auth: true });
    assert.equal(status.body['ok'], true);
    assert.equal(status.body['ready'], false);
    assert.ok(String(status.body['hint']).includes('Piper ausente'));
  });

  it('POST /voice/synthesize sem nada instalado é 400 com instrução real', async () => {
    const made = await jsonFetch('/api/voice/synthesize', {
      method: 'POST',
      body: { text: 'oi cabra' },
      auth: true,
    });
    assert.equal(made.status, 400);
    assert.ok(String(made.body['error']).includes('nenhuma voz instalada'));
  });

  it('/voice/clips vazio é honesto; POST /voice/send de clip fantasma é 404', async () => {
    const clips = await jsonFetch('/api/voice/clips', { auth: true });
    assert.equal(clips.body['ok'], true);
    assert.equal((clips.body['clips'] as unknown[]).length, 0);

    const sent = await jsonFetch('/api/voice/send', {
      method: 'POST',
      body: { clipId: 'nao-existe-clip', jid: '551199999@s.whatsapp.net' },
      auth: true,
    });
    assert.equal(sent.status, 404);
    assert.ok(String(sent.body['error']).includes('não encontrado'));
  });

  it('/images/status com IA desabilitada é honesto (ready false + instrução)', async () => {
    const status = await jsonFetch('/api/images/status', { auth: true });
    assert.equal(status.body['ok'], true);
    assert.equal(status.body['ready'], false);
    assert.ok(String(status.body['hint']).length > 8);
    assert.ok(String(status.body['hint']).includes('desabilitada') || String(status.body['hint']).includes('Configure'));
  });

  it('POST /images/generate sem provedor é 400 honesto; /images/list vazio', async () => {
    const made = await jsonFetch('/api/images/generate', {
      method: 'POST',
      body: { prompt: 'cabra da peste no sertão' },
      auth: true,
    });
    assert.equal(made.status, 400);
    assert.ok(String(made.body['error']).length > 8);

    const list = await jsonFetch('/api/images/list', { auth: true });
    assert.equal(list.body['ok'], true);
    assert.equal((list.body['images'] as unknown[]).length, 0);
  });

  it('POST /images/send e /media/send de id fantasma são 404 honestos', async () => {
    const sentImage = await jsonFetch('/api/images/send', {
      method: 'POST',
      body: { imageId: 'nao-existe-imagem', jid: '551199999@s.whatsapp.net' },
      auth: true,
    });
    assert.equal(sentImage.status, 404);
    assert.ok(String(sentImage.body['error']).includes('não encontrada'));

    const sentMedia = await jsonFetch('/api/media/send', {
      method: 'POST',
      body: { fileId: 'nao-existe-arquivo', jid: '551199999@s.whatsapp.net' },
      auth: true,
    });
    assert.equal(sentMedia.status, 404);
    assert.ok(String(sentMedia.body['error']).includes('não encontrado no catálogo'));
  });

  it('/updates/status sem configurar é honesto (ETAPA 9)', async () => {
    const status = await jsonFetch('/api/updates/status', { auth: true });
    assert.equal(status.body['ok'], true);
    assert.equal(status.body['configured'], false);
    assert.match(String(status.body['hint']), /Configure o repositório/);
    assert.equal(status.body['currentVersion'], '0.1.0-test');
  });

  it('PUT /settings persiste updates (owner/repo/canal) e o motor vê na hora', async () => {
    const put = await jsonFetch('/api/settings', {
      method: 'PUT',
      body: { updates: { owner: 'lucasbr3', repo: 'geraldo', channel: 'beta', intervalHours: 3 } },
      auth: true,
    });
    assert.equal(put.status, 200);
    const updates = put.body['updates'] as Record<string, unknown>;
    assert.equal(updates['owner'], 'lucasbr3');
    assert.equal(updates['channel'], 'beta');
    assert.equal(updates['intervalHours'], 3);

    const ownerBad = await jsonFetch('/api/settings', {
      method: 'PUT',
      body: { updates: { owner: 'metade/metade' } },
      auth: true,
    });
    assert.equal(ownerBad.status, 400); // regex trava a barra

    const status = await jsonFetch('/api/updates/status', { auth: true });
    assert.equal((status.body as Record<string, unknown>)['configured'], true);
  });

  it('POST /updates/check devolve ok:false com HTTP 401 legível (rede falsa)', async () => {
    const check = await jsonFetch('/api/updates/check', { method: 'POST', auth: true });
    assert.equal(check.status, 200);
    assert.equal(check.body['ok'], false);
    assert.ok(String(check.body['error']).includes('401'));
    const status = await jsonFetch('/api/updates/status', { auth: true });
    assert.equal((status.body as Record<string, unknown>)['lastCheck'] !== null, true);
  });

  it('POST /updates/discard ok; /updates/apply sem prepare é 400 e não mata servidor', async () => {
    const discard = await jsonFetch('/api/updates/discard', { method: 'POST', auth: true });
    assert.equal(discard.status, 200);
    assert.equal(discard.body['ok'], true);

    const apply = await jsonFetch('/api/updates/apply', { method: 'POST', auth: true });
    assert.equal(apply.status, 400);
    assert.match(String(apply.body['error']), /nada preparado/);

    const alive = await jsonFetch('/api/health');
    assert.equal(alive.status, 200);
  });
});
