import { useEffect, useMemo, useState, useCallback } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { LayoutOutlet } from '../components/Layout.tsx';
import type { LogLevel, LogEntry } from '../types.ts';
import { Badge, Card, timeLabel, levelTone } from '../components/ui.tsx';

const LEVELS: Array<LogLevel | 'all'> = ['all', 'debug', 'info', 'warn', 'error'];

export function Logs() {
  const { socket } = useOutletContext<LayoutOutlet>();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogLevel | 'all'>('all');
  const [search, setSearch] = useState('');
  const [live, setLive] = useState(true);

  useEffect(() => {
    if (socket === null) return undefined;
    const onLogs = (incoming: LogEntry[]): void => setEntries(incoming);
    const onLog = (entry: LogEntry): void => {
      if (!live) return;
      setEntries((current) => [entry, ...current].slice(0, 1000));
    };
    socket.on('logs', onLogs);
    socket.on('log', onLog);
    return () => {
      socket.off('logs', onLogs);
      socket.off('log', onLog);
    };
  }, [socket, live]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false;
      if (term === '') return true;
      return `${entry.message} ${entry.module} ${entry.meta ?? ''}`.toLowerCase().includes(term);
    });
  }, [entries, level, search]);

  const exportJson = useCallback(() => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], {
      type: 'application/json',
    });
    download(blob, 'geraldo-logs.json');
  }, [filtered]);

  const exportText = useCallback(() => {
    const text = filtered
      .map((e) => `${e.ts} ${e.level.toUpperCase()} [${e.module}] ${e.message}${e.meta ? ` ${e.meta}` : ''}`)
      .join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    download(blob, 'geraldo-logs.txt');
  }, [filtered]);

  return (
    <Card
      title="Logs em tempo real"
      right={
        <div className="toolbar">
          <button
            type="button"
            className={`btn btn-chip${live ? ' active' : ''}`}
            onClick={() => {
              setLive((v) => !v);
            }}
          >
            {live ? '● ao vivo' : '○ pausado'}
          </button>
          <button type="button" className="btn btn-chip" onClick={exportJson}>
            exportar JSON
          </button>
          <button type="button" className="btn btn-chip" onClick={exportText}>
            exportar TXT
          </button>
        </div>
      }
    >
      <div className="toolbar logs-toolbar">
        {LEVELS.map((option) => (
          <button
            key={option}
            type="button"
            className={`btn btn-chip${level === option ? ' active' : ''}`}
            onClick={() => setLevel(option)}
          >
            {option}
          </button>
        ))}
        <input
          className="search-input"
          type="search"
          placeholder="buscar no log..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="dim count">{filtered.length} entradas</span>
      </div>

      <div className="log-table" role="log" aria-live={live ? 'polite' : 'off'}>
        {filtered.length === 0 && <p className="dim empty-row">Sem entradas para o filtro atual.</p>}
        {filtered.map((entry) => (
          <div className="log-row" key={entry.id}>
            <span className="dim mono log-ts">{timeLabel(entry.ts)}</span>
            <Badge tone={levelTone(entry.level)}>{entry.level}</Badge>
            <span className="mono log-module">{entry.module}</span>
            <span className="log-msg">
              {entry.message}
              {entry.meta !== undefined && <span className="dim mono log-meta"> {entry.meta}</span>}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}
