import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken } from '../services/api.ts';
import { useAppSocket } from '../hooks/useSocket.ts';
import { Badge, Card, Notice, Spinner } from '../components/ui.tsx';
import type { MediaFile, MediaFormat, MediaJob, MediaToolsPayload, WhatsAppState } from '../types.ts';

interface ChatSummaryLite {
  jid: string;
  type: 'private' | 'group';
  title: string | null;
}

function chatLabelLite(chat: ChatSummaryLite): string {
  if (chat.title !== null && chat.title !== '') return chat.title;
  return chat.type === 'group' ? 'grupo sem título' : chat.jid.slice(0, 22);
}

/** Mimes mandáveis pelo /media/send (honesto: o backend governa a lista). */
function isSendableMime(mime: string | null): boolean {
  if (mime === null) return false;
  return mime === 'video/mp4' || mime.startsWith('image/') || mime.startsWith('audio/');
}

/** Nome de arquivo a partir do caminho armazenado no servidor. */
function baseName(filePath: string): string {
  const marker = filePath.lastIndexOf(/^[A-Z]:\\/.test(filePath) ? '\\' : '/');
  return marker === -1 ? filePath : filePath.slice(marker + 1);
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function shortDate(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

const STATE_LABELS: Record<MediaJob['state'], string> = {
  queued: 'na fila',
  running: 'baixando',
  done: 'concluído',
  failed: 'falhou',
  canceled: 'cancelado',
};

const STATE_TONES: Record<MediaJob['state'], 'ok' | 'warn' | 'err' | 'neutral'> = {
  queued: 'neutral',
  running: 'warn',
  done: 'ok',
  failed: 'err',
  canceled: 'neutral',
};

/** Baixa o arquivo já com token no header (blob → <a download>). */
async function downloadMediaFile(id: string, name: string, notify: (msg: string) => void): Promise<void> {
  const token = getToken();
  const response = await fetch(`/api/media/files/${id}/file`, {
    headers: token !== null ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    notify(`baixa recusada pelo servidor (HTTP ${String(response.status)})`);
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function Downloads(): JSX.Element {
  const socket = useAppSocket();

  const [tools, setTools] = useState<MediaToolsPayload | null>(null);
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<MediaFormat>('audio');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [waState, setWaState] = useState<WhatsAppState | null>(null);
  const [chats, setChats] = useState<ChatSummaryLite[]>([]);
  const [jid, setJid] = useState('');
  const [sendingId, setSendingId] = useState<string | null>(null);

  const connected = waState === 'connected';

  const notify = useCallback((text: string, tone: 'ok' | 'err' = 'ok'): void => {
    setNotice({ tone, text });
  }, []);

  const refreshFiles = useCallback(async (): Promise<void> => {
    try {
      const payload = await api<{ files: MediaFile[] }>('/media/files', { method: 'GET' });
      setFiles(payload.files ?? []);
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'erro carregando catálogo', 'err');
    }
  }, [notify]);

  const refreshJobs = useCallback(async (): Promise<void> => {
    try {
      const payload = await api<{ jobs: MediaJob[] }>('/media/jobs', { method: 'GET' });
      setJobs(payload.jobs ?? []);
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'erro carregando fila', 'err');
    }
  }, [notify]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const toolsPayload = await api<MediaToolsPayload>('/media/tools', { method: 'GET' });
        if (!live) return;
        setTools(toolsPayload);
      } catch (error) {
        if (live) {
          notify(error instanceof ApiError ? error.message : 'erro nas ferramentas', 'err');
        }
      }
      await Promise.all([refreshJobs(), refreshFiles()]);
      if (live) setLoading(false);
    })();
    return () => {
      live = false;
    };
  }, [refreshJobs, refreshFiles, notify]);

  // ETAPA 7: alvo de envio do catálogo (WhatsApp status + chats).
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const wa = await api<{ state: WhatsAppState }>('/whatsapp/status', { method: 'GET' });
        if (live) setWaState(wa.state);
      } catch {
        /* status de WhatsApp não veio: fica desconectado honesto */
      }
      try {
        const chatsPayload = await api<{ chats: ChatSummaryLite[] }>('/whatsapp/conversations', { method: 'GET' });
        if (live) setChats(chatsPayload.chats ?? []);
      } catch {
        /* sem chats: select fica vazio */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Fila ao vivo: progresso e fim relacionados a download de mídia.
  useEffect(() => {
    if (socket === null) return undefined;
    const onProgress = (job: MediaJob): void => {
      if (job.type !== 'media_download') return;
      setJobs((current) => {
        const without = current.filter((candidate) => candidate.id !== job.id);
        return [job, ...without];
      });
    };
    const onDone = (job: MediaJob): void => {
      if (job.type !== 'media_download') return;
      onProgress(job);
      if (job.state === 'done') void refreshFiles();
    };
    socket.on('media:progress', onProgress);
    socket.on('media:done', onDone);
    return () => {
      socket.off('media:progress', onProgress);
      socket.off('media:done', onDone);
    };
  }, [socket, refreshFiles]);

  useEffect(() => {
    if (socket === null) return undefined;
    const onStatus = (info: { state: WhatsAppState }): void => setWaState(info.state);
    socket.on('whatsapp:status', onStatus);
    return () => {
      socket.off('whatsapp:status', onStatus);
    };
  }, [socket]);

  const submitDownload = async (submitEvent: React.FormEvent): Promise<void> => {
    submitEvent.preventDefault();
    const trimmed = url.trim();
    if (trimmed === '') {
      notify('colar uma URL antes do download', 'err');
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const payload = await api<{ ok: boolean; jobId: string }>('/media/download', {
        method: 'POST',
        body: { url: trimmed, format },
      });
      setUrl('');
      notify(`download na fila (job ${payload.jobId.slice(0, 8)}…), acompanhe no painel`);
      await refreshJobs();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'erro na fila de download', 'err');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelJob = async (id: string): Promise<void> => {
    try {
      await api(`/media/jobs/${id}/cancel`, { method: 'POST' });
      await refreshJobs();
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'erro ao cancelar', 'err');
    }
  };

  // ETAPA 7: manda arquivo do catálogo direto no chat (mime governa no backend).
  const sendCatalogFile = async (file: MediaFile): Promise<void> => {
    if (!connected) {
      notify('o WhatsApp não está conectado — conecta na aba WhatsApp primeiro', 'err');
      return;
    }
    if (jid === '') {
      notify('escolhe o chat de destino primeiro', 'err');
      return;
    }
    setSendingId(file.id);
    try {
      await api<{ wamid: string }>('/media/send', {
        method: 'POST',
        body: { fileId: file.id, jid },
      });
      notify(`arquivo mandado no chat ✓ (${baseName(file.filePath)})`);
    } catch (error) {
      notify(error instanceof ApiError ? error.message : 'falhou mandar o arquivo', 'err');
    } finally {
      setSendingId(null);
    }
  };

  const activeJobs = jobs.filter((job) => job.state === 'queued' || job.state === 'running');
  const finishedJobs = jobs.filter((job) => job.state !== 'queued' && job.state !== 'running');

  return (
    <div className="stack">
      <Card title="Fila de mídias">
        <p className="pane-title" style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.65 }}>
          Download de MP3 (áudio) ou MP4 remuxado (vídeo). Catálogo fica por conta do Geraldo.
        </p>
        {notice !== null ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

        {tools !== null && !tools.ready ? (
          <Notice tone="err">
            {tools.hint ?? 'yt-dlp/ffmpeg ausentes'} — ffmpeg caseiro também resolve via GERALDO_FFMPEG.
          </Notice>
        ) : null}

        <form onSubmit={(event) => void submitDownload(event)} className="download-form">
          <div className="download-row">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://…"
              spellCheck={false}
              autoComplete="off"
            />
            <select value={format} onChange={(event) => setFormat(event.target.value as MediaFormat)}>
              <option value="audio">MP3 (áudio)</option>
              <option value="video">MP4 (vídeo)</option>
            </select>
            <button type="submit" disabled={submitting}>
              {submitting ? 'enviando…' : 'Baixar'}
            </button>
          </div>
          {tools?.ready === true ? (
            <p className="tools-line">
              yt-dlp {tools.ytdlpVersion ?? '?'} · ffmpeg {tools.ffmpegVersion ?? '?'}
            </p>
          ) : null}
        </form>

        {loading ? (
          <Spinner label="carregando fila e catálogo…" />
        ) : (
          <div className="download-panes">
            <section aria-label="Fila de downloads">
              <h3 className="pane-title">
                Fila {activeJobs.length > 0 ? <Badge tone="warn">{String(activeJobs.length)} ativa</Badge> : null}
              </h3>
              {activeJobs.length === 0 ? (
                <p className="pane-empty">Fila vazia: sem downloads em andamento.</p>
              ) : (
                <ul className="download-list">
                  {activeJobs.map((job) => (
                    <li key={job.id} className="download-item">
                      <div className="download-item-head">
                        <span className="download-name" title={job.name}>
                          {job.name}
                        </span>
                        <span className="download-meta">{STATE_LABELS[job.state]}</span>
                        <button className="btn-tiny" type="button" onClick={() => void cancelJob(job.id)}>
                          cancelar
                        </button>
                      </div>
                      <div className="progress-track" role="progressbar" aria-valuenow={Math.round(job.progress * 100)}>
                        <div className="progress-fill" style={{ width: `${Math.round(job.progress * 100)}%` }} />
                      </div>
                      <p className="download-detail">{job.detail ?? 'preparando…'}</p>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="pane-title">Fechados</h3>
              {finishedJobs.length === 0 ? (
                <p className="pane-empty">Nenhum download encerrado ainda nesta sessão.</p>
              ) : (
                <ul className="download-list">
                  {finishedJobs.slice(0, 15).map((job) => (
                    <li key={job.id} className="download-item">
                      <div className="download-item-head">
                        <span className="download-name" title={job.name}>
                          {job.name}
                        </span>
                        <Badge tone={STATE_TONES[job.state]}>{STATE_LABELS[job.state]}</Badge>
                      </div>
                      {job.error !== null ? <p className="download-detail">{job.error}</p> : null}
                      {job.detail !== null && job.error === null ? (
                        <p className="download-detail">{job.detail}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-label="Catálogo de mídias">
              <h3 className="pane-title">Catálogo</h3>
              <div className="meme-target" style={{ marginBottom: 10 }}>
                <span className="field-label">Mandar no WhatsApp:</span>
                <select value={jid} onChange={(event) => setJid(event.target.value)} disabled={chats.length === 0}>
                  <option value="">— escolhe o chat —</option>
                  {chats.map((chat) => (
                    <option key={chat.jid} value={chat.jid}>
                      {chatLabelLite(chat)}
                    </option>
                  ))}
                </select>
                <Badge tone={connected ? 'ok' : 'err'}>
                  {connected ? 'conectado' : 'desconectado'}
                </Badge>
              </div>
              {files.length === 0 ? (
                <p className="pane-empty">Catálogo vazio: nenhum arquivo por enquanto.</p>
              ) : (
                <ul className="download-list files">
                  {files.map((file) => (
                    <li key={file.id} className="download-item">
                      <div className="download-item-head">
                        <span className="download-name" title={file.sourceUrl ?? ''}>
                          {file.category === 'image' ? '🖼' : '🎵'} {baseName(file.filePath)}
                        </span>
                        <span className="download-meta">
                          {file.category === 'video' ? 'MP4' : file.category === 'image' ? 'IMG' : 'MP3'} · {formatBytes(file.bytes)}
                        </span>
                        <button
                          className="btn-tiny"
                          type="button"
                          onClick={() => void downloadMediaFile(file.id, baseName(file.filePath), notify)}
                        >
                          salvar
                        </button>
                        {isSendableMime(file.mime) ? (
                          <button
                            className="btn-tiny btn-send"
                            type="button"
                            disabled={!connected || jid === '' || sendingId === file.id}
                            onClick={() => void sendCatalogFile(file)}
                          >
                            mandar
                          </button>
                        ) : null}
                      </div>
                      <p className="download-detail">
                        {shortDate(file.createdAt)}
                        {file.sourceUrl !== null ? ` · ${file.sourceUrl}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Card>
    </div>
  );
}
