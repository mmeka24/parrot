import type { ReactNode } from 'react';
import type { MoneyDto } from '@parrot/shared';

/**
 * Small shared primitives. Everything money-shaped renders `display` verbatim:
 * `micros` is never parsed into a Number anywhere in this app.
 */

export function Panel({
  title,
  subtitle,
  action,
  flush,
  children,
  id,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className={flush ? 'panel panel-flush' : 'panel'} id={id}>
      {title ? (
        <div className="panel-head" style={flush ? { padding: '1.25rem 1.25rem 0' } : undefined}>
          <div>
            <h2 className="panel-title">{title}</h2>
            {subtitle ? <p className="panel-sub">{subtitle}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'up' | 'down';
  hint?: string;
}) {
  return (
    <div
      style={{
        background: 'var(--paper-sunk)',
        border: '1px solid var(--rule)',
        borderRadius: 'var(--radius)',
        padding: '0.85rem 0.95rem',
      }}
    >
      <div className="eyebrow">{label}</div>
      <div
        className={'num ' + (tone === 'up' ? 'money-up' : tone === 'down' ? 'money-down' : '')}
        style={{ fontSize: '1.45rem', fontWeight: 650, letterSpacing: '-0.02em', marginTop: '0.2rem' }}
      >
        {value}
      </div>
      {hint ? (
        <div style={{ fontSize: '0.75rem', color: 'var(--ink-faint)', marginTop: '0.15rem' }}>{hint}</div>
      ) : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: '0.75rem',
        gridTemplateColumns: 'repeat(auto-fit, minmax(9.5rem, 1fr))',
      }}
    >
      {children}
    </div>
  );
}

export function Money({ amount, tone }: { amount: MoneyDto; tone?: 'auto' | 'none' }) {
  const negative = amount.display.includes('-');
  const cls = tone === 'none' ? 'num' : negative ? 'num money-down' : 'num';
  return <span className={cls}>{amount.display}</span>;
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '2.5rem 1.25rem',
        color: 'var(--ink-soft)',
        display: 'grid',
        gap: '0.5rem',
        justifyItems: 'center',
      }}
    >
      <div
        aria-hidden
        style={{
          width: 44,
          height: 44,
          borderRadius: 999,
          background: 'var(--mango-wash)',
          border: '1px solid color-mix(in srgb, var(--mango) 35%, transparent)',
        }}
      />
      <h3 style={{ fontSize: '1.05rem', color: 'var(--ink)' }}>{title}</h3>
      <p style={{ maxWidth: '28rem', fontSize: '0.92rem' }}>{body}</p>
      {action}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden />;
}

export function SkeletonPanel({ rows = 4 }: { rows?: number }) {
  return (
    <section className="panel stack" aria-busy="true">
      <Skeleton height={22} width="40%" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} height={46} />
      ))}
    </section>
  );
}

/** Relative-ish time that is stable between server and client renders. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
