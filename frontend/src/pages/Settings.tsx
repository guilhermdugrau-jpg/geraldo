import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../services/api.ts';
import { Card, Field, Notice, Badge } from '../components/ui.tsx';
import type {
  PublicSettings,
  PublicAISettings,
  LogLevel,
  AiProviderPreset,
  AIProviderName,
} from '../types.ts';

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const PROVIDERS: Array<{ id: AIProviderName; label: string }> = [
  { id: 'disabled', label: 'Desativado' },
  { id: 'groq', label: 'Groq (grátis)' },
  { id: 'gemini', label: 'Google AI Studio (Gemini)' },
  { id: 'zai', label: 'Z.ai (GLM Flash)' },
  { id: 'openrouter', label: 'OpenRouter (GLM/free)' },
  { id: 'ollama', label: 'Ollama local' },
  { id: 'openai', label: 'API compatível OpenAI' },
];

export function Settings() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Form state (IA)
  const [aiForm, setAiForm] = useState<PublicAISettings | null>(null);
  const [presets, setPresets] = useState<AiProviderPreset[]>([]);
  const apiKeyDirty = useState(false)[0];

  // Form security
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');

  useEffect(() => {
    api<PublicSettings>('/settings').then((data) => {
      setSettings(data);
      setAiForm(data.ai);
    }).catch(() => undefined);
    api<{ presets: AiProviderPreset[] }>('/settings/ai-presets')
      .then((data) => setPresets(data.presets))
      .catch(() => undefined);
  }, []);

  if (settings === null || aiForm === null) {
    return (
      <Card title="Configurações">
        <p className="dim">Carregando configurações...</p>
      </Card>
    );
  }

  const saveAI = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = {
        provider: aiForm.provider,
        model: aiForm.model,
        fallbackModel: aiForm.fallbackModel,
        baseUrl: aiForm.baseUrl,
        temperature: aiForm.temperature,
        maxTokens: aiForm.maxTokens,
        timeoutMs: aiForm.timeoutMs,
      };
      if (!apiKeyDirty) payload['apiKey'] = '********'; // não mexe na chave guardada
      const result = await api<PublicSettings>('/settings', { method: 'PUT', body: { ai: payload } });
      setSettings(result);
      setAiForm(result.ai);
      setNotice({ tone: 'ok', text: 'Configurações de IA salvas, meu patrão!' });
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Falha ao salvar' });
    } finally {
      setBusy(false);
    }
  };

  const applyPreset = (preset: AiProviderPreset): void => {
    setAiForm((current) =>
      current === null
        ? current
        : {
            ...current,
            provider: preset.id,
            baseUrl: preset.baseUrl,
            model: preset.model,
            fallbackModel: preset.fallbackModel,
          },
    );
    setNotice({
      tone: preset.needsApiKey ? 'warn' : 'ok',
      text: preset.needsApiKey
        ? `Preset aplicado: ${preset.label}. Coloque a API key (${preset.apiKeyHint}) e clique em Salvar IA.`
        : `Preset aplicado: ${preset.label}. Clique em Salvar IA.`,
    });
  };

  const testAI = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<{ ok: boolean; reply?: string; error?: string }>('/ai/test', {
        method: 'POST',
        body: {},
      });
      if (result.ok && result.reply !== undefined && result.reply !== '') {
        setNotice({ tone: 'ok', text: `IA respondereu: "${result.reply}"` });
      } else {
        setNotice({ tone: 'err', text: result.error ?? 'IA sem resposta' });
      }
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Falha no teste de IA' });
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      if (newPassword !== newPassword2) {
        setNotice({ tone: 'err', text: 'A confirmação de senha não confere' });
        setBusy(false);
        return;
      }
      await api('/security/password', {
        method: 'PUT',
        body: { currentPassword, newPassword },
      });
      setCurrentPassword('');
      setNewPassword('');
      setNewPassword2('');
      setNotice({ tone: 'ok', text: 'Senha alterada! A nova vale no próximo login (sessões ativas continuam válidas).' });
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Falha ao trocar senha' });
    } finally {
      setBusy(false);
    }
  };

  const changeLogLevel = async (level: LogLevel): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<PublicSettings>('/settings', {
        method: 'PUT',
        body: { log: { level } },
      });
      setSettings(result);
      setNotice({ tone: 'ok', text: `Nível de log: ${level}` });
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Falha ao salvar' });
    } finally {
      setBusy(false);
    }
  };

  const toggleReconnect = async (value: boolean): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<PublicSettings>('/settings', {
        method: 'PUT',
        body: { whatsapp: { autoReconnect: value } },
      });
      setSettings(result);
      setNotice({ tone: 'ok', text: `Reconexão do WhatsApp: ${value ? 'ligada' : 'desligada'}` });
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Falha ao salvar' });
    } finally {
      setBusy(false);
    }
  };

  const toggleRespondInPrivate = async (value: boolean): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<PublicSettings>('/settings', {
        method: 'PUT',
        body: { whatsapp: { respondInPrivate: value } },
      });
      setSettings(result);
      setNotice({ tone: 'ok', text: `Responder no privado: ${value ? 'ligado' : 'desligado'}` });
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Falha ao salvar' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-cards">
      {notice !== null && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <Card title="Inteligência Artificial" className="span-2">
        <form onSubmit={saveAI} className="form-grid">
          {presets.length > 0 && (
            <Field
              label="Preset rápido"
              hint="Preenche provedor, URL e modelo; a API key você coloca diligentemente"
            >
              <select
                value=""
                onChange={(e) => {
                  const preset = presets.find((p) => p.id === e.target.value);
                  if (preset !== undefined) applyPreset(preset);
                }}
              >
                <option value="">— escolher preset —</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>{preset.label}</option>
                ))}
              </select>
            </Field>
          )}

          <Field label="Provedor">
            <select
              value={aiForm.provider}
              onChange={(e) => setAiForm({ ...aiForm, provider: e.target.value as PublicAISettings['provider'] })}
            >
              {PROVIDERS.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Modelo principal" hint="Ex.: llama3:8b (Ollama) ou gpt-4o-mini">
            <input
              value={aiForm.model}
              onChange={(e) => setAiForm({ ...aiForm, model: e.target.value })}
              placeholder="nome do modelo"
            />
          </Field>

          <Field label="Modelo alternativo" hint="usado em fallback de erro">
            <input
              value={aiForm.fallbackModel}
              onChange={(e) => setAiForm({ ...aiForm, fallbackModel: e.target.value })}
              placeholder="opcional"
            />
          </Field>

          <Field label="URL do serviço" hint="OpenAI-compat: https://api.openai.com/v1 | Ollama: http://localhost:11434">
            <input
              value={aiForm.baseUrl}
              onChange={(e) => setAiForm({ ...aiForm, baseUrl: e.target.value })}
            />
          </Field>

          <Field
            label="API Key"
            hint={aiForm.hasApiKey ? 'Chave já configurada — deixe como está para manter' : 'não configurada'}
          >
            <input
              type="password"
              value={aiForm.apiKey}
              onChange={(e) => setAiForm({ ...aiForm, apiKey: e.target.value })}
              disabled={aiForm.provider === 'disabled' || aiForm.provider === 'ollama'}
            />
          </Field>

          <Field label={`Temperatura: ${aiForm.temperature}`}
            hint="0 = mais previsível, 2 = mais criativo">
            <input
              type="range" min={0} max={2} step={0.1}
              value={aiForm.temperature}
              onChange={(e) => setAiForm({ ...aiForm, temperature: Number(e.target.value) })}
            />
          </Field>

          <Field label="Limite de tokens por resposta">
            <input
              type="number" min={64} max={8192} step={64}
              value={aiForm.maxTokens}
              onChange={(e) => setAiForm({ ...aiForm, maxTokens: Number(e.target.value) })}
            />
          </Field>

          <Field label="Timeout de resposta (ms)">
            <input
              type="number" min={1000} max={600000} step={1000}
              value={aiForm.timeoutMs}
              onChange={(e) => setAiForm({ ...aiForm, timeoutMs: Number(e.target.value) })}
            />
          </Field>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Salvando...' : 'Salvar IA'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !aiForm.canGenerate}
              onClick={() => void testAI()}
            >
              Testar IA (chamada real)
            </button>
            <Badge tone={aiForm.canGenerate ? 'ok' : 'warn'}>
              {aiForm.canGenerate ? 'pronto pra gerar' : 'IA sem modelo configurado'}
            </Badge>
          </div>
        </form>
      </Card>

      <Card title="Preferências gerais">
        <Field label="Nível de log">
          <select value={settings.log.level} onChange={(e) => void changeLogLevel(e.target.value as LogLevel)}>
            {LEVELS.map((level) => (
              <option key={level} value={level}>{level}</option>
            ))}
          </select>
        </Field>

        <label className="check-line">
          <input
            type="checkbox"
            checked={settings.whatsapp.autoReconnect}
            onChange={(e) => void toggleReconnect(e.target.checked)}
          />
          <span>Reconectar WhatsApp automaticamente</span>
        </label>

        <label className="check-line">
          <input
            type="checkbox"
            checked={settings.whatsapp.respondInPrivate}
            onChange={(e) => void toggleRespondInPrivate(e.target.checked)}
          />
          <span>Responder mensagens em conversas privadas</span>
        </label>

        <p className="dim small">
          API escuta em <code>{settings.server.host}:{settings.server.port}</code>
          {' '}(pode mudar no <code>.env</code>, exige reinício).
        </p>
      </Card>

      <Card title="Segurança — trocar senha do painel">
        <form onSubmit={changePassword} className="form-grid">
          <Field label="Senha atual">
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </Field>
          <Field label="Nova senha" hint="mínimo 8 caracteres">
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
          <Field label="Confirmar nova senha">
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword2}
              onChange={(e) => setNewPassword2(e.target.value)}
            />
          </Field>
          <div className="form-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || currentPassword === '' || newPassword.length < 8}
            >
              Trocar senha
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
