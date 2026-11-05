/**
 * ETAPA 8: testes da rotação de logs — só arquivos `app-AAAA-MM-DD.log`
 * antes da janela de 7 dias são apagados; outro arquivo no diretório
 * fica intocado (backup do usuário não é lixo).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOldLogFiles, isKeepFile } from '../logger/retention.ts';

function makeLogDir(files: Array<{ name: string; ageDays: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'geraldologs-'));
  const now = new Date();
  for (const entry of files) {
    // A rotação decide pela DATA no nome (padrão do Logger), não por mtime.
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - entry.ageDays);
    const d = String(date.getDate()).padStart(2, '0');
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const y = String(date.getFullYear());
    const fileName = entry.name.replace('$DATE$', `${y}-${m}-${d}`);
    writeFileSync(join(dir, fileName), '{"x":1}\n');
  }
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('prune apaga só os passados da janela e ignora arquivos de outro padrão', () => {
  const dir = makeLogDir([
    { name: 'app-$DATE$.log', ageDays: 0 }, // hoje
    { name: 'app-$DATE$.log', ageDays: 3 },
    { name: 'app-$DATE$.log', ageDays: 7 }, // borda da janela (corte é início do dia 7) → fica
    { name: 'app-$DATE$.log', ageDays: 8 }, // fora → apaga
    { name: 'app-$DATE$.log', ageDays: 30 }, // fora → apaga
    { name: 'outro.backup.sqlite', ageDays: 400 }, // fora do padrão → intocado
    { name: 'app-pode-podre.log', ageDays: 999 }, // não casa o regex de data → intocado
  ]);

  const result = pruneOldLogFiles(dir, 7);
  assert.equal(result.removed.length, 2);
  assert.equal(result.kept, 3);
  assert.equal(result.errored.length, 0);

  const remaining = readdirSync(dir);
  assert.ok(remaining.includes('outro.backup.sqlite'), 'backup manual intocado');
  assert.ok(remaining.includes('app-pode-podre.log'), 'nome sem data válida fica');
  assert.equal(remaining.filter((candidate) => candidate.startsWith('app-2')).length, 3);

  cleanup(dir);
});

test('keepDays=0: ontem sai, hoje fica (corte é meia-noite de hoje)', () => {
  const dir = makeLogDir([
    { name: 'app-$DATE$.log', ageDays: 0 },
    { name: 'app-$DATE$.log', ageDays: 1 },
  ]);
  const result = pruneOldLogFiles(dir, 0);
  assert.equal(result.removed.length, 1);
  assert.equal(result.kept, 1);
  cleanup(dir);
});

test('isKeepFile: fora do padrão de data nunca é alvo (sem parse = não mexo)', () => {
  const now = new Date();
  assert.equal(isKeepFile('app-fulano.log', 7, now), true);
  assert.equal(isKeepFile('app-1999-01-01.log', 7, now), false);
  assert.equal(isKeepFile('backup-1999-01-01.sqlite', 7, now), true);
  // Data absurda no padrão — JS rola o valor (Year 1913) e ela cai fora
  // da janela de qualquer forma, então apagar é o comportamento real.
  assert.equal(isKeepFile('app-1912-13-99.log', 7, now), false);
});
