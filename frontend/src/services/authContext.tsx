import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken, clearToken } from './api.ts';

interface AuthContextValue {
  logged: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [logged, setLogged] = useState<boolean>(() => getToken() !== null);

  const login = useCallback(async (password: string) => {
    const result = await api<{ token: string; expiresAt: string }>('/auth/login', {
      method: 'POST',
      body: { password },
    });
    setToken(result.token);
    setLogged(true);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setLogged(false);
    window.location.href = '/login';
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ logged, login, logout }),
    [logged, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) throw new Error('useAuth precisa do AuthProvider');
  return context;
}
