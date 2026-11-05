/**
 * ETAPA 6: testes do VoiceEngine (Piper TTS local) com peças injetadas —
 * nada de rede, piper ou ffmpeg real aqui; o que se testa é a lógica do
 * engine (cache, lock honesto, catálogo media_files, erros com instrução).
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../database/database.ts';
import { runMigrations } from '../database/migrations.ts';
import { Logger } from '../logger/logger.ts';
import { resolvePaths } from '../config/paths.ts';
import { VoiceEngine, type SynthesisRunArgs, type VoiceEngineDeps } from '../voice/voiceEngine.ts';
import { listVoiceFiles, resolveVoiceTools } from '../voice/tools.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'geraldovoz-'));
const paths = resolvePaths(dataDir);
mkdirSync(paths.voicesDir, { recursive: true });
const db = new Database(paths.dbPath);
runMigrations(db, { backupsDir: paths.backupsDir, dbPath: paths.dbPath });
const logger = new Logger({ level: 'error', file: null, console: false });

after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* tmp do usuário — se travou por ponteiro aberto, fica no tmp mesmo */
  }
});

interface EngineHarness {
  engine: VoiceEngine;
  calls: { synth: number; convert: number; send: number };
  deps: VoiceEngineDeps & { sendVoiceNote: (jid: string, file: string, label: string | null) => Promise<string> };
}

/** Voz .onnx falsa + .json do lado (o engine valida presença do par). */
function installFakeVoice(id: string): void {
  writeFileSync(join(paths.voicesDir, `${id}.onnx`), Buffer.from('FAKE ONNX VOICE'));
  writeFileSync(join(paths.voicesDir, `${id}.onnx.json`), Buffer.from('{"fake":true}'));
}

function makeEngine(overrides: Partial<VoiceEngineDeps> = {}): EngineHarness {
  const calls = { synth: 0, convert: 0, send: 0 };
  const deps: VoiceEngineDeps = {
    db,
    log: logger.withModule('voz-teste'),
    paths: { piperDir: paths.piperDir, voicesDir: paths.voicesDir, mediaDir: paths.mediaDir },
    env: {}, // hermético: sem GERALDO_PIPER herdado da máquina
    resolveFfmpeg: async () => 'C:\\fake\\ffmpeg.exe',
    sendVoiceNote: async (chatJid, filePath, label) => {
      calls.send++;
      assert.ok(chatJid.includes('@'), 'jid tem de parecer jid');
      assert.ok(existsSync(filePath), 'arquivo tem de existir no envio');
      void label;
      return `fake-wamid-${String(calls.send)}`;
    },
    synthRun: async (args: SynthesisRunArgs) => {
      calls.synth++;
      assert.ok(args.modelPath.endsWith('.onnx'));
      assert.ok(args.text.length >= 1);
      writeFileSync(args.wavPath, Buffer.from('FAKE WAV PCM'));
    },
    convertAudio: async (wavPath, oggPath) => {
      calls.convert++;
      assert.ok(existsSync(wavPath), 'wav precisa existir antes do conversor');
      writeFileSync(oggPath, Buffer.from('FAKE OGG OPUS'));
    },
    resolvePiperPath: async () => 'C:\\fake\\piper.exe',
    ...overrides,
  };
  return { engine: new VoiceEngine(deps), calls, deps };
}

