import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../services/api.ts';
import { playCatalogFile } from '../services/media.ts';
import { useAppSocket } from '../hooks/useSocket.ts';
import { Badge, Card, Notice, Spinner } from '../components/ui.tsx';
import { timeLabel } from '../components/ui.tsx';
import type { VoiceClip, VoiceStatusPayload, WhatsAppState } from '../types.ts';

interface WhatsAppStatusEvent {
  state: WhatsAppState;
  phone: string | null;
  note: string;
  qr: { dataUrl: string; updatedAt: string } | null;
}

interface ChatSummaryLite {
  jid: string;
  type: 'private' | 'group';
  title: string | null;
}

function chatLabel(chat: ChatSummaryLite): string {
  if (chat.title !== null && chat.title !== '') return chat.title;
  return chat.type === 'group' ? 'grupo sem título' : chat.jid.slice(0, 22);
}

const MAX_TEXT = 400;

function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  return `${(bytes / 1024).toFixed(0)} KB`;
}

export function Voz(): JSX.Element {
  const socket = useAppSocket();

  const [status, setStatus] = useState<VoiceStatusPayload | null>(null);
  const [clips, setClips] = useState<VoiceClip[]>([]);
  const [waState, setWaState] = useState<WhatsAppState | null>(null);
  const [chats, setChats] = useState<ChatSummaryLite[]>([]);
  const [jid, setJid] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [text, setText] = useState('');
  const [installing, setInstalling] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);

  const connected = waState === 'connected';

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      const payload = await api<VoiceStatusPayload>('/voice/status', { method: 'GET' });
      setStatus(payload);
      setVoiceId((current) => {
        if (current !== '') return current;
        return payload.voices[0]?.id ?? '';
      });
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'erro no status da voz' });
    }
  }, []);

  const refreshClips = useCallback(async (): Promise<void> => {
    try {
      const payload = await api<{ clips: VoiceClip[] }>('/voice/clips', { method: 'GET' });
      setClips(payload.clips ?? []);
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'erro no catálogo de clips' });
    }
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const payload = await api<{ state: WhatsAppState }>('/whatsapp/status', { method: 'GET' });
        if (live) setWaState(payload.state);
      } catch {
        /* sem status: desconnectado até evento */
      }
      try {
        const payload = await api<{ chats: ChatSummaryLite[] }>('/whatsapp/conversations', { method: 'GET' });
        if (live) setChats(payload.chats ?? []);
      } catch {
        /* sem chats: campos honestos vazios */
      }
      if (live) {
        await refreshStatus();
        await refreshClips();
      }
    })();
    return () => {
      live = false;
    };
  }, [refreshStatus, refreshClips]);

  useEffect(() => {
    if (socket === null) return undefined;
    const onStatus = (info: WhatsAppStatusEvent): void => setWaState(info.state);
    socket.on('whatsapp:status', onStatus);
    return () => {
      socket.off('whatsapp:status', onStatus);
    };
  }, [socket]);

  const install = async (): Promise<void> => {
    setInstalling(true);
    setNotice(null);
    try {
      await api<{ ok: boolean; note: string }>('/voice/install', {
        method: 'POST',
        body: { voiceId: 'pt_BR-faber-medium' },
      });
      setNotice({ tone: 'ok', text: 'piper e voz faber instalados ✓' });
      await refreshStatus();
    } catch (error) {
      setNotice({
        tone: 'err',
        text: error instanceof ApiError ? error.message : 'a instalação falhou no servidor',
      });
    } finally {
      setInstalling(false);
    }
  };

  const synth = async (formEvent: React.FormEvent): Promise<void> => {
    formEvent.preventDefault();
    const trimmed = text.trim();
    if (trimmed === '') {
      setNotice({ tone: 'warn', text: 'escreve a fala antes de gerar' });
      return;
    }
    setGenerating(true);
    setNotice(null);
    try {
      const made = await api<{ ok: boolean; id: string; voice: string; cached: boolean }>('/voice/synthesize', {
        method: 'POST',
        body: { text: trimmed, voiceId: voiceId !== '' ? voiceId : undefined },
      });
      setNotice({
        tone: 'ok',
        text: made.cached ? 'voz re-gerada do cache (mesmo texto+voz) ✓' : 'fala gerada ✓ — tá no catálogo aí embaixo',
      });
      setText('');
      await refreshClips();
    } catch (error) {
      setNotice({
        tone: 'err',
        text: error instanceof ApiError ? error.message : 'falhou sintetizar a fala',
      });
    } finally {
      setGenerating(false);
    }
  };

  const sendClip = async (clip: VoiceClip): Promise<void> => {
    if (!connected) {
      setNotice({ tone: 'warn', text: 'o WhatsApp não está conectado — conecta na aba WhatsApp primeiro' });
      return;
    }
    if (jid === '') {
      setNotice({ tone: 'warn', text: 'escolhe o chat de destino na lista de cima' });
      return;
    }
    setBusyId(clip.id);
    setNotice(null);
    try {
      await api<{ ok: boolean; wamid: string }>('/voice/send', {
        method: 'POST',
        body: { clipId: clip.id, jid },
      });
      setNotice({ tone: 'ok', text: `nota de voz mandada (${clip.title}) ✓` });
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou mandar a nota de voz' });
    } finally {
      setBusyId(null);
    }
  };

  const listen = async (clip: VoiceClip): Promise<void> => {
    setBusyId(clip.id);
    try {
      await playCatalogFile(clip.id);
    } catch (error) {
      setNotice({
        tone: 'err',
        text: error instanceof ApiError ? error.message : 'não consegui tocar o clip (arquivo sumiu?)',
      });
    } finally {
      setBusyId(null);
    }
  };

  const ready = status?.ready === true;

  return (
    <div className="stack">
      <Card title="Voz (Piper TTS local)">
        {notice !== null ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

        <p className="voice-note">
          Texto → fala com o Piper rodando <strong>nesta máquina</strong> (sem nuvem): o binário e
          as vozes pt_BR vêm do GitHub/HuggingFace oficial do Piper. Na primeira instalação baixam ~85 MB
          (22 MB do piper + ~63 MB da voz faber); precisa do ffmpeg pra virar OGG/Opus de nota de voz.
        </p>

        {status === null ? (
          <Spinner label="conferindo piper e vozes…" />
        ) : (
          <div className="voice-badge-row">
            <Badge tone={status.piper.piperPath !== null ? 'ok' : 'err'}>
              {status.piper.piperPath !== null
                ? `Piper v${status.piper.version ?? '?'} instalado`
                : 'Piper ausente'}
            </Badge>
            <Badge tone={status.voices.length > 0 ? 'ok' : 'err'}>
              {String(status.voices.length)} voz(es) pt_BR
            </Badge>
            <Badge tone={ready ? 'ok' : 'warn'}>{ready ? 'pronto pra sintetizar' : 'incompleto'}</Badge>
            <button
              type="button"
              className="btn-tiny"
              disabled={installing || ready}
              onClick={() => void install()}
            >
              {ready ? 'piper + voz instalados' : installing ? 'instalando… (~85 MB)' : 'Instalar Piper + voz'}
            </button>
          </div>
        )}
        {status !== null && status.hint !== null && !ready ? (
          <Notice tone="warn">{status.hint}</Notice>
        ) : null}
        {status !== null && status.voices.length > 0 ? (
          <p className="voice-note">
            vozes em {status.voices.map((voice) => `${voice.label} (${voice.quality})`).join(', ')}
          </p>
        ) : null}
      </Card>

      <Card title="Gerar fala">
        {status !== null && !ready ? (
          <p className="pane-empty">Instala o piper e uma voz aí em cima pra poder gerar.</p>
        ) : (
          <form onSubmit={(event) => void synth(event)} className="voice-form">
            <select
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value)}
              disabled={status === null || status.voices.length === 0}
            >
              <option value="">— voz (a primeira instalada) —</option>
              {(status?.voices ?? []).map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {voice.label} ({voice.quality}) — {voice.id}
                </option>
              ))}
            </select>
            <textarea
              className="voice-textarea"
              value={text}
              maxLength={MAX_TEXT}
              onChange={(event) => setText(event.target.value)}
              placeholder="ex: Axente Geraldo, tudo certo, cabra da peste?"
              spellCheck={false}
            />
            <div className="voice-form-row">
              <button type="submit" disabled={generating || text.trim() === ''}>
                {generating ? 'sintetizando…' : 'Gerar voz'}
              </button>
              <span className="voice-counter">
                {String(text.length)}/{String(MAX_TEXT)}
              </span>
            </div>
          </form>
        )}
      </Card>

      <Card title="Clips gerados (catálogo)">
        <div className="meme-target">
          <span className="field-label">Mandar como nota de voz:</span>
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
        </div>

        {clips.length === 0 ? (
          <p className="pane-empty">Nada gerado ainda — escreve uma fala aí em cima.</p>
        ) : (
          <ul className="meme-list">
            {clips.map((clip) => (
              <li key={clip.id} className="meme-row" style={{ padding: 8 }}>
                <span className="meme-title" title={clip.title}>
                  {clip.title}
                </span>
                <span className="download-meta">
                  {fmtBytes(clip.bytes)} · {timeLabel(clip.createdAt)}
                </span>
                <button className="btn-tiny" type="button" onClick={() => void listen(clip)}>
                  ouvir
                </button>
                <button
                  className="btn-tiny btn-send"
                  type="button"
                  disabled={!connected || jid === '' || busyId === clip.id}
                  onClick={() => void sendClip(clip)}
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
