import { Navigate, Route, Routes, useOutletContext } from 'react-router-dom';
import { AuthProvider, useAuth } from './services/authContext.tsx';
import { Layout, type LayoutOutlet } from './components/Layout.tsx';
import { Login } from './pages/Login.tsx';
import { Overview } from './pages/Overview.tsx';
import { Logs } from './pages/Logs.tsx';
import { Settings } from './pages/Settings.tsx';
import { WhatsAppPage } from './pages/WhatsApp.tsx';
import { Conversas } from './pages/Conversas.tsx';
import { Downloads } from './pages/Downloads.tsx';
import { Memes } from './pages/Memes.tsx';
import { Voz } from './pages/Voz.tsx';
import { Imagens } from './pages/Imagens.tsx';
import { Atualizacoes } from './pages/Atualizacoes.tsx';

function RequireAuth({ children }: { children: React.ReactNode }): JSX.Element {
  const { logged } = useAuth();
  if (!logged) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function WhatsAppPageWrapper(): JSX.Element {
  const { socket } = useOutletContext<LayoutOutlet>();
  return <WhatsAppPage socket={socket} />;
}

export function App(): JSX.Element {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Overview />} />
          <Route path="whatsapp" element={<WhatsAppPageWrapper />} />
          <Route path="conversas" element={<Conversas />} />
          <Route path="logs" element={<Logs />} />
          <Route path="midias" element={<Downloads />} />
          <Route path="memes" element={<Memes />} />
          <Route path="voz" element={<Voz />} />
          <Route path="imagens" element={<Imagens />} />
          <Route path="atualizacoes" element={<Atualizacoes />} />
          <Route path="config" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