describe('VoiceEngine (ETAPA 6) — piper TTS local', () => {
  it('status honesto quando não há piper nem voz (ready false + instrução real)', async () => {
    const { engine } = makeEngine();
    const s = await engine.status();
    assert.equal(s.ready, false);
    assert.equal(s.piper.piperPath, null);
    assert.ok(s.hint !== null && s.hint.includes('Piper ausente'));
    assert.ok(s.hint.includes('nenhuma voz'));
  });

  it('status com voz instalada mas piper ausente: ready segue false e hint aponta o que falta', async () => {
    installFakeVoice('pt_BR-faker-medium');
    const { engine } = makeEngine();
    const s = await engine.status();
    assert.equal(s.ready, false);
    assert.equal(s.voices.length, 1);
    assert.equal(s.voices[0]?.id, 'pt_BR-faker-medium');
    assert.ok(s.hint !== null && s.hint.includes('Piper ausente'));
    assert.ok(!s.hint.includes('nenhuma voz'));
  });

  it('síntese feliz: run + conversão + catálogo media_files com tmp eliminado', async () => {
    const { engine, calls } = makeEngine();
    const made = await engine.synthesize('Axente Geraldo, tudo certo, cabra?', 'pt_BR-faker-medium');
    assert.equal(made.cached, false);
    assert.equal(made.voice, 'pt_BR-faker-medium');
    assert.equal(calls.synth, 1);
    assert.equal(calls.convert, 1);

    const dirEntries = readdirSync(paths.mediaDir);
    assert.ok(dirEntries.some((n) => n.endsWith('.ogg')), 'ogg no catálogo de mídia');
    assert.ok(!dirEntries.some((n) => n.startsWith('voice-')), 'tmp voice-* destruído após sucesso');

    const clips = engine.listClips();
    assert.equal(clips.length, 1);
    assert.equal(clips[0]?.id, made.id);
    assert.equal(clips[0]?.title, clips[0]?.title.replace(/^voz-/, '')); // título derivado honesto
    const clip = engine.getClip(made.id);
    assert.notEqual(clip, null);
    assert.ok(clip !== null && clip.filePath.endsWith('.ogg'));

    const row = db.prepare('SELECT category, mime FROM media_files WHERE id = ?').get(made.id) as
      | { category: string; mime: string }
      | undefined;
    assert.ok(row !== undefined);
    assert.equal(row.category, 'voice');
    assert.equal(row.mime, 'audio/ogg');
  });

  it('cache: mesmo texto+voz re-responde o id com cached true (sem re-run do piper)', async () => {
    const { engine, calls } = makeEngine();
    const first = await engine.synthesize('bom dia pra quem acordou cedo', 'pt_BR-faker-medium');
    assert.equal(first.cached, false);
    const second = await engine.synthesize('bom dia pra quem acordou cedo', 'pt_BR-faker-medium');
    assert.equal(second.cached, true);
    assert.equal(second.id, first.id);
    assert.equal(calls.synth, 1, 'piper NÃO roda de novo no cache hit');

    const third = await engine.synthesize('outro texto', 'pt_BR-faker-medium');
    assert.equal(third.cached, false);
    assert.notEqual(third.id, first.id);
    assert.equal(calls.synth, 2);
  });

  it('lock de síntese: segunda chamada enquanto roda recebe erro honesto de fila', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    let entered = false;
    const { engine } = makeEngine({
      synthRun: async (args) => {
        entered = true;
        await gate;
        writeFileSync(args.wavPath, Buffer.from('FAKE WAV LENT'));
      },
    });
    const first = engine.synthesize('fala longa que demora', 'pt_BR-faker-medium');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
    assert.equal(entered, true, 'síntese entrou de fato');
    await assert.rejects(
      () => engine.synthesize('fala em paralelo', 'pt_BR-faker-medium'),
      /já sintetizando/,
    );
    release();
    const made = await first;
    assert.equal(made.cached, false);
  });

  it('erros de entrada são instrutivos: texto vazio, longo demais e voz fantasma', async () => {
    const { engine } = makeEngine();
    await assert.rejects(() => engine.synthesize('   '), /texto vazio/);
    await assert.rejects(() => engine.synthesize('a'.repeat(401)), /texto passa de 400 caracteres/);
    await assert.rejects(
      () => engine.synthesize('oi', 'pt_BR-naoexiste-medium'),
      /não instalada — opções:/,
    );
  });

  it('piper ausente na síntese: erro honesto apontando instalação', async () => {
    const { engine } = makeEngine({ resolvePiperPath: async () => null });
    await assert.rejects(() => engine.synthesize('oi', 'pt_BR-faker-medium'), /piper não achado/);
  });

  it('ffmpeg ausente: erro honesto depois do piper rodar (sem conversor injetado)', async () => {
    const { engine, calls } = makeEngine({ convertAudio: undefined, resolveFfmpeg: async () => null });
    await assert.rejects(() => engine.synthesize('oi', 'pt_BR-faker-medium'), /ffmpeg ausente/);
    assert.equal(calls.synth, 1, 'piper rodou antes de errar no conversor');
  });

  it('envio: clip fantasma 404-like, jid inválido e arquivo sumido são honestos', async () => {
    const { engine } = makeEngine();
    await assert.rejects(() => engine.send('clip-fantasma-01', '551199999@s.whatsapp.net'), /não encontrado/);

    const made = await engine.synthesize('me manda essa', 'pt_BR-faker-medium');
    await assert.rejects(() => engine.send(made.id, 'uzumakinji'), /jid.*inválido/);

    const clip = engine.getClip(made.id);
    assert.ok(clip !== null);
    rmSync(clip.filePath, { force: true });
    await assert.rejects(() => engine.send(made.id, '551199999@s.whatsapp.net'), /sumiu do disco/);
  });

  it('envio feliz chama sendVoiceNote com jid e devolve wamid', async () => {
    const { engine, calls } = makeEngine();
    const made = await engine.synthesize('essa vai pro zap', 'pt_BR-faker-medium');
    const sent = await engine.send(made.id, '551199999@s.whatsapp.net');
    assert.equal(sent.ok, true);
    assert.equal(sent.wamid, 'fake-wamid-1');
    assert.equal(calls.send, 1);
  });
});

describe('voice/tools — resolver honesto', () => {
  it('listVoiceFiles ignora .onnx sem .onnx.json do lado', () => {
    writeFileSync(join(paths.voicesDir, 'pt_BR-orfao-medium.onnx'), Buffer.from('ORFAO'));
    const voices = listVoiceFiles(paths.voicesDir);
    assert.ok(!voices.some((v) => v.id === 'pt_BR-orfao-medium'));
    assert.ok(voices.some((v) => v.id === 'pt_BR-faker-medium'));
  });

  it('resolveVoiceTools com GERALDO_PIPER inválido cai no hint de piper ausente', async () => {
    const bogus = join(dataDir, 'nao-e-um-exe.txt');
    writeFileSync(bogus, 'texto');
    const tools = await resolveVoiceTools({
      env: { GERALDO_PIPER: bogus },
      piperDir: join(dataDir, 'piper-nao-existe'),
      voicesDir: paths.voicesDir,
    });
    assert.equal(tools.piper.piperPath, null);
    assert.equal(tools.piper.version, null);
    assert.ok(tools.hint !== null && tools.hint.includes('Piper ausente'));
    assert.ok(tools.voices.some((v) => v.id === 'pt_BR-faker-medium'));
  });
});
