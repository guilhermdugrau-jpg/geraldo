import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PolitenessGate,
  myinstantsFetchPage,
  parseInstantsHtml,
  searchInstants,
} from '../search/instants.ts';

const FIXTURE = `
<html><body>
<div class="instant">
  <a class="instant-link" href="/en/instant/vine-boom/" title="VINE BOOM SOUND">VINE BOOM SOUND</a>
  <span class="uploader">by foo</span>
  <div class="small-button-wrapper">
    <button class="small-button" onclick="play('https://www.myinstants.com/media/sounds/vine-boom.mp3','id1')">▶</button>
  </div>
</div>
<div class="instant">
  <a class="instant-link" href="/en/instant/juslu/" title="&quot;Juslu&quot; &#39;cheiro&#39;">"Juslu" 'cheiro'</a>
  <button class="small-button" onmousedown="play('/media/sounds/juslu.mp3','id2')">▶</button>
</div>
<div class="instant">
  <a class="instant-link" href="/en/instant/repe/" title="REPETIDO">REPETIDO</a>
  <button class="small-button" onmousedown="play('/media/sounds/juslu.mp3','id2')">▶</button>
</div>
<div class="instant">
  <a class="instant-link" href="/en/instant/no-play/">SEM PLAY</a>
  <button class="small-button">▶</button>
</div>
</body></html>
`;

describe('SearchEngine — parser MyInstants (ETAPA 5)', () => {
  it('extrai título + mp3, resolve URL relativa e descarta repetidos', () => {
    const hits = parseInstantsHtml(FIXTURE);
    assert.equal(hits.length, 2);

    const first = hits[0];
    if (first === undefined) return assert.fail('primeiro hit sumiu');
    assert.equal(first.title, 'VINE BOOM SOUND');
    assert.equal(first.mp3Url, 'https://www.myinstants.com/media/sounds/vine-boom.mp3');

    const second = hits[1];
    if (second === undefined) return assert.fail('segundo hit sumiu');
    assert.equal(second.title, '"Juslu" \'cheiro\'');
    assert.equal(second.mp3Url, 'https://www.myinstants.com/media/sounds/juslu.mp3');
  });

  it('html sem resultados → lista vazia honesta', () => {
    assert.deepEqual(parseInstantsHtml('<html><body>Nada aqui</body></html>'), []);
  });

  it('título sem atributo title cai no texto interno', () => {
    const html = `<div class="instant">
      <a class="instant-link" href="/en/instant/x/">Bruh Moment</a>
      <button class="small-button" onmousedown="play('/media/sounds/bruh.mp3','d')">▶</button>
    </div>`;
    const hits = parseInstantsHtml(html);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.title, 'Bruh Moment');
  });

  it('gate de educação recusa segunda chamada antes do intervalo', () => {
    const gate = new PolitenessGate(1000);
    assert.ok(gate.tryPass(0).ok);
    const denied = gate.tryPass(200);
    assert.equal(denied.ok, false);
    assert.equal(denied.waitMs, 800);
    assert.ok(gate.tryPass(1200).ok);
  });

  it('searchInstants com fake fetcher: 403 → erro honesto; 200 → hits', async () => {
    await assert.rejects(
      () => searchInstants('boom', async () => ({ status: 403, body: 'fora' })),
      /HTTP 403/,
    );

    let requested = '';
    const hits = await searchInstants('vine boom', async (url) => {
      requested = url;
      return { status: 200, body: FIXTURE };
    });
    assert.ok(requested.startsWith('https://www.myinstants.com/en/search/?name=vine+boom'));
    assert.equal(hits.length, 2);
  });

  it('query maior que 80 chars é cortada no adaptador', async () => {
    let requested = '';
    const hits = await searchInstants('x'.repeat(200), async (url) => {
      requested = url;
      return { status: 200, body: FIXTURE };
    });
    const name = new URL(requested).searchParams.get('name') ?? '';
    assert.equal(name.length, 80);
    assert.ok(hits.length >= 0);
  });
});
