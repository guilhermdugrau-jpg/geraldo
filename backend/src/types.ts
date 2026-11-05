import type { Logger, ChildLogger } from './logger/logger.ts';
import type { Database } from './database/database.ts';
import type { AuthService } from './security/auth.ts';
import type { SettingsService } from './services/settingsService.ts';
import type { SystemStatusService } from './services/systemStatus.ts';
import type { StatsService } from './services/statsService.ts';
import type { ConfigStore } from './config/store.ts';
import type { ResolvedPaths } from './config/paths.ts';
import type { WhatsAppRuntime } from './whatsapp/types.ts';
import type { AIEngine } from './ai/aiEngine.ts';
import type { PanelBridge } from './ws/panelBridge.ts';
import type { MediaEngine } from './media/mediaEngine.ts';
import type { TaskRunner } from './media/runner.ts';
import type { MemeEngine } from './media/memeEngine.ts';
import type { VoiceEngine } from './voice/voiceEngine.ts';
import type { ImageEngine } from './images/imageEngine.ts';
import type { UpdateEngine } from './updates/updateEngine.ts';

/**
 * Runtime montado no boot e injetado nos módulos (rotas, sockets,
 * engines futuros). Evita singletons globais e facilita os testes.
 */
export interface AppContext {
  logger: Logger;
  log: ChildLogger;
  config: ConfigStore;
  db: Database;
  authService: AuthService;
  settings: SettingsService;
  status: SystemStatusService;
  /** ETAPA 8: contagens agregadas reais pro dashboard. */
  stats: StatsService;
  paths: ResolvedPaths;
  whatsapp: WhatsAppRuntime;
  ai: AIEngine;
  /** ETAPA 4: fila de mídias (runner + engine de download). */
  media: {
    runner: TaskRunner;
    engine: MediaEngine;
    bridge: PanelBridge;
  };
  /** ETAPA 5: memes/sons (busca MyInstants + envio via WhatsApp). */
  memes: MemeEngine;
  /** ETAPA 6: voz (Piper TTS local: texto → OGG → nota de voz). */
  voice: VoiceEngine;
  /** ETAPA 7: imagens (geração por prompt no provedor de IA + envio). */
  images: ImageEngine;
  /** ETAPA 9: atualizador via GitHub Releases (check/stage/prepare/apply). */
  updates: UpdateEngine;
  /** Chamado depois do 202 do /updates/apply — fecha o servidor (inj). */
  updatesOnApply: () => void;
  /** Chamado quando as configurações mudam — painel recebe evento. */
  broadcastSettings: () => void;
  /**
   * Ponte com o arquivo de config para operações de segurança
   * (troca de senha persiste no config.json e atualiza o AuthService).
   */
  securityHooks: {
    changePassword(newPassword: string): { tokenSecret: string; passwordHash: string };
    currentSecrets(): { tokenSecret: string; passwordHash: string | null };
  };
}
