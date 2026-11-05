import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, mergeConfigPatch, applyAISettings } from '../config/types.ts';

function patchedConfigWith(patch: Record<string, unknown>) {
  const config = structuredClone(DEFAULT_CONFIG);
  mergeConfigPatch(config, patch);
  return config;
}

test('patch com valores corretos é aplicado', () => {
  const config = patchedConfigWith({
    server: { host: '0.0.0.0', port: 5555 },
    log: { level: 'debug' },
    whatsapp: { autoReconnect: false },
    updates: { channel: 'beta', intervalHours: 12, owner: 'lucasbr3', repo: 'geraldo' },
  });
  assert.equal(config.server.host, '0.0.0.0');
  assert.equal(config.server.port, 5555);
  assert.equal(config.log.level, 'debug');
  assert.equal(config.whatsapp.autoReconnect, false);
  assert.equal(config.updates.channel, 'beta');
  assert.equal(config.updates.intervalHours, 12);
  assert.equal(config.updates.owner, 'lucasbr3');
  assert.equal(config.updates.repo, 'geraldo');
});

test('patch inválido decai para os padrões', () => {
  const config = patchedConfigWith({
    server: { host: '', port: 99999 },
    log: { level: 'spam' },
    updates: { channel: 'hackado', intervalHours: -3 },
    secaoDeSabrina: { oh: true },
  });
  assert.equal(config.server.host, DEFAULT_CONFIG.server.host);
  assert.equal(config.server.port, DEFAULT_CONFIG.server.port);
  assert.equal(config.log.level, DEFAULT_CONFIG.log.level);
  assert.equal(config.updates.channel, 'stable');
  assert.equal(config.updates.intervalHours, DEFAULT_CONFIG.updates.intervalHours);
  assert.deepEqual(
    Object.keys(config).sort(),
    Object.keys(DEFAULT_CONFIG).sort(),
    'seções desconhecidas não devem entrar na config',
  );
});

test('secrets do arquivo são aceitos e preservados', () => {
  const strongSecret = 'a'.repeat(64);
  const config = patchedConfigWith({
    security: { tokenSecret: strongSecret, dashboardPasswordHash: 'scrypt$aa$bb' },
  });
  assert.equal(config.security.tokenSecret, strongSecret);
  assert.equal(config.security.dashboardPasswordHash, 'scrypt$aa$bb');
});

test('tokenSecret fraco é recusado', () => {
  const config = patchedConfigWith({ security: { tokenSecret: 'curto' } });
  assert.equal(config.security.tokenSecret, '');
});

test('applyAISettings valida faixas e ignora API key mascarada', () => {
  const ai = structuredClone(DEFAULT_CONFIG.ai);
  applyAISettings(ai, {
    provider: 'ollama',
    model: 'llama3:8b',
    temperature: 1.5,
    maxTokens: 2048,
    timeoutMs: 30000,
    apiKey: 'sk-teste-123',
  });
  assert.equal(ai.provider, 'ollama');
  assert.equal(ai.model, 'llama3:8b');
  assert.equal(ai.temperature, 1.5);
  assert.equal(ai.maxTokens, 2048);
  assert.equal(ai.timeoutMs, 30000);
  assert.equal(ai.apiKey, 'sk-teste-123');

  // Mask vindo da UI não triturar a senha.
  applyAISettings(ai, { apiKey: '********' });
  assert.equal(ai.apiKey, 'sk-teste-123');

  // clearApiKey limpa de verdade.
  applyAISettings(ai, { clearApiKey: true });
  assert.equal(ai.apiKey, '');

  // Valores fora de faixa são descartados (mantém último valor válido).
  const state = structuredClone(ai);
  applyAISettings(state, { temperature: 42, maxTokens: 99999, timeoutMs: 1, provider: 'cheat' });
  assert.equal(state.temperature, 1.5);
  assert.equal(state.maxTokens, 2048);
  assert.equal(state.timeoutMs, 30000);
  assert.equal(state.provider, 'ollama');
});
