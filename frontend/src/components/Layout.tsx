import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAppSocket, useSocketConnectionState } from '../hooks/useSocket.ts';
import { useAuth } from '../services/authContext.tsx';
import type { SystemSnapshot } from '../types.ts';

const NAV_ITEMS: Array<{ to: string; label: string; icon: string; etapa?: number }> = [
  { to: '/', label: 'Visão geral', icon: '◎', etapa: undefined },
  { to: '/whatsapp', label: 'WhatsApp', icon: '✆', etapa: undefined },
  { to: '/conversas', label: 'Conversas', icon: '❝', etapa: undefined },
  { to: '/memes', label: 'Memes', icon: '♫', etapa: undefined },
  { to: '/voz', label: 'Voz', icon: '🎙', etapa: undefined },
  { to: '/imagens', label: 'Imagens', icon: '🖼', etapa: undefined },
  { to: '/logs', label: 'Logs', icon: '≡', etapa: undefined },
  { to: '/midias', label: 'Downloads', icon: '♪', etapa: undefined },
  { to: '/atualizacoes', label: 'Atualizações', icon: '⟳', etapa: 9 },
  { to: '/config', label: 'Configurações', icon: '⚙', etapa: undefined },
];

export function Layout() {
  const socket = useAppSocket();
  const connected = useSocketConnectionState(socket);
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<SystemSnapshot | null>(null);

  useEffect(() => {
    if (socket === null) return undefined;
    const onStatus = (snapshot: SystemSnapshot): void => setStatus(snapshot);
    socket.on('status', onStatus);
    return () => {
      socket.off('status', onStatus);
    };
  }, [socket]);

  const backendName = status?.name ?? 'Geraldo';

  const onLogout = (): void => {
    if (socket !== null) socket.disconnect();
    logout();
    navigate('/login');
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">G</span>
          <div>
            <strong>Geraldo AI</strong>
            <span className="dim brand-sub">painel de controle</span>
          </div>
        </div>

        <nav className="nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              end={item.to === '/'}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              {item.label}
              {item.etapa !== undefined && <span className="nav-tag">E{item.etapa}</span>}
            </NavLink>
          ))}
        </nav>

        <footer className="sidebar-foot">
          <div className="pill-row">
            <span className={`dot ${connected ? 'ok' : 'err'}`} aria-hidden="true" />
            <span className="dim">{connected ? 'conectado ao backend' : 'sem conexão'}</span>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onLogout}>
            Sair
          </button>
          {status !== null && (
            <span className="dim version-label">v{status.version}</span>
          )}
        </footer>
      </aside>

      <main className="content">
        <Outlet context={{ socket, backendName }} />
      </main>
    </div>
  );
}

export type LayoutOutlet = { socket: ReturnType<typeof useAppSocket>; backendName: string };
