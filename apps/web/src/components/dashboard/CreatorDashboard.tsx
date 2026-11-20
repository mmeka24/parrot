'use client';

/**
 * A creator's whole page: what their dubs brought in, what happens on the next
 * post, how each language is doing, and what they paid.
 *
 * It renders what the server sent and never works anything out for itself:
 * every amount is a pre-formatted string, every label comes with the data.
 * It stays current by listening to the event stream and re-reading the page's
 * data when told this creator changed, with a slow poll as the safety net.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreatorDashboardDto, ServerEventDto } from '@parrot/shared';
import { getCreator, payNow, sendDemoAudience, startDub, streamUrl, updateSettings, type Failure } from '@/lib/api';
import { AudiencePanel, LanguagesPanel, PaymentsPanel, PlanCard, PostsPanel, SettingsPanel, Totals } from './Sections';

export interface Actions {
  readonly busy: string | null;
  dub(postId: string): void;
  audience(postId: string): void;
  pay(): void;
  save(body: { valuePerThousandUsd?: string; postBudgetUsd?: string; autoDub?: boolean }): Promise<boolean>;
}

export function CreatorDashboard({ initial, timelineUrl }: { initial: CreatorDashboardDto; timelineUrl: string }) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Failure | null>(null);
  const handle = initial.handle;
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const fresh = await getCreator(handle);
    if (fresh) setData(fresh);
  }, [handle]);

  // Live: re-read when the server says this creator changed. Several events
  // often arrive together (six dubs finishing), so they are folded into one read.
  useEffect(() => {
    const url = streamUrl();
    if (!url || typeof EventSource === 'undefined') return;
    const source = new EventSource(url, { withCredentials: true });
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data as string) as ServerEventDto;
        if (event.type !== 'creator' || event.handle !== handle) return;
      } catch {
        return;
      }
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        void refresh();
      }, 350);
    };
    return () => {
      source.close();
      if (pending.current) clearTimeout(pending.current);
      pending.current = null;
    };
  }, [handle, refresh]);

  // The safety net: quick while something is visibly in progress, slow otherwise.
  const active = data.posts.some((p) => p.working || p.demoAudience === 'arriving');
  useEffect(() => {
    const timer = setInterval(() => void refresh(), active ? 2_000 : 15_000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  async function run(key: string, action: () => Promise<{ ok: true } | Failure>): Promise<boolean> {
    setBusy(key);
    setProblem(null);
    const result = await action();
    if (!result.ok) setProblem(result);
    await refresh();
    setBusy(null);
    return result.ok;
  }

  const actions: Actions = {
    busy,
    dub: (postId) => void run(`dub:${postId}`, () => startDub(handle, postId)),
    audience: (postId) => void run(`audience:${postId}`, () => sendDemoAudience(handle, postId)),
    pay: () => void run('pay', () => payNow(handle)),
    save: (body) => run('save', () => updateSettings(handle, body)),
  };

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.5rem', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <span className="eyebrow">@{data.handle}</span>
          <h1 style={{ fontSize: 'clamp(1.7rem, 5vw, 2.3rem)', marginTop: '0.15rem' }}>{data.displayName}</h1>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <span className="chip chip-teal" title={data.balanceKind === 'demo' ? 'A test balance. No real money.' : 'Your balance'}>
            {data.balance ? `Balance ${data.balance.display}` : 'Balance unavailable'}
          </span>
          {data.balanceKind === 'demo' ? <span className="chip">Demo balance</span> : null}
          <a className="btn btn-secondary btn-sm" href={`${timelineUrl}/${data.handle}`} target="_blank" rel="noreferrer">
            Open the timeline
          </a>
        </div>
      </header>

      {data.warnings.map((warning) => (
        <p key={warning} className="callout callout-bad" role="status">
          {warning}
        </p>
      ))}
      {problem ? (
        <p className="callout callout-bad" role="alert">
          <strong>{problem.title}.</strong> {problem.detail}
        </p>
      ) : null}

      <Totals data={data} />
      <PlanCard data={data} actions={actions} timelineUrl={timelineUrl} />
      <LanguagesPanel data={data} />
      <PostsPanel data={data} actions={actions} />
      <AudiencePanel data={data} />
      <PaymentsPanel data={data} actions={actions} />
      {data.canEdit ? <SettingsPanel data={data} actions={actions} /> : null}
    </div>
  );
}
