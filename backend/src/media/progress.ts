/**
 * Parser de linhas de saída do yt-dlp (modo `--newline --progress`).
 * Puro e tolerante: linha impossível de ler vira `unknown` e não quebra o job.
 */
export type ParsedProgressKind = 'download' | 'convert' | 'info' | 'error' | 'unknown';

export interface ParsedProgress {
  kind: ParsedProgressKind;
  progress: number | null;
  /** Texto da linha truncado — vai direto pro `detail` do job. */
  text: string;
}

const DOWNLOAD_RE = /\[download\]\s+([\d.]+)%/;
const CONVERT_PATTERNS: readonly RegExp[] = [
  /\[ExtractAudio\]/,
  /\[VideoRemuxer\]/,
  /\[VideoConvertor\]/,
  /\[Merger\]/,
  /\[Extractor\]/,
];

export function parseYtDlpLine(rawLine: string): ParsedProgress {
  const line = rawLine.replace(/\r/g, '').trim();
  const text = line.slice(0, 120);
  if (/^ERROR:\s/i.test(line)) {
    return { kind: 'error', progress: null, text };
  }
  const download = DOWNLOAD_RE.exec(line);
  if (download && download[1] !== undefined) {
    const percent = Number.parseFloat(download[1]);
    if (Number.isFinite(percent)) {
      return { kind: 'download', progress: Math.min(Math.max(percent / 100, 0), 1), text };
    }
  }
  for (const pattern of CONVERT_PATTERNS) {
    if (pattern.test(line)) {
      return { kind: 'convert', progress: null, text };
    }
  }
  if (line.startsWith('[') || line !== '') {
    return { kind: 'info', progress: null, text };
  }
  return { kind: 'unknown', progress: null, text: '' };
}

/** Mapeamento de extensão típica → mime honesto p/ catálogo. */
export function mimeForExtension(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'mp3':
      return 'audio/mpeg';
    case 'm4a':
      return 'audio/mp4';
    case 'opus':
      return 'audio/ogg';
    case 'ogg':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    default:
      return 'application/octet-stream';
  }
}
