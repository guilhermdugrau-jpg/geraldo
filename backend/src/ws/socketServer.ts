import { Server, type Socket } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import type { AppContext } from '../types.ts';
import type { LogEntry } from '../logger/logger.ts';

const STATUS_INTERVAL_MS = 5000;

export interface SocketLayer {
  io: Server;
  shutdown(): void;
}

/**
 * Socket.IO autenticado: exige o mesmo token do dashboard no handshake.
 * Eventos enviados ao painel:
 *   logs (buffer inicial), log (entrada nova), status (5s), settings.
 */
export function attachSocketServer(httpServer: HttpServer, ctx: AppContext): SocketLayer {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin: string | undefined, callback: (err: Error | null, ok: boolean) => void) => {
        if (!origin) {
          callback(null, true);
          return;
        }
        const sameHost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
        callback(null, sameHost);
      },
      credentials: false,
    },
  });

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = typeof token === 'string' ? ctx.authService.verifyToken(token) : null;
    if (payload === null) {
      next(new Error('unauthorized'));
      return;
    }
    void payload;
    next();
  });

  io.on('connection', (socket) => {
    ctx.log.info(`painel conectado: ${socket.id}`);
    socket.emit('logs', ctx.logger.recent({ limit: 300 }));
    socket.emit('status', ctx.status.snapshot());
    socket.emit('settings', ctx.settings.getPublic());

    socket.on('disconnect', (reason) => {
      ctx.log.info(`painel desconectou: ${socket.id} (${reason})`);
    });
  });

  const unsubscribe = ctx.logger.onEntry((entry: LogEntry) => {
    io.emit('log', entry);
  });

  const statusTimer = setInterval(() => {
    io.emit('status', ctx.status.snapshot());
  }, STATUS_INTERVAL_MS);

  return {
    io,
    shutdown: (): void => {
      unsubscribe();
      clearInterval(statusTimer);
      io.close();
    },
  };
}
