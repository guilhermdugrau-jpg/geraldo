import { getToken } from './api.ts';
import { ApiError } from './api.ts';

/**
 * Baixa um arquivo do catálogo (`/media/files/:id/file`) como blob com
 * Bearer e devolve URL local pra <audio>/<video>/download — ETAPA 4/5/6.
 */
export async function fetchFileBlobUrl(id: string): Promise<string> {
  const token = getToken();
  const response = await fetch(`/api/media/files/${id}/file`, {
    headers: token !== null ? { authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) throw new ApiError(`HTTP ${String(response.status)}`, response.status);
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

/** Toca um arquivo do catálogo direto no navegador (sem baixar pra disco). */
export async function playCatalogFile(id: string, volume = 0.9): Promise<void> {
  const url = await fetchFileBlobUrl(id);
  const audio = new Audio(url);
  audio.volume = volume;
  audio.onended = () => URL.revokeObjectURL(url);
  void audio.play();
}
