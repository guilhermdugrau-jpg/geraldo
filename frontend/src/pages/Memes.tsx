import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../services/api.ts';
import { playCatalogFile } from '../services/media.ts';
import { useAppSocket } from '../hooks/useSocket.ts';
import { Badge, Card, Notice, Spinner } from '../components/ui.tsx';
import type { InstantHit, SoundRecord, WhatsAppState } from '../types.ts';

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

export function Memes(): JSX.Element {
  const socket = useAppSocket();

  const [waState, setWaState] = useState<WhatsAppState | null>(null);
  const [chats, setChats] = useState<ChatSummaryLite[]>([]);
  const [jid, setJid] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InstantHit[] | null>(null);
  const [sounds, setSounds] = useState<SoundRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);

  const connected = waState === 'connected';

  const refreshSounds = useCallback(async (): Promise<void> => {
    try {
      const payload = await api<{ sounds: SoundRecord[] }>('/memes/sounds', { method: 'GET' });
      setSounds(payload.sounds ?? []);
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'erro no catálogo de sons' });
    }
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const status = await api<{ state: WhatsAppState }>('/whatsapp/status', { method: 'GET' });
        if (live) setWaState(status.state);
      } catch {
        /* mudando sem status: fica desconectado até evento */
      }
      try {
        const payload = await api<{ chats: ChatSummaryLite[] }>('/whatsapp/conversations', { method: 'GET' });
        if (live) setChats(payload.chats ?? []);
      } catch {
        /* sem chats: campos honestos vazios */
      }
      await refreshSounds();
    })();
    return () => {
      live = false;
    };
  }, [refreshSounds]);

  useEffect(() => {
    if (socket === null) return undefined;
    const onStatus = (info: WhatsAppStatusEvent): void => setWaState(info.state);
    socket.on('whatsapp:status', onStatus);
    return () => {
      socket.off('whatsapp:status', onStatus);
    };
  }, [socket]);

  const runSearch = async (searchEvent: React.FormEvent): Promise<void> => {
    searchEvent.preventDefault();
    const trimmed = query.trim();
    if (trimmed === '') {
      setNotice({ tone: 'warn', text: 'manda um nome de som antes de buscar' });
      return;
    }
    setSearching(true);
    setNotice(null);
    try {
      const payload = await api<{ items: InstantHit[] }>(`/memes/search?q=${encodeURIComponent(trimmed)}`, {
        method: 'GET',
      });
      setResults(payload.items ?? []);
    } catch (error) {
      setNotice({
        tone: 'err',
        text: error instanceof ApiError ? error.message : 'a busca falhou no servidor',
      });
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const importSound = async (hit: InstantHit): Promise<void> => {
    setNotice(null);
    try {
      const payload = await api<{ id: string }>('/memes/import', {
        method: 'POST',
        body: { title: hit.title, url: hit.mp3Url },
      });
      setNotice({ tone: 'ok', text: `som importado (${hit.title}) — já tá no catálogo` });
      await refreshSounds();
      void payload;
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou importar o som' });
    }
  };

  const sendSound = async (sound: SoundRecord): Promise<void> => {
    if (!connected) {
      setNotice({ tone: 'warn', text: 'o WhatsApp não está conectado — conecta na aba WhatsApp primeiro' });
      return;
    }
    if (jid === '') {
      setNotice({ tone: 'warn', text: 'escolhe o chat de destino na lista de cima' });
      return;
    }
    setBusyId(sound.id);
    setNotice(null);
    try {
      const payload = await api<{ wamid: string }>('/memes/send', {
        method: 'POST',
        body: { soundId: sound.id, jid },
      });
      setNotice({ tone: 'ok', text: `áudio mandado ("${sound.title}") ✓` });
      void payload;
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou mandar o som' });
    } finally {
      setBusyId(null);
    }
  };

  const previewLocal = async (sound: SoundRecord): Promise<void> => {
    setBusyId(sound.id);
    try {
      await playCatalogFile(sound.id);
    } catch (error) {
      setNotice({
        tone: 'err',
        text: error instanceof ApiError ? error.message : 'não consegui tocar o som (arquivo sumiu?)',
      });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="stack">
      <Card title="Memes & Sons (MyInstants)">
        {notice !== null ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

        <p className="meme-note">
          Busca honesta no MyInstants com intervalo de 3 s entre buscas (site sem API oficial —
          raspo a página pública respeitando robots.txt). Se o pedido for algo fora do site
          <strong> não</strong> invento resultado: erro de verdade.
        </p>

        <form onSubmit={(event) => void runSearch(event)} className="meme-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="ex: vine boom, risada, conga"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={searching}>
            {searching ? 'buscando…' : 'Buscar sons'}
          </button>
        </form>

        <div className="meme-target">
          <span className="field-label">Mandar no WhatsApp:</span>
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
      </Card>

      <Card title="Resultados da busca">
        {searching ? <Spinner label="procurando no MyInstants…" /> : null}
        {results === null && !searching ? (
          <p className="pane-empty">Faça uma busca aí em cima pra ver os sons.</p>
        ) : null}
        {results !== null && results.length === 0 ? (
          <p className="pane-empty">Nada achado com esse nome — tenta outra palavra.</p>
        ) : null}
        {results !== null && results.length > 0 ? (
          <ul className="meme-list">
            {results.map((hit) => (
              <li key={hit.mp3Url} className="meme-row">
                <span className="meme-title" title={hit.mp3Url}>
                  {hit.title}
                </span>
                <audio controls preload="none" src={hit.mp3Url} className="meme-audio" />
                <button
                  className="btn-tiny"
                  type="button"
                  onClick={() => void importSound(hit)}
                >
                  importar
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card title="Meus sons (catálogo)">
        {sounds.length === 0 ? (
          <p className="pane-empty">Catálogo vazio: ninguém importou nada ainda.</p>
        ) : (
          <ul className="meme-list">
            {sounds.map((sound) => (
              <li key={sound.id} className="meme-row" style={{ paddingLeft: 8, paddingRight: 8 }}>
                <span className="meme-title" title={sound.title}>
                  {sound.title}
                </span>
                <button className="btn-tiny" type="button" onClick={() => void previewLocal(sound)}>
                  ouvir
                </button>
                <button
                  className="btn-tiny btn-send"
                  type="button"
                  disabled={!connected || jid === '' || busyId === sound.id}
                  onClick={() => void sendSound(sound)}
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
