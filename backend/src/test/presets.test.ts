import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AI_PRESETS } from '../ai/presets.ts';
import { AI_PROVIDERS } from '../config/types.ts';

describe('presets de provedor', () => {
  it('não contém segredos — apenas URLs/IDs documentação', () => {
    for (const preset of AI_PRESETS) {
      const json = JSON.stringify(preset);
      assert.ok(!json.includes('sk-'), 'nenhuma key sk-');
      assert.ok(!json.includes('gsk_'), 'nenhuma key Groq');
      assert.ok(!json.includes('Bearer '), 'nada de header em segredo');
      assert.ok(preset.apiKeyHint === '' ? !preset.needsApiKey : true);
    }
  });

  it('ids existem na whitelist de providers', () => {
    for (const preset of AI_PRESETS) {
      assert.ok(AI_PROVIDERS.includes(preset.id), `id ${preset.id} fora da lista`);
    }
    assert.equal(AI_PRESETS.length, AI_PROVIDERS.length);
  });

  it('Groq: gpt-oss-120b no endpoint OpenAI-compat com fallback 27B', () => {
    const groq = AI_PRESETS.find((p) => p.id === 'groq');
    assert.ok(groq !== undefined);
    assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
    assert.equal(groq.model, 'openai/gpt-oss-120b');
    assert.equal(groq.fallbackModel, 'qwen/qwen3.8-27b');
    assert.equal(groq.needsApiKey, true);
  });

  it('Gemini usa o endpoint OpenAI-compat oficial', () => {
    const gemini = AI_PRESETS.find((p) => p.id === 'gemini');
    assert.equal(gemini?.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.ok(gemini?.model.startsWith('gemini-3.8-flash'));
  });

  it('Z.ai linha Flash preset; OpenRouter preserva o GLM', () => {
    const zai = AI_PRESETS.find((p) => p.id === 'zai');
    assert.equal(zai?.baseUrl, 'https://api.z.ai/api/paas/v4');
    assert.ok(zai?.model.startsWith('glm-4.7-flash'));

    const router = AI_PRESETS.find((p) => p.id === 'openrouter');
    assert.equal(router?.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(router?.model, 'z-ai/glm-5.3-flash-free');
  });

  it('Ollama é o único sem key e com host local', () => {
    const ollama = AI_PRESETS.find((p) => p.id === 'ollama');
    assert.equal(ollama?.needsApiKey, false);
    assert.ok(ollama?.baseUrl.startsWith('http://localhost'));
  });

  it('download: presets não têm campos vazios de label', () => {
    for (const preset of AI_PRESETS) {
      assert.ok(preset.label.trim().length > 0);
      assert.ok(preset.notes.trim().length > 0);
    }
  });
});
