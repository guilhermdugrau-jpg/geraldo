import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../services/api.ts';
import { fetchFileBlobUrl } from '../services/media.ts';
import { useAppSocket } from '../hooks/useSocket.ts';
import { Badge, Card, Notice, Spinner } from '../components/ui.tsx';
import type { ImageRecord, ImageStatusPayload, WhatsAppState } from '../types.ts';

interface ChatSummaryLite {
  jid: string;
  type: 'private' | 'group';
  title: string | null;
}

function chatLabel(chat: ChatSummaryLite): string {
  if (chat.title !== null && chat.title !== '') return chat.title;
  return chat.type === 'group' ? 'grupo sem título' : chat.jid.slice(0, 22);
}

const PROVIDER_LABELS: Record<string, string> = {
  zai: 'Z.ai (GLM-Image)',
  gemini: 'Google Gemini (nano-banana)',
  openai: 'Gateway OpenAI-compat',
};

/** Tamanhos preenchíveis do select — válidos pro validador do backend. */
const SIZE_OPTIONS = ['1280x1280', '1024x1024', '768x768', '512x512', '1536x1536', '2048x2048'];

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function shortDate(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

export function Imagens(): JSX.Element {
  const socket = useAppSocket();

  const [status, setStatus] = useState<ImageStatusPayload | null>(null);
  const [waState, setWaState] = useState<WhatsAppState | null>(null);
  const [chats, setChats] = useState<ChatSummaryLite[]>([]);
  const [jid, setJid] = useState('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('');
  const [caption, setCaption] = useState('');
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);

  const connected = waState === 'connected';
  const ready = status?.ready === true;

  const refreshImages = useCallback(async (): Promise<void> => {
    try {
      const payload = await api<{ images: ImageRecord[] }>('/images/list', { method: 'GET' });
      setImages(payload.images ?? []);
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'erro na galeria de imagens' });
    }
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const statusPayload = await api<ImageStatusPayload>('/images/status', { method: 'GET' });
        if (live) setStatus(statusPayload);
      } catch {
        /* sem status: fica null e os botões ficam travados honestos */
      }
      try {
        const wa = await api<{ state: WhatsAppState }>('/whatsapp/status', { method: 'GET' });
        if (live) setWaState(wa.state);
      } catch {
        /* mudando sem status: fica desconectado até evento */
      }
      try {
        const chatsPayload = await api<{ chats: ChatSummaryLite[] }>('/whatsapp/conversations', { method: 'GET' });
        if (live) setChats(chatsPayload.chats ?? []);
      } catch {
        /* sem chats: campos honestos vazios */
      }
      await refreshImages();
    })();
    return () => {
      live = false;
    };
  }, [refreshImages]);

  useEffect(() => {
    if (socket === null) return undefined;
    const onStatus = (info: { state: WhatsAppState }): void => setWaState(info.state);
    socket.on('whatsapp:status', onStatus);
    return () => {
      socket.off('whatsapp:status', onStatus);
    };
  }, [socket]);

  // Prévias da galeria: blob autenticado por imagem, revogado ao limpar.
  useEffect(() => {
    let live = true;
    void (async () => {
      const next: Record<string, string> = {};
      for (const image of images) {
        try {
          next[image.id] = await fetchFileBlobUrl(image.id);
        } catch {
          /* prévia sumida: tile sem imagem, meta continua */
        }
      }
      if (live) setThumbs(next);
    })();
    return () => {
      live = false;
      for (const url of Object.values(thumbs)) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images]);

  const generate = async (submitEvent: React.FormEvent): Promise<void> => {
    submitEvent.preventDefault();
    const trimmed = prompt.trim();
    if (trimmed === '') {
      setNotice({ tone: 'warn', text: 'escreve o prompt da imagem antes de gerar' });
      return;
    }
    setGenerating(true);
    setNotice(null);
    try {
      const payload = await api<{ image: ImageRecord }>('/images/generate', {
        method: 'POST',
        body: size === '' ? { prompt: trimmed } : { prompt: trimmed, size },
      });
      setNotice({ tone: 'ok', text: 'imagem gerada — caiu na galeria aí embaixo' });
      void payload;
      await refreshImages();
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou gerar a imagem' });
    } finally {
      setGenerating(false);
    }
  };

  const sendImage = async (image: ImageRecord): Promise<void> => {
    if (!connected) {
      setNotice({ tone: 'warn', text: 'o WhatsApp não está conectado — conecta na aba WhatsApp primeiro' });
      return;
    }
    if (jid === '') {
      setNotice({ tone: 'warn', text: 'escolhe o chat de destino na lista de cima' });
      return;
    }
    setBusyId(image.id);
    setNotice(null);
    try {
      await api<{ wamid: string }>('/images/send', {
        method: 'POST',
        body: { imageId: image.id, jid, caption: caption.trim() === '' ? undefined : caption.trim() },
      });
      setNotice({ tone: 'ok', text: 'imagem mandada no chat ✓' });
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou mandar a imagem' });
    } finally {
      setBusyId(null);
    }
  };

  const statusBadge =
    status === null ? (
      <Badge tone="neutral">verificando…</Badge>
    ) : ready ? (
      <Badge tone="ok">{`${PROVIDER_LABELS[status.provider] ?? status.provider} · ${status.modelName}`}</Badge>
    ) : (
      <Badge tone="warn">geração de imagem não pronta</Badge>
    );

  return (
    <div className="stack">
      <Card title="Imagens (geração por IA)">
        {notice !== null ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

        <p className="image-note">
          Gera imagem por prompt no provedor de IA configurado. Os provedores que aceitam imagem são
          <strong> Z.ai (GLM-Image)</strong>,<strong> Google Gemini</strong> e gateways<strong> OpenAI-compat</strong> —
          groq/ollama/openrouter não expõem imagem e isso é dito sem enrolação. Sem cache aqui de
          propósito: o mesmo prompt gera imagem nova cada vez.
        </p>

        <div className="image-badge-row">
          {statusBadge}
          {status?.costNote !== null && status?.costNote !== undefined ? (
            <Badge tone="accent">{status.costNote}</Badge>
          ) : null}
        </div>
        {status !== null && !ready && status.hint !== null ? (
          <Notice tone="warn">{status.hint}</Notice>
        ) : null}

        <form onSubmit={(event) => void generate(event)} className="image-form">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value.slice(0, 1000))}
            placeholder="ex: um caminhoneiro brasileiro no asfalto ao pôr do sol, pintura digital"
            className="voice-textarea image-textarea"
            disabled={!ready || generating}
            spellCheck={false}
          />
          <div className="voice-form-row">
            <span className="image-counter dim">{`${String(prompt.length)}/1000`}</span>
          </div>
          <div className="image-size-row">
            <select
              value={size}
              onChange={(event) => setSize(event.target.value)}
              disabled={!ready || generating}
              className="image-size"
              aria-label="tamanho da imagem"
            >
              <option value="">— tamanho padrão —</option>
              {SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <button type="submit" disabled={!ready || generating}>
              {generating ? 'gerando…' : 'Gerar imagem'}
            </button>
          </div>
          {size !== '' ? (
            <p className="image-size-hint dim">
              O tamanho passa reto pro provedor (512–2048 px por lado). Só quem aceita é o
              GLM-Image da Z.ai — em Gemini/OpenAI o parâmetro é ignorado pelo modelo.
            </p>
          ) : null}
        </form>
      </Card>

      <Card title="Mandar no WhatsApp">
        <div className="image-target">
          <span className="field-label">Chat de destino:</span>
          <select value={jid} onChange={(event) => setJid(event.target.value)} disabled={chats.length === 0}>
            <option value="">— escolhe o chat —</option>
            {chats.map((chat) => (
              <option key={chat.jid} value={chat.jid}>
                {chatLabel(chat)}
              </option>
            ))}
          </select>
          <Badge tone={connected ? 'ok' : 'err'}>
            {connected ? 'WhatsApp conectado' : 'WhatsApp desconectado'}
          </Badge>
          <input
            value={caption}
            onChange={(event) => setCaption(event.target.value.slice(0, 300))}
            placeholder="legenda opcional ao mandar"
            className="image-caption"
            autoComplete="off"
          />
        </div>
      </Card>

      <Card
        title="Galeria de imagens geradas"
        right={<Badge tone="neutral">{`${String(images.length)} imagem(ns)`}</Badge>}
      >
        {images.length === 0 ? (
          <p className="pane-empty">Galeria vazia: nenhuma imagem gerada ainda.</p>
        ) : (
          <ul className="image-grid">
            {images.map((image) => (
              <li key={image.id} className="image-tile">
                <div className="image-thumb">
                  {thumbs[image.id] !== undefined ? (
                    <img src={thumbs[image.id]} alt={image.prompt} loading="lazy" />
                  ) : (
                    <div className="image-thumb-loading">
                      <Spinner label="…" />
                    </div>
                  )}
                </div>
                <p className="image-prompt" title={image.prompt}>
                  {image.prompt}
                </p>
                <p className="image-meta dim">
                  {image.provider} · {formatBytes(image.bytes)} · {shortDate(image.createdAt)}
                  {image.size !== null ? ` · ${image.size}` : ''}
                </p>
                <button
                  className="btn-tiny btn-send"
                  type="button"
                  disabled={!connected || jid === '' || busyId === image.id}
                  onClick={() => void sendImage(image)}
                >
                  mandar
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
