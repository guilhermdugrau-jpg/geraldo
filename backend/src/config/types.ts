import type { LogLevel } from '../logger/logger.ts';

export type { LogLevel };

export type AIProviderName =
  | 'disabled'
  | 'openai'
  | 'ollama'
  | 'groq'
  | 'gemini'
  | 'zai'
  | 'openrouter';
export type UpdatesChannel = 'stable' | 'beta' | 'development';

export interface AISettings {
  provider: AIProviderName;
  model: string;
  fallbackModel: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface AppConfig {
  server: { host: string; port: number };
  log: { level: LogLevel };
  security: {
    dashboardPasswordHash: string | null;
    tokenSecret: string;
  };
  ai: AISettings;
  whatsapp: { autoReconnect: boolean; respondInPrivate: boolean };
  updates: {
    channel: UpdatesChannel;
    autoCheck: boolean;
    intervalHours: number;
    owner: string;
    repo: string;
  };
}

export const DEFAULT_CONFIG: AppConfig = {
  server: { host: '127.0.0.1', port: 4820 },
  log: { level: 'info' },
  security: { dashboardPasswordHash: null, tokenSecret: '' },
  ai: {
    provider: 'disabled',
    model: '',
    fallbackModel: '',
    baseUrl: 'http://localhost:11434',
    apiKey: '',
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 120000,
  },
  whatsapp: { autoReconnect: true, respondInPrivate: true },
  updates: {
    channel: 'stable',
    autoCheck: true,
    intervalHours: 6,
    owner: '',
    repo: '',
  },
};

export const AI_PROVIDERS: readonly string[] = [
  'disabled',
  'openai',
  'ollama',
  'groq',
  'gemini',
  'zai',
  'openrouter',
];
const UPDATE_CHANNELS: readonly string[] = ['stable', 'beta', 'development'];
const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function pickInt(obj: Record<string, unknown>, key: string, min: number, max: number): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** Valida um patch não-confiado sobre as configurações de IA. */
export function applyAISettings(target: AISettings, raw: Record<string, unknown>): void {
  const provider = pickString(raw, 'provider');
  if (provider && AI_PROVIDERS.includes(provider)) target.provider = provider as AIProviderName;
  const model = pickString(raw, 'model');
  if (model !== null) target.model = model.slice(0, 200);
  const fallbackModel = pickString(raw, 'fallbackModel');
  if (fallbackModel !== null) target.fallbackModel = fallbackModel.slice(0, 200);
  const baseUrl = pickString(raw, 'baseUrl');
  if (baseUrl !== null && baseUrl.length > 0 && baseUrl.length < 250) target.baseUrl = baseUrl;
  // API key só entra quando não é máscara nem string vazia deliberada.
  const apiKey = pickString(raw, 'apiKey');
  if (apiKey !== null && apiKey !== '' && !apiKey.includes('*')) target.apiKey = apiKey;
  const clearApiKey = raw['clearApiKey'];
  if (clearApiKey === true) target.apiKey = '';
  const temperature = raw['temperature'];
  if (typeof temperature === 'number' && temperature >= 0 && temperature <= 2) {
    target.temperature = temperature;
  }
  const maxTokens = pickInt(raw, 'maxTokens', 1, 8192);
  if (maxTokens !== null) target.maxTokens = maxTokens;
  const timeoutMs = pickInt(raw, 'timeoutMs', 1000, 600000);
  if (timeoutMs !== null) target.timeoutMs = timeoutMs;
}

/**
 * Faz merge de um JSON não-confiado (arquivo de config) sobre a config
 * existente. Campos inválidos são ignorados decaem para os padrões.
 * Usado apenas na carga do arquivo — a API do dashboard tem whitelist
 * própria (SettingsService).
 */
export function mergeConfigPatch(target: AppConfig, patch: Record<string, unknown>): void {
  const apply = (
    section: string,
    cb: (sec: Record<string, unknown>) => void,
  ): void => {
    const raw = patch[section];
    if (isRecord(raw)) cb(raw);
  };

  apply('server', (s) => {
    const host = pickString(s, 'host');
    if (host && host.length > 0 && host.length < 254) target.server.host = host;
    const port = pickInt(s, 'port', 1, 65535);
    if (port !== null) target.server.port = port;
  });

  apply('log', (l) => {
    const level = pickString(l, 'level');
    if (level && LOG_LEVELS.includes(level)) target.log.level = level as LogLevel;
  });

  apply('security', (s) => {
    const hash = pickString(s, 'dashboardPasswordHash');
    if (hash !== null) target.security.dashboardPasswordHash = hash.length > 0 ? hash : null;
    const secret = pickString(s, 'tokenSecret');
    if (secret !== null && secret.length >= 32) target.security.tokenSecret = secret;
  });

  apply('ai', (a) => {
    applyAISettings(target.ai, a);
  });

  apply('whatsapp', (w) => {
    const autoReconnect = w['autoReconnect'];
    if (typeof autoReconnect === 'boolean') target.whatsapp.autoReconnect = autoReconnect;
    const respondInPrivate = w['respondInPrivate'];
    if (typeof respondInPrivate === 'boolean') {
      target.whatsapp.respondInPrivate = respondInPrivate;
    }
  });

  apply('updates', (u) => {
    applyUpdatesSettings(target.updates, u);
  });
}

/**
 * Aplica um patch não-confiado sobre a seção `updates` (usado na carga
 * do config.json E pelo overlay do banco no SettingsService).
 */
export function applyUpdatesSettings(
  target: AppConfig['updates'],
  raw: Record<string, unknown>,
): void {
  const channel = pickString(raw, 'channel');
  if (channel !== null && UPDATE_CHANNELS.includes(channel)) {
    target.channel = channel as UpdatesChannel;
  }
  const autoCheck = raw['autoCheck'];
  if (typeof autoCheck === 'boolean') target.autoCheck = autoCheck;
  const intervalHours = pickInt(raw, 'intervalHours', 1, 168);
  if (intervalHours !== null) target.intervalHours = intervalHours;
  const owner = pickString(raw, 'owner');
  if (owner !== null) target.owner = owner.trim().slice(0, 100);
  const repo = pickString(raw, 'repo');
  if (repo !== null) target.repo = repo.trim().slice(0, 100);
}
