import type { Server } from 'socket.io';

/**
 * Ponte mínima entre módulos do backend e o painel autenticado.
 * Eventos usados hoje:
 *   whatsapp:status (WhatsAppInfo), whatsapp:qr ({dataUrl,updatedAt}),
 *   conversation:update ({jid})
 */
export interface PanelBridge {
  emit(event: string, data: unknown): void;
}

export function createPanelBridge(io: Server): PanelBridge {
  return {
    emit(event: string, data: unknown): void {
      io.emit(event, data);
    },
  };
}
