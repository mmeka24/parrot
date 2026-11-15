'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedStatusDto, ServerEventDto, TickerEntryDto } from '@parrot/shared';
import { copy } from '@parrot/shared';
import { streamUrl } from '@/lib/api';
import { localCopy } from '@/lib/local-copy';
import { EmptyState, formatWhen } from './ui';

const STALE_AFTER_MS = 20_000;

const KIND_LABEL: Record<TickerEntryDto['kind'], string> = {
  unlock: 'Unlock',
  settlement: 'Payout',
  decision: 'Decision',
  qc: 'Checks',
  dub: 'Dubbing',
};

const KIND_CLASS: Record<TickerEntryDto['kind'], string> = {
  unlock: 'chip chip-teal',
  settlement: 'chip chip-accent',
  decision: 'chip',
  qc: 'chip chip-berry',
  dub: 'chip',
};

export function LiveTicker({
  seed,
  feed,
}: {
  seed: readonly TickerEntryDto[];
  feed: FeedStatusDto;
}) {
  const [entries, setEntries] = useState<readonly TickerEntryDto[]>(seed);
  const [status, setStatus] = useState<FeedStatusDto>(feed);
  const [lastAt, setLastAt] = useState<number>(() => Date.now());
  const [stale, setStale] = useState(false);
  const counter = useRef(0);

  const url = useMemo(() => streamUrl(), []);

  // Live path: the real event stream.
  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    source.onmessage = (ev: MessageEvent<string>) => {
      try {
        const event = JSON.parse(ev.data) as ServerEventDto;
        setLastAt(Date.now());
        if (event.type === 'ticker') {
          setEntries((prev) => [event.entry, ...prev].slice(0, 40));
        } else if (event.type === 'feed') {
          setStatus(event.status);
        } else if (event.type === 'agents') {
          setStatus(event.dashboard.feed);
        }
      } catch {
        /* a malformed frame must never break the page */
      }
    };
    source.onerror = () => setStale(true);
    return () => source.close();
  }, [url]);

  // Offline path: replay the fixture entries so the demo still breathes.
  useEffect(() => {
    if (url || seed.length === 0) return;
    const timer = setInterval(() => {
      counter.current += 1;
      const base = seed[counter.current % seed.length]!;
      setEntries((prev) =>
        [{ ...base, id: base.id + '_r' + counter.current, at: new Date().toISOString() }, ...prev].slice(0, 40),
      );
      setLastAt(Date.now());
    }, 4200);
    return () => clearInterval(timer);
  }, [url, seed]);

  useEffect(() => {
    const timer = setInterval(() => setStale(Date.now() - lastAt > STALE_AFTER_MS), 3000);
    return () => clearInterval(timer);
  }, [lastAt]);

  const live = !stale && status.live;
  const label = url ? (live ? localCopy.dashboard.liveLabel : localCopy.dashboard.staleLabel) : localCopy.dashboard.pausedLabel;

  return (
    <section className="panel panel-flush">
      <div className="panel-head" style={{ padding: '1.25rem 1.25rem 0.75rem', marginBottom: 0 }}>
        <div>
          <h2 className="panel-title">{localCopy.dashboard.tickerTitle}</h2>
          <p className="panel-sub">{copy.demo.simulatedNote}</p>
        </div>
        <span
          className="chip"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}
          aria-live="polite"
        >
          <span className="pulse-dot" data-live={live ? 'true' : 'false'} aria-hidden />
          {label}
        </span>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          title={localCopy.dashboard.emptyTickerTitle}
          body={localCopy.dashboard.emptyTickerBody}
        />
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            maxHeight: '22rem',
            overflowY: 'auto',
            borderTop: '1px solid var(--rule)',
          }}
        >
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="fade-in"
              style={{
                display: 'flex',
                gap: '0.75rem',
                alignItems: 'center',
                padding: '0.75rem 1.25rem',
                borderBottom: '1px solid var(--rule)',
              }}
            >
              <span className={KIND_CLASS[entry.kind]}>{KIND_LABEL[entry.kind]}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: '0.9rem' }}>
                {entry.text}
                <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--ink-faint)' }}>
                  {formatWhen(entry.at)}
                  {entry.verifyUrl ? (
                    <>
                      {' · '}
                      <a
                        href={entry.verifyUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ color: 'var(--sky)', textDecoration: 'underline' }}
                      >
                        {copy.receipt.verifyLink}
                      </a>
                    </>
                  ) : null}
                </span>
              </span>
              {entry.amount ? (
                <span
                  className={'num ' + (entry.amount.display.includes('-') ? 'money-down' : 'money-up')}
                  style={{ whiteSpace: 'nowrap', fontWeight: 650 }}
                >
                  {entry.amount.display}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
