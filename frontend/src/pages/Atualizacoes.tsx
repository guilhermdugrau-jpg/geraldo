import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../services/api.ts';
import { Badge, Card, Notice } from '../components/ui.tsx';
import type {
  StagedUpdateInfo,
  UpdateCheckPayload,
  UpdateStatusPayload,
  UpdatesChannelName,
} from '../types.ts';

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${String(bytes)} B`;
}

function shortDate(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ');
}

const CHANNEL_OPTIONS: Array<{ value: UpdatesChannelName; label: string }> = [
  { value: 'stable', label: 'stable (só finais)' },
  { value: 'beta', label: 'beta (finais + pré)' },
  { value: 'development', label: 'development (idem beta,registro)' },
];

export function Atualizacoes(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatusPayload | null>(null);
  const [check, setCheck] = useState<UpdateCheckPayload | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [channel, setChannel] = useState<UpdatesChannelName>('stable');
  const [intervalHours, setIntervalHours] = useState(6);
  const [autoCheck, setAutoCheck] = useState(true);

  const [checking, setChecking] = useState(false);
  const [staging, setStaging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [applyConfirm, setApplyConfirm] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const payload = await api<UpdateStatusPayload>('/updates/status', { method: 'GET' });
      setStatus(payload);
      setOwner(payload.owner);
      setRepo(payload.repo);
      setChannel(payload.channel);
      setIntervalHours(payload.intervalHours);
      setAutoCheck(payload.autoCheck);
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'status do atualizador indisponível' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveConfig = async (): Promise<void> => {
    setNotice(null);
    try {
      await api<Record<string, unknown>>('/settings', {
        method: 'PUT',
        body: {
          updates: { owner: owner.trim(), repo: repo.trim(), channel, intervalHours, autoCheck },
        },
      });
      setNotice({ tone: 'ok', text: 'config salva — o motor relê owner/repo/canal a cada ação (intervalo do automático muda só ao reiniciar)' });
      await refresh();
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou salvar a config de updates' });
    }
  };

  const checkNow = async (): Promise<void> => {
    setChecking(true);
    setNotice(null);
    try {
      const result = await api<UpdateCheckPayload>('/updates/check', { method: 'POST' });
      setCheck(result);
      await refresh();
      if (result.ok === true && result.hasUpdate) {
        setNotice({ tone: 'ok', text: `versão nova encontrada: ${result.latest}` });
      } else if (result.ok === true) {
        setNotice({ tone: 'ok', text: 'nada a atualizar — você já tá na mais nova do canal' });
      }
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'verificação sem resposta' });
    } finally {
      setChecking(false);
    }
  };

  const stageNow = async (): Promise<void> => {
    setStaging(true);
    setNotice(null);
    try {
      await api<{ staged: StagedUpdateInfo }>('/updates/stage', { method: 'POST' });
      setNotice({ tone: 'ok', text: 'pacote baixado — aparece na instalação aí embaixo' });
      await refresh();
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou baixar o pacote' });
    } finally {
      setStaging(false);
    }
  };

  const prepareNow = async (): Promise<void> => {
    setPreparing(true);
    setNotice(null);
    try {
      const made = await api<{ version: string; dirs: number }>('/updates/prepare', { method: 'POST' });
      setNotice({ tone: 'ok', text: `pacote preparado: versão ${made.version} — dá uma olhada e aplica quando quiser` });
      await refresh();
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou preparar o pacote' });
    } finally {
      setPreparing(false);
    }
  };

  const discardNow = async (): Promise<void> => {
    setNotice(null);
    try {
      await api<Record<string, unknown>>('/updates/discard', { method: 'POST' });
      setNotice({ tone: 'ok', text: 'pacote descartado' });
      await refresh();
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou descartar o pacote' });
    }
  };

  const applyNow = async (): Promise<void> => {
    setNotice(null);
    try {
      const result = await api<{ message: string }>('/updates/apply', { method: 'POST' });
      setApplied(result.message);
    } catch (error) {
      setNotice({ tone: 'err', text: error instanceof ApiError ? error.message : 'falhou aplicar a atualização' });
    }
  };

  const staged = status?.staged ?? null;
  const pendingVersion = status?.pending?.version ?? null;

  const verifiedBadge = (info: StagedUpdateInfo): JSX.Element => {
    if (info.verified === true) return <Badge tone="ok">checksum SHA-256 confere</Badge>;
    if (info.verified === false) return <Badge tone="err">checksum NÃO confere</Badge>;
    return <Badge tone="warn">sem checksum no release (não confere a bagaça)</Badge>;
  };

  return (
    <div className="stack">
      {applied !== null ? (
        <Card title="Atualização em aplicação">
          <Notice tone="warn">
            {applied} — deixa o Geraldo fechar e abre de novo pelo START.bat. Dados
            (conversas, media, config) ficam em %APPDATA%\Geraldo e NÃO são tocados.
          </Notice>
        </Card>
      ) : null}

      <Card
        title="Atualizações"
        right={<Badge tone="neutral">{`v${status?.currentVersion ?? '…'}`}</Badge>}
      >
        {notice !== null ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
        {status !== null && status.hint !== null && applied === null ? (
          <Notice tone="warn">{status.hint}</Notice>
        ) : null}

        <div className="image-badge-row">
          <Badge tone={status?.configured ? 'ok' : 'warn'}>
            {status?.configured ? `${status.owner}/${status.repo}` : 'repositório não configurado'}
          </Badge>
          <Badge tone="accent">
            {`canal: ${status?.channel ?? channel} · automático: ${
              status?.autoCheck ? `${String(status.intervalHours)}h` : 'desligado'
            }`}
          </Badge>
          {status?.lastCheck !== null && status?.lastCheck !== undefined ? (
            <Badge tone={status.lastCheck.hasUpdate ? 'ok' : 'neutral'}>
              {status.lastCheck.hasUpdate
                ? `nova: ${status.lastCheck.latest ?? '?'} (${shortDate(status.lastCheck.at)})`
                : `nada novo (${shortDate(status.lastCheck.at)})`}
            </Badge>
          ) : null}
        </div>

        <button type="button" disabled={checking} onClick={() => void checkNow()}>
          {checking ? 'verificando…' : 'Verificar no GitHub'}
        </button>

        {check !== null && check.ok === true && check.hasUpdate === true ? (
          <div className="updates-check">
            <p className="image-prompt">
              <strong>{check.latest}</strong> publicada{check.prerelease === true ? ' (pré-release)' : ''} em{' '}
              {shortDate(check.publishedAt ?? '')}
              {check.releaseUrl !== '' && check.releaseUrl !== undefined ? (
                <>
                  {' · '}
                  <a href={check.releaseUrl} target="_blank" rel="noreferrer">
                    ver no GitHub
                  </a>
                </>
              ) : null}
            </p>
            {check.notes !== null && check.notes !== undefined ? (
              <pre className="updates-notes">{check.notes}</pre>
            ) : null}
            {check.asset === null ? (
              <Notice tone="warn">
                esse release não tem pacote .zip anexado — quem publica precisa gerar o bundle
              </Notice>
            ) : (
              <button type="button" disabled={staging} onClick={() => void stageNow()}>
                {staging ? 'baixando…' : 'Baixar pacote'}
              </button>
            )}
          </div>
        ) : null}
        {check !== null && check.ok === false ? (
          <Notice tone="err">{check.error} — {check.hint ?? 'detalhes no log do backend'}</Notice>
        ) : null}
      </Card>

      <Card title="Instalação">
        <p className="image-note">
          A troca é de código só (backend/dist e frontend/dist) com backup anterior — conversas,
          mídia, config e sessão ficam em %APPDATA%\Geraldo intactos. Após aplicar, o Geraldo
          fecha; reabre com START.bat.
        </p>
        {staged === null && pendingVersion === null ? (
          <p className="pane-empty">Nenhum pacote baixado/preparado ainda.</p>
        ) : null}
        {staged !== null ? (
          <div className="updates-staged">
            <p className="image-prompt">
              <strong>{staged.fileName}</strong> — {formatBytes(staged.bytes)} ·{' '}
              {staged.version !== null ? `versão ${staged.version} · ` : ''}
              baixado em {shortDate(staged.stagedAt)}
            </p>
            <div className="image-badge-row">{verifiedBadge(staged)}</div>
            <div className="image-size-row">
              <button type="button" disabled={preparing} onClick={() => void prepareNow()}>
                {preparing ? 'preparando…' : 'Preparar instalação'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => void discardNow()}>
                Descartar pacote
              </button>
            </div>
          </div>
        ) : null}
        {pendingVersion !== null ? (
          <div className="updates-pending">
            <p className="image-prompt">
              Pacote preparado: <strong>versão {pendingVersion}</strong> — pronto pra aplicar.
            </p>
            {applyConfirm ? (
              <div className="updates-confirm">
                <Notice tone="warn">
                  Aplicar AGORA: em segundos o Geraldo fecha pra trocar o dist. Reabre com
                  START.bat depois. Confirmou contaí?
                </Notice>
                <div className="image-size-row">
                  <button type="button" onClick={() => void applyNow()}>
                    Sim, aplicar versão {pendingVersion}
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setApplyConfirm(false)}>
                    Melhor depois
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setApplyConfirm(true)}>
                Aplicar agora (reinicia o Geraldo)
              </button>
            )}
          </div>
        ) : null}
        {staged === null && check !== null && check.ok === false && pendingVersion === null ? (
          <p className="image-size-hint dim">Fluxo: verificar → baixar → preparar → aplicar.</p>
        ) : null}
      </Card>

      <Card title="De onde vem atualização">
        <form
          className="updates-config-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveConfig();
          }}
        >
          <div className="updates-config-row">
            <label className="field-label" htmlFor="upd-owner">owner:</label>
            <input
              id="upd-owner"
              value={owner}
              onChange={(event) => setOwner(event.target.value.replace(/[^A-Za-z0-9-]/g, ''))}
              placeholder="ex: lucasbr3"
              className="updates-owner-input"
              autoComplete="off"
              spellCheck={false}
            />
            <label className="field-label" htmlFor="upd-repo">repo:</label>
            <input
              id="upd-repo"
              value={repo}
              onChange={(event) => setRepo(event.target.value.replace(/[^A-Za-z0-9._-]/g, ''))}
              placeholder="ex: geraldo"
              className="updates-repo-input"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="updates-config-row">
            <label className="field-label" htmlFor="upd-channel">canal:</label>
            <select
              id="upd-channel"
              value={channel}
              onChange={(event) => setChannel(event.target.value as UpdatesChannelName)}
            >
              {CHANNEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <label className="field-label" htmlFor="upd-interval">a cada (h):</label>
            <input
              id="upd-interval"
              type="number"
              min={1}
              max={168}
              value={intervalHours}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                setIntervalHours(Number.isNaN(parsed) ? 6 : Math.min(Math.max(parsed, 1), 168));
              }}
              className="updates-interval-input"
            />
            <label className="field-label">
              <input
                type="checkbox"
                checked={autoCheck}
                onChange={(event) => setAutoCheck(event.target.checked)}
              />
              verificar sozinho
            </label>
          </div>
          <button type="submit">Salvar configuração</button>
          <p className="image-size-hint dim">
            Busca releases PUBLICADOS do repo público (sem login, API aberta do GitHub). Drafts
            e rascunhos ficam fora de sempre — `development` hoje confere no teste do painel,
            mas o GitHub não expõe rascunho, e ninguém promete o que não existe.
          </p>
        </form>
      </Card>
    </div>
  );
}
