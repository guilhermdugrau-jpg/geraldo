import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../services/authContext.tsx';
import { ApiError } from '../services/api.ts';
import { Notice } from '../components/ui.tsx';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(password);
      navigate('/', { replace: true });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Falha de conexão com o backend';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-logo" aria-hidden="true">G</div>
        <h1>Geraldo AI</h1>
        <p className="dim center">
          Oxente! Informe a senha do painel pra bora mexer no projeto.
        </p>

        {error !== null && <Notice tone="err">{error}</Notice>}

        <label className="field">
          <span className="field-label">Senha do painel</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>

        <button type="submit" className="btn btn-primary btn-block" disabled={busy || password === ''}>
          {busy ? 'Entrando...' : 'Entrar'}
        </button>

        <p className="dim login-hint">
          Primeiro acesso: senha provisória <code>geraldo123</code> — troque em Configurações
          (voltará como aviso em log ao iniciar).
        </p>
      </form>
    </div>
  );
}
