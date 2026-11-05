/**
 * Classificação pura do código de desconexão do Baileys (DisconnectReason).
 */
export type DisconnectAction = 'reconnect' | 'logout' | 'replaced';

export function classifyDisconnect(statusCode: number | undefined): DisconnectAction {
  if (statusCode === undefined) return 'reconnect';
  // DisconnectReason.loggedOut
  if (statusCode === 401) return 'logout';
  // DisconnectReason.connectionReplaced: outra sessão assumiu — não brigar.
  if (statusCode === 440) return 'replaced';
  return 'reconnect';
}

/** Backoff simples e limitado (2s..60s, cabe no i5-2400 sem timer louco). */
export function backoffDelayMs(attempt: number): number {
  const clamped = Math.max(0, Math.min(attempt, 5));
  return Math.min(2000 * 2 ** clamped, 60000);
}
