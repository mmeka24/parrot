'use client';

import Link from 'next/link';
import { useState } from 'react';
import { copy } from '@parrot/shared';
import type { CreatorDashboardDto, DubDto, LanguageRowDto, PostDto, ShareDto } from '@parrot/shared';
import { EmptyState, Panel, formatCount } from '@/components/ui';
import type { Actions } from './CreatorDashboard';

type Data = CreatorDashboardDto;

const negative = (display: string): boolean => display.trim().startsWith('-');
const zero = (micros: string): boolean => micros === '0';

function Net({ display, micros }: { display: string; micros: string }) {
  if (zero(micros)) return <span className="num">{display}</span>;
  return <span className={negative(display) ? 'num money-down' : 'num money-up'}>{negative(display) ? display : `+${display}`}</span>;
}

function Bar({ percent, tone = 'mango' }: { percent: number; tone?: 'mango' | 'teal' | 'muted' }) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div className={tone === 'mango' ? 'bar' : `bar bar-${tone}`} aria-hidden>
      <span style={{ width: `${width}%` }} />
    </div>
  );
}

const STATUS_CHIP: Record<LanguageRowDto['status'], string> = {
  winner: 'chip chip-teal',
  testing: 'chip chip-accent',
  untested: 'chip',
  dropped: 'chip chip-berry',
};

// ---------------------------------------------------------------------------
// The headline numbers
// ---------------------------------------------------------------------------

