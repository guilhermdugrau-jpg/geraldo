import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mimeForExtension, parseYtDlpLine } from '../media/progress.ts';

describe('parser de progresso do yt-dlp', () => {
  it('lê porcentagem de download normal', () => {
    const parsed = parseYtDlpLine('[download]   3.2% of   ~ 3.41MiB at  120.00KiB/s ETA 00:25');
    assert.equal(parsed.kind, 'download');
    assert.ok(Math.abs((parsed.progress ?? 0) - 0.032) < 0.001);
  });

  it('100% mapeia a progress 1', () => {
    const parsed = parseYtDlpLine('[download] 100% of 3.41MiB in 00:00:02');
    assert.equal(parsed.kind, 'download');
    assert.equal(parsed.progress, 1);
  });

  it('fases de conversão/merge viram "convert"', () => {
    assert.equal(parseYtDlpLine('[ExtractAudio] Destination: dl.mp3').kind, 'convert');
    assert.equal(parseYtDlpLine('[VideoRemuxer] Not remuxing media').kind, 'convert');
    assert.equal(parseYtDlpLine('[VideoConvertor] Refining...').kind, 'convert');
    assert.equal(parseYtDlpLine('[Merger] Merging formats into "dl.mp4"').kind, 'convert');
  });

  it('ERROR: vira erro com texto enxuto', () => {
    const parsed = parseYtDlpLine('ERROR: [youtube] video indisponível');
    assert.equal(parsed.kind, 'error');
    assert.ok(parsed.text.startsWith('ERROR:'));
  });

  it('linhas de info passam como info (o job segue vivo)', () => {
    assert.equal(parseYtDlpLine('[yt-dlp] version 2026.10.26').kind, 'info');
    assert.equal(parseYtDlpLine('linha qualquer sem colchete').kind, 'info');
  });

  it('linha vazia vira unknown sem estourar', () => {
    assert.equal(parseYtDlpLine('').kind, 'unknown');
    assert.equal(parseYtDlpLine('\r\r\n').kind, 'unknown');
  });
});

describe('mime por extensão', () => {
  it('audio e video comuns', () => {
    assert.equal(mimeForExtension('mp3'), 'audio/mpeg');
    assert.equal(mimeForExtension('m4a'), 'audio/mp4');
    assert.equal(mimeForExtension('mp4'), 'video/mp4');
    assert.equal(mimeForExtension('webm'), 'video/webm');
    assert.equal(mimeForExtension('opus'), 'audio/ogg');
  });

  it('extensão exótica fica octet-stream', () => {
    assert.equal(mimeForExtension('xyz'), 'application/octet-stream');
  });
});
