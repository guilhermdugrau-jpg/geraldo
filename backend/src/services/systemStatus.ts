import type { AISettings } from '../config/types.ts';

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

export interface SystemDeps {
  version: () => string;
  startedAt: () => string;
  paths: { dataDir: string };
  effectiveAI: () => AISettings;
  /** ETAPA 4: contagens reais da fila de tarefas. */
  taskCounts?: () => { queued: number; running: number };
  /** ETAPA 8: estado REAL do WhatsApp (antes cravava 'disconnected' fixo). */
  whatsappInfo?: () => { state: SystemSnapshot['whatsapp']['state']; note: string };
}

export class SystemStatusService {
  constructor(private readonly deps: SystemDeps) {}

  snapshot(): SystemSnapshot {
    const memory = process.memoryUsage();
    const ai = this.deps.effectiveAI();
    const counts = this.deps.taskCounts !== undefined ? this.deps.taskCounts() : { queued: 0, running: 0 };
    return {
      name: 'Geraldo AI',
      version: this.deps.version(),
      startedAt: this.deps.startedAt(),
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      memory: {
        rssMB: Math.round(memory.rss / 1024 / 1024),
        heapUsedMB: Math.round(memory.heapUsed / 1024 / 1024),
      },
      // ETAPA 8: estado real injetado do WhatsAppService (se tapping
      // ausente — casos de teste — cai honesto para 'desconectado').
      whatsapp:
        this.deps.whatsappInfo !== undefined
          ? this.deps.whatsappInfo()
          : { state: 'disconnected', note: 'sem fonte de estado injetada' },
      ai: {
        provider: ai.provider,
        model: ai.model,
        configured: ai.provider !== 'disabled' && ai.model.trim() !== '',
      },
      tasks: {
        queued: counts.queued,
        running: counts.running,
        note: counts.queued === 0 && counts.running === 0 ? 'Fila do MediaEngine ociosa' : 'Downloads em andamento',
      },
      dataDir: this.deps.paths.dataDir,
    };
  }
}
