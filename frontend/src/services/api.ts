const TOKEN_KEY = 'geraldo_token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* modo privado — sessão vive só no tab */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* mesmo tratamento */
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

export async function api<T = Record<string, unknown>>(path: string, init: ApiInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(token !== null ? { authorization: `Bearer ${token}` } : undefined),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : undefined),
  });

  if (response.status === 401) {
    clearToken();
    window.location.href = '/login';
    throw new ApiError('Sessão expirada', 401);
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload['error'] === 'string' ? payload['error'] : `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}
