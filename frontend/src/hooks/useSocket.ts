import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getToken, clearToken } from '../services/api.ts';

/** Socket autenticado; desconecta e manda pro login em 'unauthorized'. */
export function useAppSocket(): Socket | null {
  const [socket, setSocket] = useState<Socket | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const token = getToken();
    if (token === null) return undefined;

    const connection = io('/', {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionDelay: 2000,
      reconnectionDelayMax: 15000,
      reconnectionAttempts: 10,
    });
    socketRef.current = connection;
    setSocket(connection);

    connection.on('connect_error', (error: Error) => {
      if (
        error.message === 'unauthorized' ||
        (error as unknown as { data?: { message?: string } }).data?.message === 'unauthorized'
      ) {
        clearToken();
        window.location.href = '/login';
      }
    });

    return () => {
      connection.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, []);

  return socketRef.current ?? socket;
}

export function useSocketConnectionState(socket: Socket | null): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (socket === null) {
      setConnected(false);
      return undefined;
    }
    const onConnect = (): void => setConnected(true);
    const onDisconnect = (): void => setConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    setConnected(socket.connected);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, [socket]);
  return connected;
}
