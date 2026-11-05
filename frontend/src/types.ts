export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  ts: string;
  level: LogLevel;
  module: string;
  message: string;
  meta?: string;
}

export interface SystemSnapshot {
  name: 'Geraldo AI';
  version: string;
  startedAt: string;
  uptimeSeconds: number;
  nodeVersion: string;
  memory: { rssMB: number; heapUsedMB: number };
  whatsapp: { state: 'disconnected' | 'qr' | 'connected'; note: string };
  ai: { provider: string; model: string; configured: boolean };
  tasks: { queued: number; running: number; note: string };
  dataDir: string;
}

export type AIProviderName =
  | 'disabled'
  | 'openai'
  | 'ollama'
  | 'groq'
  | 'gemini'
  | 'zai'
  | 'openrouter';

export interface PublicAISettings {
  provider: AIProviderName;
  model: string;
  fallbackModel: string;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  canGenerate: boolean;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface AiProviderPreset {
  id: AIProviderName;
  label: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  needsApiKey: boolean;
  apiKeyHint: string;
  notes: string;
}

export interface PublicSettings {
  server: { host: string; port: number };
  log: { level: LogLevel };
  ai: PublicAISettings;
  whatsapp: { autoReconnect: boolean; respondInPrivate: boolean };
  updates: {
    channel: 'stable' | 'beta' | 'development';
    autoCheck: boolean;
    intervalHours: number;
    owner: string;
    repo: string;
  };
}

// ── WhatsApp (ETAPA 2) ──────────────────────────────────────────────────

export type WhatsAppState =
  | 'off'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

export interface WhatsAppInfo {
  state: WhatsAppState;
  phone: string | null;
  note: string;
  qr: { dataUrl: string; updatedAt: string } | null;
}

export interface WhatsAppStatusPayload extends WhatsAppInfo {
  hasSession: boolean;
}

export interface ChatSummary {
  jid: string;
  type: 'private' | 'group';
  title: string | null;
  memoryEnabled: boolean;
  lastBody: string | null;
  lastAt: string | null;
}

export interface StoredChatMessage {
  id: number;
  chat: string;
  sender: string;
  senderName: string | null;
  direction: 'in' | 'out';
  kind: string;
  body: string | null;
  createdAt: string;
}

// ── Mídias / downloads (ETAPA 4) ────────────────────────────────────────

export type MediaJobState = 'queued' | 'running' | 'done' | 'failed' | 'canceled';
export type MediaFormat = 'audio' | 'video';

export interface MediaJob {
  id: string;
  chat: string | null;
  name: string;
  type: string;
  state: MediaJobState;
  progress: number;
  detail: string | null;
  resultPath: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Evento de progresso ao vivo: `detail` é texto de etapa, não payload. */
export interface MediaJobEvent extends MediaJob {}

export interface MediaFile {
  id: string;
  chat: string | null;
  category: string;
  sourceUrl: string | null;
  filePath: string;
  mime: string | null;
  bytes: number | null;
  createdAt: string;
}

export interface MediaToolsPayload {
  ok: boolean;
  ytdlpPath: string | null;
  ffmpegPath: string | null;
  ytdlpVersion: string | null;
  ffmpegVersion: string | null;
  ready: boolean;
  hint: string | null;
}

// ── Memes e sons (ETAPA 5) ──────────────────────────────────────────────

export interface InstantHit {
  title: string;
  mp3Url: string;
}

export interface SoundRecord {
  id: string;
  title: string;
  filePath: string;
  sourceUrl: string | null;
  bytes: number | null;
  createdAt: string;
}

// ── Voz / Piper TTS (ETAPA 6) ───────────────────────────────────────────

export interface PiperVoice {
  id: string;
  label: string;
  quality: string;
  filePath: string;
  jsonPath: string;
  bytes: number;
}

export interface VoiceStatusPayload {
  ok: boolean;
  piper: { piperPath: string | null; version: string | null; checkedAt: string };
  voices: PiperVoice[];
  hint: string | null;
  ready: boolean;
}

export interface VoiceClip {
  id: string;
  title: string;
  filePath: string;
  bytes: number | null;
  createdAt: string;
}

// ── Imagens (ETAPA 7) ───────────────────────────────────────────────────

/** Espelha ImageStatus do backend (sem o ok interno do adapter). */
export interface ImageStatusPayload {
  ok: boolean;
  provider: AIProviderName;
  capable: boolean;
  ready: boolean;
  hint: string | null;
  modelName: string;
  costNote: string | null;
}

/** Espelha ImageRecord do backend (media_files + image_meta). */
export interface ImageRecord {
  id: string;
  prompt: string;
  provider: string;
  model: string;
  size: string | null;
  mime: string | null;
  bytes: number | null;
  filePath: string;
  createdAt: string;
}

// ── Dashboard / stats (ETAPA 8) ─────────────────────────────────────────

/** Espelha DashboardStats do backend (GET /api/stats). */
export interface DashboardStats {
  ok: true;
  whatsapp: { state: WhatsAppState; note: string };
  ai: { provider: string; model: string; configured: boolean };
  conversations: { total: number; last24h: number };
  messages: { total: number; last24h: number };
  media: { totalBytes: number; byCategory: Record<string, number> };
  tasks: { queued: number; running: number; done: number; failed: number; canceled: number };
}

// ── Atualizações (ETAPA 9) ──────────────────────────────────────────────

export type UpdatesChannelName = 'stable' | 'beta' | 'development';

export interface StagedUpdateInfo {
  fileName: string;
  bytes: number;
  sha256: string;
  /** null = o release não tinha checksum (não inventamos verificação). */
  verified: boolean | null;
  version: string | null;
  stagedAt: string;
}

export interface UpdateCheckPayload {
  ok: boolean;
  error?: string;
  hint?: string | null;
  hasUpdate?: boolean;
  current?: string;
  latest?: string;
  prerelease?: boolean;
  publishedAt?: string;
  releaseUrl?: string;
  notes?: string | null;
  /** presente no lado errado: null = release sem pacote .zip */
  asset?: { name: string; bytes: number } | null;
}

export interface UpdateStatusPayload {
  ok: true;
  owner: string;
  repo: string;
  channel: UpdatesChannelName;
  autoCheck: boolean;
  intervalHours: number;
  currentVersion: string;
  configured: boolean;
  hint: string | null;
  staged: StagedUpdateInfo | null;
  pending: { version: string } | null;
  lastCheck: { at: string; hasUpdate: boolean; latest: string | null; hint: string | null } | null;
}
