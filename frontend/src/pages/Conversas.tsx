import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Card, Badge, EmptyState, Notice, Spinner, timeLabel } from '../components/ui.tsx';
import { api, ApiError } from '../services/api.ts';
import { useOutletContext } from 'react-router-dom';
import type { ChatSummary, StoredChatMessage } from '../types.ts';

type OutletType = { socket: ReturnType<typeof import('../hooks/useSocket.ts').useAppSocket> };

export function Conversas() {
  const { socket } = useOutletContext<OutletType>();
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ChatSummary | null>(null);
  const [messages, setMessages] = useState<StoredChatMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const debounceRef = useRef<number | null>(null);

  const loadChats = useCallback(async (term: string): Promise<void> => {
    try {
      const query = term.trim() === '' ? '' : `?search=${encodeURIComponent(term.trim())}`;
      const data = await api<{ chats: ChatSummary[] }>(`/whatsapp/conversations${query}`);
      setChats(data.chats);
    } catch {
      setChats([]);
    }
  }, []);

  const loadMessages = useCallback(async (jid: string): Promise<void> => {
    setMessages(null);
    try {
      const data = await api<{ messages: StoredChatMessage[] }>(
        `/whatsapp/conversations/${encodeURIComponent(jid)}/messages`,
      );
      setMessages(data.messages);
    } catch {
      setMessages([]);
      setNotice({ tone: 'err', text: 'Falha ao carregar histórico' });
    }
  }, []);

  useEffect(() => {
    void loadChats('');
    if (socket === null) return undefined;
    const onUpdate = (): void => {
      void loadChats(search);
    };
    socket.on('conversation:update', onUpdate);
    return () => {
      socket.off('conversation:update', onUpdate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, loadChats]);

  const onSearch = (term: string): void => {
    setSearch(term);
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void loadChats(term);
    }, 350);
  };

  const selectChat = (chat: ChatSummary): void => {
    setSelected(chat);
    void loadMessages(chat.jid);
    setNotice(null);
  };

  const toggleMemory = async (chat: ChatSummary): Promise<void> => {
    try {
      await api(`/whatsapp/conversations/${encodeURIComponent(chat.jid)}/memory`, {
        method: 'PUT',
        body: { enabled: !chat.memoryEnabled },
      });
      const nextValue = !chat.memoryEnabled;
      const updated = chats?.map((c) => (c.jid === chat.jid ? { ...c, memoryEnabled: nextValue } : c)) ?? null;
      setChats(updated);
      if (updated !== null) setSelected(updated.find((c) => c.jid === chat.jid) ?? null);
      setNotice({
        tone: 'ok',
        text: nextValue ? 'Memória religada para essa conversa.' : 'Memória desligada para essa conversa.',
      });
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Falha ao alterar memória' });
    }
  };

  const sendMessage = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const chat = selected;
    const text = draft.trim();
    if (chat === null || text === '') return;
    setNotice(null);
    try {
      await api(`/whatsapp/conversations/${encodeURIComponent(chat.jid)}/message`, {
        method: 'POST',
        body: { text },
      });
      setDraft('');
      await loadMessages(chat.jid);
      await loadChats(search);
      setNotice({ tone: 'ok', text: 'Mensagem saiu pelo WhatsApp!' });
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Falha ao enviar' });
    }
  };

  const sorted = useMemo(() => chats ?? [], [chats]);

  if (chats === null) {
    return (
      <Card title="Conversas">
        <Spinner label="Carregando conversas..." />
      </Card>
    );
  }

  return (
    <div className="two-pane">
      <Card title="Conversas registradas" className="pane-list">
        <input
          className="search-input"
          placeholder="Buscar por Jid, título ou última mensagem..."
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        {sorted.length === 0 ? (
          <EmptyState title="Nenhuma conversa ainda">
            Quando mensagens chegarem no WhatsApp conectado, elas aparecem aqui.
          </EmptyState>
        ) : (
          <ul className="chat-list">
            {sorted.map((chat) => (
              <li key={chat.jid}>
                <button
                  type="button"
                  className={`chat-item${selected?.jid === chat.jid ? ' active' : ''}`}
                  onClick={() => selectChat(chat)}
                >
                  <div className="chat-item-head">
                    <strong>{chat.title ?? chat.jid}</strong>
                    <Badge tone={chat.type === 'group' ? 'accent' : 'neutral'}>
                      {chat.type === 'group' ? 'grupo' : 'privado'}
                    </Badge>
                  </div>
                  <span className="dim small chat-preview">{chat.lastBody ?? '(sem texto)'}</span>
                  <span className="dim small">{chat.lastAt !== null ? timeLabel(chat.lastAt) : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="pane-detail">
        {selected === null ? (
          <Card title="Histórico">
            <EmptyState title="Selecione uma conversa">
              Clique numa conversa à esquerda para ver o histórico e interagir.
            </EmptyState>
          </Card>
        ) : (
          <Card
            title={selected.title ?? selected.jid}
            right={
              <div className="pill-row">
                <Badge tone={selected.memoryEnabled ? 'ok' : 'warn'}>
                  {selected.memoryEnabled ? 'memória ativa' : 'memória off'}
                </Badge>
                <button type="button" className="btn btn-ghost" onClick={() => void toggleMemory(selected)}>
                  {selected.memoryEnabled ? 'Desligar memória' : 'Religar memória'}
                </button>
              </div>
            }
          >
            {notice !== null && <Notice tone={notice.tone}>{notice.text}</Notice>}

            {messages === null ? (
              <Spinner label="Carregando mensagens..." />
            ) : messages.length === 0 ? (
              <EmptyState title="Sem mensagens registradas" />
            ) : (
              <ul className="msg-list">
                {messages.map((message) => (
                  <li key={message.id} className={`msg ${message.direction === 'out' ? 'msg-out' : 'msg-in'}`}>
                    <span className="msg-meta">
                      {message.direction === 'out' ? 'Geraldo' : message.senderName ?? message.sender}
                      {' · '}
                      {timeLabel(message.createdAt)}
                    </span>
                    <p className="msg-body">{message.body ?? `(${message.kind})`}</p>
                  </li>
                ))}
              </ul>
            )}

            <form onSubmit={sendMessage} className="send-row">
              <input
                placeholder="Mandar um recado pelo WhatsApp..."
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={4000}
              />
              <button type="submit" className="btn btn-primary" disabled={draft.trim() === ''}>
                Enviar
              </button>
            </form>
          </Card>
        )}
      </div>
    </div>
  );
}