export function Totals({ data }: { data: Data }) {
  const { totals, settings } = data;
  return (
    <section aria-label="Totals" className="kpi-grid">
      <div className="kpi">
        <div className="eyebrow">New viewers</div>
        <div className="kpi-value">{formatCount(totals.views)}</div>
        <div className="kpi-hint">
          from {totals.dubsLive} {totals.dubsLive === 1 ? 'dub' : 'dubs'} in {totals.languagesTried}{' '}
          {totals.languagesTried === 1 ? 'language' : 'languages'}
        </div>
      </div>
      <div className="kpi">
        <div className="eyebrow">Worth to you</div>
        <div className="kpi-value">{totals.value.display}</div>
        <div className="kpi-hint">
          at your rate of {settings.valuePerThousand.display} per 1,000 views
          {settings.valueIsDefault ? ' (an example rate: set your own below)' : ''}
        </div>
      </div>
      <div className="kpi">
        <div className="eyebrow">You paid</div>
        <div className="kpi-value">{totals.paid.display}</div>
        <div className="kpi-hint">
          {settings.pricePerThousand.display} per 1,000 views. Parrot paid {totals.dubCostCovered.display} to make the dubs.
        </div>
      </div>
      <div className="kpi">
        <div className="eyebrow">Net for you</div>
        <div className="kpi-value">
          <Net display={totals.net.display} micros={totals.net.micros} />
        </div>
        <div className="kpi-hint">what the views are worth, less what you paid</div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The plan for the next post
// ---------------------------------------------------------------------------

export function PlanCard({ data, actions, timelineUrl }: { data: Data; actions: Actions; timelineUrl: string }) {
  const plan = data.nextPlan;
  return (
    <section className="panel plan-card stack" style={{ ['--stack' as string]: '1rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <span className="eyebrow">Your next post</span>
        <span className={plan.mode === 'explore' ? 'chip chip-accent' : 'chip chip-teal'}>{plan.modeLabel}</span>
        <span className="note">
          {plan.basedOnPosts === 0
            ? 'Nothing measured yet'
            : `Based on ${plan.basedOnPosts} measured ${plan.basedOnPosts === 1 ? 'post' : 'posts'}`}
        </span>
      </div>

      <h2 style={{ fontSize: 'clamp(1.25rem, 3.6vw, 1.6rem)', lineHeight: 1.25 }}>{plan.summary}</h2>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        {plan.entries.map((entry) => (
          <span className="lang-pill" key={entry.code}>
            <span className="flag" aria-hidden>
              {entry.flag}
            </span>
            {entry.name}
            <small>{entry.roleLabel}</small>
          </span>
        ))}
      </div>

      <details>
        <summary style={{ cursor: 'pointer', fontWeight: 650, fontSize: '0.9rem' }}>Why these languages</summary>
        <ul className="reasons" style={{ marginTop: '0.75rem' }}>
          {plan.entries.map((entry) => (
            <li key={entry.code}>
              <strong>{entry.name}.</strong> {entry.reason}
            </li>
          ))}
        </ul>
      </details>

      {data.undubbed.length > 0 ? (
        <div className="stack" style={{ ['--stack' as string]: '0.6rem' }}>
          <div className="eyebrow">Ready to dub</div>
          {data.undubbed.map((post) => {
            const key = `dub:${post.postId}`;
            return (
              <div
                key={post.postId}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'var(--paper-raised)',
                  border: '1px solid var(--rule)',
                  borderRadius: 'var(--radius)',
                  padding: '0.8rem 1rem',
                }}
              >
                <div style={{ minWidth: 0, flex: '1 1 16rem' }}>
                  <div style={{ fontWeight: 650 }}>{post.text}</div>
                  <div className="note">
                    {Math.round(post.durationS)}s video
                    {post.views !== null ? ` · ${formatCount(post.views)} views on the original` : ''} ·{' '}
                    <a href={post.postUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                      open post
                    </a>
                  </div>
                </div>
                {data.canEdit ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={actions.busy !== null}
                    onClick={() => actions.dub(post.postId)}
                  >
                    {actions.busy === key ? (
                      <>
                        <span className="spin" aria-hidden /> Starting
                      </>
                    ) : (
                      `Dub into ${plan.entries.length} ${plan.entries.length === 1 ? 'language' : 'languages'}`
                    )}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="note">
          Post a video on{' '}
          <a href={`${timelineUrl}/${data.handle}`} target="_blank" rel="noreferrer">
            the timeline
          </a>{' '}
          and reply <strong>{copy.bot.mention} dub this</strong> under it
          {data.settings.autoDub ? ', or just post: auto-dub is on.' : ', or turn on auto-dub below.'}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

export function LanguagesPanel({ data }: { data: Data }) {
  const rows = data.languages;
  const tried = rows.filter((r) => r.tries > 0);
  const most = Math.max(1, ...rows.map((r) => r.views));
  return (
    <Panel
      title="Your languages"
      subtitle="A language is proven once its dubs get enough views to pay for themselves, and dropped once they keep falling short."
      flush
    >
      {tried.length === 0 ? (
        <EmptyState
          title="Nothing dubbed yet"
          body="Your first post is dubbed into several languages at once. After that, this fills in with which ones your audience actually watches."
        />
      ) : (
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Language</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Dubs</th>
                <th style={{ minWidth: '9rem' }}>Views</th>
                <th style={{ textAlign: 'right' }}>Worth</th>
                <th style={{ textAlign: 'right' }}>Paid</th>
                <th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.code}>
                  <td>
                    <div style={{ fontWeight: 650 }}>
                      <span className="flag" aria-hidden>
                        {row.flag}
                      </span>{' '}
                      {row.name}
                    </div>
                    <div className="row-sub">{row.reason}</div>
                  </td>
                  <td>
                    <span className={STATUS_CHIP[row.status]}>{row.statusLabel}</span>
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {row.tries}
                  </td>
                  <td>
                    <div className="num" style={{ marginBottom: '0.3rem' }}>
                      {row.tries > 0 ? formatCount(row.views) : '-'}
                    </div>
                    <Bar percent={(row.views / most) * 100} tone={row.status === 'winner' ? 'teal' : row.status === 'dropped' ? 'muted' : 'mango'} />
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {row.tries > 0 ? row.value.display : '-'}
                  </td>
                  <td className="num" style={{ textAlign: 'right' }}>
                    {row.tries > 0 ? row.paid.display : '-'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {row.tries > 0 ? <Net display={row.net.display} micros={row.net.micros} /> : <span className="num">-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Posts and their dubs
// ---------------------------------------------------------------------------

const STATE_CHIP: Record<DubDto['state'], string> = {
  QUEUED: 'chip',
  DUBBING: 'chip chip-accent',
  QC: 'chip chip-accent',
  PUBLISHED: 'chip chip-teal',
  REJECTED_BY_QC: 'chip chip-berry',
  FAILED: 'chip chip-berry',
};

function DubRow({ dub }: { dub: DubDto }) {
  const live = dub.state === 'PUBLISHED';
  const working = dub.state === 'QUEUED' || dub.state === 'DUBBING' || dub.state === 'QC';
  return (
    <tr>
      <td>
        <div style={{ fontWeight: 650 }}>
          <span className="flag" aria-hidden>
            {dub.flag}
          </span>{' '}
          {dub.name} <span className="note">· {dub.roleLabel}</span>
        </div>
        {dub.problem ? <div className="row-sub">{dub.problem} Parrot covers the {dub.dubCost.display} it cost.</div> : null}
        {live ? (
          <div className="inline-links" style={{ marginTop: '0.25rem' }}>
            {dub.watchPath ? <Link href={dub.watchPath}>Watch</Link> : null}
            {dub.threadUrl ? (
              <a href={dub.threadUrl} target="_blank" rel="noreferrer">
                In the thread
              </a>
            ) : null}
            {dub.simulatedDub ? <span className="note">Stand-in audio</span> : null}
          </div>
        ) : null}
      </td>
      <td>
        <span className={STATE_CHIP[dub.state]}>
          {working ? <span className="spin" aria-hidden /> : null}
          {dub.statusLabel}
        </span>
      </td>
      <td style={{ minWidth: '11rem' }}>
        {live ? (
          <>
            <div className="num" style={{ marginBottom: '0.3rem' }}>
              {formatCount(dub.views)}{' '}
              <span className="note">
                {dub.paidForItself ? 'paid for itself' : `of ${formatCount(dub.breakEvenViews)} to pay for itself`}
              </span>
            </div>
            <Bar percent={dub.breakEvenPercent} tone={dub.paidForItself ? 'teal' : 'mango'} />
          </>
        ) : (
          <span className="num">-</span>
        )}
      </td>
      <td className="num" style={{ textAlign: 'right' }}>
        {live ? dub.value.display : '-'}
      </td>
      <td className="num" style={{ textAlign: 'right' }}>
        {live ? dub.paid.display : '-'}
      </td>
    </tr>
  );
}

function PostCard({ post, data, actions }: { post: PostDto; data: Data; actions: Actions }) {
  const audienceKey = `audience:${post.id}`;
  const waiting = post.dubs.some((d) => d.state === 'PUBLISHED' && d.simulatedViews === 0);
  const canSend = data.demo && data.canEdit && waiting && post.demoAudience !== 'arriving' && !post.working;
  const failedQc = post.dubs.filter((d) => d.qc && !d.qc.passed);

  return (
    <article className="post-card">
      <div className="post-head">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
          <span className={post.mode === 'explore' ? 'chip chip-accent' : 'chip chip-teal'}>{post.modeLabel}</span>
          {post.working ? (
            <span className="chip chip-accent">
              <span className="spin" aria-hidden /> Working
            </span>
          ) : post.demoAudience === 'arriving' ? (
            <span className="chip chip-accent">
              <span className="spin" aria-hidden /> {copy.demo.audienceRunning}
            </span>
          ) : post.measured ? (
            <span className="chip">Counted in your plan</span>
          ) : (
            <span className="chip">Still being watched</span>
          )}
          {post.demoAudience !== 'none' ? <span className="chip">{copy.demo.simulatedBadge} audience</span> : null}
        </div>
        <div className="post-text">{post.text}</div>
        <div className="note">
          {post.summary}{' '}
          <a href={post.postUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
            Open the thread
          </a>
        </div>
      </div>

      <div className="table-scroll">
        <table className="data" style={{ minWidth: '38rem' }}>
          <thead>
            <tr>
              <th>Dub</th>
              <th>Status</th>
              <th>Views</th>
              <th style={{ textAlign: 'right' }}>Worth</th>
              <th style={{ textAlign: 'right' }}>Paid</th>
            </tr>
          </thead>
          <tbody>
            {post.dubs.map((dub) => (
              <DubRow key={dub.id} dub={dub} />
            ))}
          </tbody>
        </table>
      </div>

      {failedQc.length > 0 ? (
        <details style={{ padding: '0.6rem 1.1rem', borderTop: '1px solid var(--rule)', fontSize: '0.88rem' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 650 }}>Quality check details</summary>
          {failedQc.map((dub) => (
            <ul key={dub.id} className="reasons" style={{ marginTop: '0.6rem' }}>
              {dub.qc?.checks.map((check) => (
                <li key={check.name}>
                  <strong>
                    {dub.name}: {check.label} - {check.statusLabel}.
                  </strong>{' '}
                  {check.detail}
                </li>
              ))}
            </ul>
          ))}
        </details>
      ) : null}

      <div className="post-foot">
        <div style={{ flex: '1 1 16rem', display: 'grid', gap: '0.35rem' }}>
          <div>
            <strong className="num" style={{ color: 'var(--ink)' }}>
              {formatCount(post.views)}
            </strong>{' '}
            new views · paid <strong className="num" style={{ color: 'var(--ink)' }}>{post.paid.display}</strong> of your{' '}
            {post.budget.display} budget · worth <strong className="num" style={{ color: 'var(--ink)' }}>{post.value.display}</strong>
          </div>
          <Bar percent={post.budgetPercent} tone={post.budgetReached ? 'muted' : 'mango'} />
          {post.budgetReached ? <div className="note">{copy.warnings.budgetReached}</div> : null}
        </div>
        {canSend ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={actions.busy !== null}
            onClick={() => actions.audience(post.id)}
            title={copy.demo.audienceNote}
          >
            {actions.busy === audienceKey ? <span className="spin" aria-hidden /> : null}
            {copy.demo.audienceCta}
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function PostsPanel({ data, actions }: { data: Data; actions: Actions }) {
  return (
    <Panel
      title="Dubbed posts"
      subtitle={data.demo ? copy.demo.audienceNote : 'Each post, the languages it was dubbed into, and what each dub brought in.'}
    >
      {data.posts.length === 0 ? (
        <EmptyState title="No dubbed posts yet" body="Dub a post above and it shows up here, one row per language." />
      ) : (
        <div className="stack" style={{ ['--stack' as string]: '1rem' }}>
          {data.posts.map((post) => (
            <PostCard key={post.id} post={post} data={data} actions={actions} />
          ))}
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Audience
// ---------------------------------------------------------------------------

function ShareList({ items, empty }: { items: readonly ShareDto[]; empty: string }) {
  if (items.length === 0) return <p className="note">{empty}</p>;
  return (
    <ul className="share-list">
      {items.map((item) => (
        <li className="share-row" key={item.code}>
          <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
          <Bar percent={item.percent} tone="teal" />
          <span className="num" style={{ textAlign: 'right' }}>
            {item.percent}%
          </span>
        </li>
      ))}
    </ul>
  );
}

export function AudiencePanel({ data }: { data: Data }) {
  const { audience } = data;
  return (
    <Panel title="Who is watching" subtitle="A view count says how many, never who. These are the two places Parrot can actually see your audience.">
      <div className="stack" style={{ ['--stack' as string]: '1.25rem' }}>
        {audience.insight ? (
          <div className="callout" style={{ background: 'var(--teal-wash)', color: 'var(--ink)', borderColor: 'color-mix(in srgb, var(--teal) 35%, transparent)' }}>
            <div className="eyebrow" style={{ marginBottom: '0.3rem' }}>
              {audience.insightBy === 'Grok' ? 'Read by Grok' : 'In short'}
            </div>
            {audience.insight}
          </div>
        ) : null}
        <div className="split">
          <div className="stack" style={{ ['--stack' as string]: '0.75rem' }}>
            <div>
              <h3 style={{ fontSize: '1rem' }}>Where viewers were</h3>
              <p className="note">People who opened a dub on Parrot&apos;s own page.</p>
            </div>
            <ShareList items={audience.countries} empty="Nobody has opened a dub page yet." />
          </div>
          <div className="stack" style={{ ['--stack' as string]: '0.75rem' }}>
            <div>
              <h3 style={{ fontSize: '1rem' }}>What they replied in</h3>
              <p className="note">The language of the replies under each dub.</p>
            </div>
            <ShareList items={audience.replyLanguages} empty="No replies under your dubs yet." />
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export function PaymentsPanel({ data, actions }: { data: Data; actions: Actions }) {
  const owes = !zero(data.owed.micros);
  return (
    <Panel
      title="What you paid"
      subtitle={`${data.settings.pricePerThousand.display} for every 1,000 views your dubs get, charged in batches. Making the dubs is on Parrot.`}
      action={
        owes ? (
          <span style={{ display: 'inline-flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="note">
              Counted, not yet charged: <strong className="num">{data.owed.display}</strong>
            </span>
            {data.canEdit ? (
              <button type="button" className="btn btn-secondary btn-sm" disabled={actions.busy !== null} onClick={() => actions.pay()}>
                {actions.busy === 'pay' ? <span className="spin" aria-hidden /> : null}
                Pay now
              </button>
            ) : null}
          </span>
        ) : undefined
      }
      flush
    >
      {data.payments.length === 0 ? (
        <EmptyState title="No payments yet" body="You are charged only for views your dubs actually get. Until a dub is watched, there is nothing to pay." />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {data.payments.map((payment) => (
            <li
              key={payment.id}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.5rem 1rem',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.9rem 1.25rem',
                borderTop: '1px solid var(--rule)',
              }}
            >
              <div style={{ flex: '1 1 18rem', minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{payment.title}</div>
                <div className="note">{payment.detail}</div>
                <div className="note">
                  {when(payment.at)}
                  {payment.note ? ` · ${payment.note}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                {payment.verifyUrl ? (
                  <a href={payment.verifyUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--mango-deep)' }}>
                    {copy.payment.verifyLink}
                  </a>
                ) : null}
                <span className={payment.status === 'confirmed' ? 'chip chip-teal' : payment.status === 'failed' ? 'chip chip-berry' : 'chip chip-accent'}>
                  {payment.status === 'pending' ? <span className="spin" aria-hidden /> : null}
                  {payment.statusLabel}
                </span>
                <strong className="num" style={{ fontSize: '1.05rem', minWidth: '4.5rem', textAlign: 'right' }}>
                  {payment.amount.display}
                </strong>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** "$8.00" -> "8.00" for an input. Display strings only; never arithmetic. */
const bare = (display: string): string => display.replace(/[$,]/g, '');

export function SettingsPanel({ data, actions }: { data: Data; actions: Actions }) {
  const { settings } = data;
  const [value, setValue] = useState(bare(settings.valuePerThousand.display));
  const [budget, setBudget] = useState(bare(settings.postBudget.display));
  const [autoDub, setAutoDub] = useState(settings.autoDub);
  const [saved, setSaved] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaved(false);
    const ok = await actions.save({ valuePerThousandUsd: value.trim(), postBudgetUsd: budget.trim(), autoDub });
    setSaved(ok);
  }

  return (
    <Panel title="Your settings" id="settings">
      <form onSubmit={(e) => void submit(e)} className="stack" style={{ ['--stack' as string]: '1.1rem' }}>
        <div className="split">
          <label className="field">
            <span>What 1,000 views are worth to you</span>
            <div className="input-money">
              <input className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-describedby="value-help" />
            </div>
            <span id="value-help" className="note" style={{ fontWeight: 400 }}>
              Your own number: what you were paid divided by your views, or what a sponsor pays you per 1,000 views. It is only used
              to show you whether a dub was worth it.
            </span>
          </label>
          <label className="field">
            <span>The most one post can cost you</span>
            <div className="input-money">
              <input className="input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-describedby="budget-help" />
            </div>
            <span id="budget-help" className="note" style={{ fontWeight: 400 }}>
              Once a post&apos;s dubs have cost this much, they stay up and further views are free. Applies to posts dubbed from now on.
            </span>
          </label>
        </div>

        <label style={{ display: 'flex', gap: '0.7rem', alignItems: 'flex-start', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoDub} onChange={(e) => setAutoDub(e.target.checked)} style={{ width: 20, height: 20, marginTop: 2 }} />
          <span>
            <strong>Dub every new video automatically</strong>
            <span className="note" style={{ display: 'block' }}>
              Parrot dubs each video you post, into the languages in your plan, without being asked.
            </span>
          </span>
        </label>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="submit" className="btn btn-primary" disabled={actions.busy !== null}>
            {actions.busy === 'save' ? <span className="spin" aria-hidden /> : null}
            Save settings
          </button>
          {saved ? (
            <span className="note" role="status">
              Saved.
            </span>
          ) : null}
        </div>
      </form>
    </Panel>
  );
}
