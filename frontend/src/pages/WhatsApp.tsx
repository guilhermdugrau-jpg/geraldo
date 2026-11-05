import { useCallback, useEffect, useState } from 'react';
import { Card, Badge, Notice, Spinner } from '../components/ui.tsx';
import { api, ApiError } from '../services/api.ts';
import type { useAppSocket } from '../hooks/useSocket.ts';
import type { WhatsAppInfo, WhatsAppStatusPayload } from '../types.ts';

type Socket = ReturnType<typeof useAppSocket>;

const STATE_TONE: Record<string, 'ok' | 'err' | 'warn' | 'neutral' | 'accent'> = {
  connected: 'ok',
  qr: 'accent',
  connecting: 'warn',
  disconnected: 'err',
  logged_out: 'err',
  off: 'neutral',
};

const STATE_LABEL: Record<string, string> = {
  off: 'desligado',
  connecting: 'conectando',
  qr: 'aguardando QR',
  connected: 'conectado',
  disconnected: 'desconectado',
  logged_out: 'sessão deslogada',
};

export function WhatsAppPage({ socket }: { socket: Socket }) {
  const [info, setInfo] = useState<WhatsAppStatusPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const data = await api<WhatsAppStatusPayload>('/whatsapp/status');
      setInfo(data);
    } catch {
      setInfo((current) => current);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (socket === null) return undefined;
    const onStatus = (payload: WhatsAppInfo): void => {
      setInfo((current) => ({ ...(current ?? ({ hasSession: false } as WhatsAppStatusPayload)), ...payload }));
    };
    socket.on('whatsapp:status', onStatus);
    return () => {
      socket.off('whatsapp:status', onStatus);
    };
  }, [socket, refresh]);

  const action = async (path: string, method: 'POST' | 'DELETE'): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await api(path, { method });
      await refresh();
      setNotice({ tone: 'ok', text: 'Comando executado no backend, meu patrão!' });
    } catch (err) {
      setNotice({ tone: 'err', text: err instanceof ApiError ? err.message : 'Falha no comando' });
    } finally {
      setBusy(false);
    }
  };

  const onDeleteSession = async (): Promise<void> => {
    const sure = window.confirm(
      'Isso apaga a sessão salva e desloga o Geraldo do WhatsApp.\nVocê vai precisar escanear o QR de novo.\n\nContinuar?',
    );
    if (!sure) return;
    await action('/whatsapp/session', 'DELETE');
    setNotice({ tone: 'warn', text: 'Sessão apagada — escaneie um QR novo para reconectar.' });
  };

  if (info === null) {
    return (
      <Card title="WhatsApp">
        <Spinner label="Consultando estado do WhatsApp..." />
      </Card>
    );
  }

  const tone = STATE_TONE[info.state] ?? 'neutral';

  return (
    <div className="grid-cards">
      <Card title="WhatsApp" right={<Badge tone={tone}>{STATE_LABEL[info.state] ?? info.state}</Badge>}>
        {notice !== null && <Notice tone={notice.tone}>{notice.text}</Notice>}

        <p className="dim">{info.note}</p>
        {info.phone !== null && (
          <p>
            Sessão ativa: <strong>{info.phone}</strong>
          </p>
        )}
        <p className="dim small">
          {info.hasSession
            ? 'Existe sessão salva no disco — o Geraldo reconecta sozinho no boot.'
            : 'Sem sessão salva. Clique em Conectar e escaneie o QR pelo celular.'}
        </p>

        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || info.state === 'connected' || info.state === 'connecting' || info.state === 'qr'}
            onClick={() => void action('/whatsapp/connect', 'POST')}
          >
            {busy ? 'Async: aguarde...' : 'Conectar e gerar QR'}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || info.state !== 'connected'}
            onClick={() => void action('/whatsapp/disconnect', 'POST')}
          >
            Desconectar (mantém sessão)
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !info.hasSession}
            onClick={() => void onDeleteSession()}
          >
            Apagar sessão
          </button>
        </div>
      </Card>

      {info.qr !== null && (
        <Card title="QR Code" right={<span className="dim small">{new Date(info.qr.updatedAt).toLocaleTimeString()}</span>}>
          <img className="qrcode" src={info.qr.dataUrl} alt="QR de conexão do WhatsApp" />
          <p className="dim small">
            Abra o WhatsApp no celular → Aparelhos conectados → Conectar aparelho.
          </p>
        </Card>
      )}
    </div>
  );
}
