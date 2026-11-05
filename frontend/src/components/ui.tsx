import type { ReactNode } from 'react';
import type { LogLevel } from '../types.ts';

export function Card({ title, right, children, className = '' }: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title !== undefined || right !== undefined) && (
        <header className="card-head">
          <h3>{title}</h3>
          {right}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'ok' | 'err' | 'warn' | 'neutral' | 'accent'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Spinner({ label = 'Carregando...' }: { label?: string }) {
  return (
    <div className="spinner-row" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="dim">{label}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">∅</div>
      <h3>{title}</h3>
      {children && <p className="dim">{children}</p>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="field-hint dim">{hint}</span>}
    </label>
  );
}

export function Notice({ tone = 'ok', children }: { tone?: 'ok' | 'err' | 'warn'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${minutes}min`;
}

export function timeLabel(iso: string): string {
  return iso.slice(11, 19);
}

export function levelTone(level: LogLevel): 'ok' | 'warn' | 'err' | 'neutral' {
  switch (level) {
    case 'error':
      return 'err';
    case 'warn':
      return 'warn';
    case 'info':
      return 'ok';
    default:
      return 'neutral';
  }
}
