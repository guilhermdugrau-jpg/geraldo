import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

interface BlobMeta {
  meta?: string;
}

export interface LogEntry extends BlobMeta {
  id: number;
  ts: string;
  level: LogLevel;
  module: string;
  message: string;
}

export interface ChildLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type EntryListener = (entry: LogEntry) => void;

export interface RecentLogsOptions {
  level?: LogLevel | 'all';
  module?: string;
  search?: string;
  limit?: number;
}

const MAX_SHOW_META_LENGTH = 4 * 1024;

function stringifyMeta(meta: Record<string, unknown>): string | undefined {
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(meta, (_key, value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        const obj = value as object;
        if (seen.has(obj)) return '[Circular]';
        seen.add(obj);
      }
      return value as never;
    });
    if (text === undefined) return undefined;
    return text.length > MAX_SHOW_META_LENGTH ? `${text.slice(0, MAX_SHOW_META_LENGTH)}…` : text;
  } catch {
    return '[meta não serializável]';
  }
}

const COLOR_RESET = '\x1b[0m';
const COLOR_TIMESTAMP = '\x1b[90m';
const COLORS: Record<LogLevel, string | null> = {
  debug: '\x1b[90m', // cinza
  info: '\x1b[36m', // ciano
  warn: '\x1b[33m', // amarelo
  error: '\x1b[31m', // vermelho
};

const LEVEL_PAD: Record<LogLevel, string> = {
  debug: 'debug',
  info: 'info ',
  warn: 'warn ',
  error: 'error',
};

export class Logger {
  private readonly listeners = new Set<EntryListener>();
  private readonly entries: LogEntry[] = [];
  private fileStream: WriteStream | null = null;
  private levelWeight: number;
  private levelValue: LogLevel;
  private nextId = 1;

  constructor(
    private readonly options: {
      level: LogLevel;
      file: string | null;
      console: boolean;
    },
  ) {
    this.levelValue = options.level;
    this.levelWeight = LOG_LEVEL_WEIGHT[options.level];
    if (options.file) {
      try {
        mkdirSync(dirname(options.file), { recursive: true });
        this.fileStream = createWriteStream(options.file, { flags: 'a' });
        this.fileStream.on('error', () => {
          // Nunca deixa uma falha de disco derrubar o Geraldo.
          this.fileStream = null;
        });
      } catch {
        this.fileStream = null;
      }
    }
  }

  setLevel(level: LogLevel): void {
    this.levelValue = level;
    this.levelWeight = LOG_LEVEL_WEIGHT[level];
  }

  get level(): LogLevel {
    return this.levelValue;
  }

  withModule(module: string): ChildLogger {
    const write = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
      this.write(level, module, message, meta);
    };
    return {
      debug: (m, meta) => write('debug', m, meta),
      info: (m, meta) => write('info', m, meta),
      warn: (m, meta) => write('warn', m, meta),
      error: (m, meta) => write('error', m, meta),
    };
  }

  write(level: LogLevel, module: string, message: string, meta?: Record<string, unknown>): void {
    const weight = LOG_LEVEL_WEIGHT[level];
    if (weight < this.levelWeight) return;

    const entry: LogEntry = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      level,
      module,
      message,
    };
    const metaText = meta ? stringifyMeta(meta) : undefined;
    if (metaText !== undefined) entry['meta'] = metaText;

    this.entries.push(entry);
    if (this.entries.length > 1000) this.entries.shift();

    this.emitConsole(entry);
    this.emitFile(entry);
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        /* listener quebrado não derruba o Geraldo */
      }
    }
  }

  private emitConsole(entry: LogEntry): void {
    if (!this.options.console) return;
    const time = entry.ts.slice(11, 19);
    const useColor = Boolean(process.stdout?.isTTY);
    let line: string;
    if (useColor) {
      const color = COLORS[entry.level] ?? '';
      line = `${COLOR_TIMESTAMP}${time}${COLOR_RESET} ${color}${LEVEL_PAD[entry.level]}${COLOR_RESET} [${entry.module}] ${entry.message}`;
    } else {
      line = `${time} ${LEVEL_PAD[entry.level]} [${entry.module}] ${entry.message}`;
    }
    if (entry.meta) line += ` ${entry.meta}`;
    if (entry.level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  private emitFile(entry: LogEntry): void {
    if (!this.fileStream) return;
    try {
      this.fileStream.write(`${JSON.stringify(entry)}\n`);
    } catch {
      /* stream quebrado já é desativado no handler de erro */
    }
  }

  onEntry(listener: EntryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recent(options: RecentLogsOptions = {}): LogEntry[] {
    const limit = Math.min(Math.max(options.limit ?? 300, 1), 1000);
    const minWeight =
      options.level && options.level !== 'all'
        ? LOG_LEVEL_WEIGHT[options.level]
        : LOG_LEVEL_WEIGHT['debug'];
    const out: LogEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const entry = this.entries[i];
      if (!entry) break;
      if (LOG_LEVEL_WEIGHT[entry.level] < minWeight) continue;
      if (options.module && entry.module !== options.module) continue;
      if (options.search) {
        const search = options.search.toLowerCase();
        const haystack = `${entry.message} ${entry.module} ${entry.meta ?? ''}`.toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      out.push(entry);
    }
    return out;
  }

  close(): Promise<void> {
    const stream = this.fileStream;
    if (!stream) return Promise.resolve();
    this.fileStream = null;
    return new Promise<void>((resolvePromise) => {
      stream.once('error', () => resolvePromise());
      stream.end(() => resolvePromise());
    });
  }
}

/** Formato do arquivo: JSONL com um objeto LogEntry por linha. */
export function logFileName(logDir: string, date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return join(logDir, `app-${y}-${m}-${d}.log`);
}
