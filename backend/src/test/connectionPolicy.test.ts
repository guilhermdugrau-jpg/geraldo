import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  backoffDelayMs,
  classifyDisconnect,
} from '../whatsapp/connectionPolicy.ts';

describe('connectionPolicy — classificação de desconexão', () => {
  it('401 é logout (não reconecta)', () => {
    assert.equal(classifyDisconnect(401), 'logout');
  });

  it('440 é sessão substituída (não reconecta)', () => {
    assert.equal(classifyDisconnect(440), 'replaced');
  });

  it('demais códigos voltam a reconectar', () => {
    assert.equal(classifyDisconnect(515), 'reconnect');
    assert.equal(classifyDisconnect(428), 'reconnect');
    assert.equal(classifyDisconnect(undefined), 'reconnect');
  });
});

describe('connectionPolicy — backoff crescente e limitado', () => {
  it('começa em 2s e dobra', () => {
    assert.equal(backoffDelayMs(0), 2000);
    assert.equal(backoffDelayMs(1), 4000);
    assert.equal(backoffDelayMs(2), 8000);
  });

  it('tem teto de 60s mesmo com muitas tentativas', () => {
    assert.equal(backoffDelayMs(6), 60000);
    assert.equal(backoffDelayMs(99), 60000);
  });

  it('não aceita tentativa negativa', () => {
    assert.equal(backoffDelayMs(-5), 2000);
  });
});
