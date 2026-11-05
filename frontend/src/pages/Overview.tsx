import { useCallback, useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { api } from '../services/api.ts';
import type { LayoutOutlet } from '../components/Layout.tsx';
import type { DashboardStats, LogEntry, SystemSnapshot } from '../types.ts';
import { Badge, Card, Spinner, formatUptime, timeLabel, levelTone } from '../components/ui.tsx';

const MEDIA_CATEGORY_LABELS: Record<string, string> = {
  sound: 'sons (memes)',
  voice: 'notas de voz',
  image: 'imagens',
  audio: 'áudios',
  video: 'vídeos',
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function Overview(): JSX.Element {
  const { socket } = useOutletContext<LayoutOutlet>();
  const [status, setStatus] = useState<SystemSnapshot | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recent, setRecent] = useState<LogEntry[]>([]);

  const refreshStats = useCallback(async (): Promise<void> => {
    try {
      const payload = await api<DashboardStats>('/stats', { method: 'GET' });
      setStats(payload);
    } catch {
      // Sem stats: cards ficam ocultos (honesto — nada de zero fake).
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void api<SystemSnapshot>('/system/status')
      .then((snap) => {
        if (!cancelled) setStatus(snap);
      })
      .catch(() => undefined);
    void refreshStats();
    const timer = setInterval(() => void refreshStats(), 30_000);

    let offStatus: (() => void) | undefined;
    if (socket !== null) {
      const onStatus = (snap: SystemSnapshot): void => setStatus(snap);
      const onLog = (entry: LogEntry): void => {
        setRecent((current) => [entry, ...current].slice(0, 10));
      };
      socket.on('status', onStatus);
      socket.on('log', onLog);
      offStatus = () => {
        socket.off('status', onStatus);
        socket.off('log', onLog);
      };
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
      offStatus?.();
    };
  }, [socket, refreshStats]);

  if (status === null) {
    return <Spinner label="Puxando o status do Geraldo..." />;
  }

  const mediaCategories = stats === null ? [] : Object.keys(stats.media.byCategory);

  return (
    <div className="grid-cards">
      <Card title="Estado do Geraldo">
        <StatLine label="Versão" value={status.version} />
        <StatLine label="Uptime" value={formatUptime(status.uptimeSeconds)} />
        <StatLine label="Node" value={status.nodeVersion} />
        <StatLine label="Iniciado em" value={timeLabel(status.startedAt)} />
      </Card>

      <Card
        title="WhatsApp"
        right={<Badge tone={badgeTone(status.whatsapp.state)}>{status.whatsapp.state}</Badge>}
      >
        <p className="dim">{status.whatsapp.note}</p>
      </Card>

      <Card
        title="IA"
        right={<Badge tone={status.ai.configured ? 'ok' : 'warn'}>{status.ai.configured ? 'configurada' : 'não configurada'}</Badge>}
      >
        <StatLine label="Provedor" value={status.ai.provider} />
        <StatLine label="Modelo" value={status.ai.model === '' ? '—' : status.ai.model} />
      </Card>

      <Card title="Recursos locais">
        <StatLine label="RAM (processo)" value={`${String(status.memory.rssMB)} MB`} />
        <StatLine label="Heap usado" value={`${String(status.memory.heapUsedMB)} MB`} />
        <StatLine label="Pasta de dados" value={status.dataDir} mono />
      </Card>

      {stats !== null ? (
        <>
          <Card title="Conversas & mensagens">
            <StatLine label="Conversas" value={String(stats.conversations.total)} />
            <StatLine label="Ativas (24h)" value={String(stats.conversations.last24h)} />
            <StatLine label="Mensagens (total)" value={String(stats.messages.total)} />
            <StatLine label="Mensagens (24h)" value={String(stats.messages.last24h)} />
          </Card>

          <Card
            title="Mídia no botequim"
            right={<Badge tone="neutral">{formatBytes(stats.media.totalBytes)}</Badge>}
          >
            {mediaCategories.length === 0 ? (
              <p className="dim">Nenhuma mídia catalogada ainda.</p>
            ) : (
              mediaCategories
                .slice()
                .sort((a, b) => (stats.media.byCategory[b] ?? 0) - (stats.media.byCategory[a] ?? 0))
                .map((category) => (
                  <StatLine
                    key={category}
                    label={MEDIA_CATEGORY_LABELS[category] ?? category}
                    value={String(stats.media.byCategory[category] ?? 0)}
                  />
                ))
            )}
          </Card>

          <Card title="Tarefas (downloads)">
            <StatLine label="Na fila" value={String(stats.tasks.queued)} />
            <StatLine label="Executando" value={String(stats.tasks.running)} />
            <StatLine label="Concluídas" value={String(stats.tasks.done)} />
            <StatLine label="Falhadas" value={String(stats.tasks.failed)} />
            {stats.tasks.queued === 0 && stats.tasks.running === 0 ? (
              <p className="dim small">Fila ociosa.</p>
            ) : (
              <p className="dim small">Acompanhe o progresso na aba Downloads.</p>
            )}
          </Card>
        </>
      ) : (
        <Card title="Tarefas (fila viva)">
          <StatLine label="Na fila" value={String(status.tasks.queued)} />
          <StatLine label="Executando" value={String(status.tasks.running)} />
          <p className="dim small">{status.tasks.note}</p>
        </Card>
      )}

      <Card title="Atividade recente" className="span-2">
        {recent.length === 0 ? (
          <p className="dim">Nada de novo por enquanto — reassentado e de boa.</p>
        ) : (
          <ul className="mini-logs">
            {recent.map((entry) => (
              <li key={entry.id}>
                <span className="dim mono">{timeLabel(entry.ts)}</span>
                <Badge tone={levelTone(entry.level)}>{entry.level}</Badge>
                <span>{entry.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function StatLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="stat-line">
      <span className="dim">{label}</span>
      <span className={mono ? 'mono truncate' : 'truncate'}>{value}</span>
    </div>
  );
}

function badgeTone(state: string): 'ok' | 'warn' | 'err' {
  if (state === 'connected') return 'ok';
  if (state === 'qr') return 'warn';
  return 'err';
}
