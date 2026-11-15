import type { Metadata } from 'next';
import Link from 'next/link';
import type { DecisionLogEntryDto } from '@parrot/shared';
import { copy } from '@parrot/shared';
import { getAgents } from '@/lib/api';
import { localCopy } from '@/lib/local-copy';
import { AccuracyChart } from '@/components/AccuracyChart';
import { LiveTicker } from '@/components/LiveTicker';
import { Panel, Stat, StatGrid, formatCount, formatWhen } from '@/components/ui';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: localCopy.dashboard.agentsTitle };

export default async function AgentsPage() {
  const { data } = await getAgents();
  const { totals, jobs, agents, decisions, accuracy, ticker, feed } = data;

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      <header className="stack" style={{ ['--stack' as string]: '0.5rem' }}>
        <span className="eyebrow">{copy.demo.badge}</span>
        <h1 style={{ fontSize: '2rem' }}>{localCopy.dashboard.agentsTitle}</h1>
        <p style={{ color: 'var(--ink-soft)', maxWidth: '44rem' }}>
          {localCopy.dashboard.agentsSubtitle}
        </p>
      </header>

      <StatGrid>
        <Stat label={localCopy.dashboard.balance} value={totals.balance.display} />
        <Stat label={localCopy.dashboard.spend} value={totals.spend.display} />
        <Stat label={localCopy.dashboard.revenue} value={totals.revenue.display} />
        <Stat
          label={localCopy.dashboard.profit}
          value={totals.profit.display}
          tone={totals.profit.display.includes('-') ? 'down' : 'up'}
        />
        <Stat label={localCopy.dashboard.unlocks} value={formatCount(totals.unlocks)} />
        <Stat label={localCopy.dashboard.published} value={formatCount(totals.dubsPublished)} />
        <Stat label={localCopy.dashboard.rejected} value={formatCount(totals.dubsRejected)} />
      </StatGrid>

      <LiveTicker seed={ticker} feed={feed} />

      <Panel title={localCopy.dashboard.accuracyTitle} subtitle={localCopy.dashboard.accuracySubtitle}>
        <AccuracyChart points={accuracy} />
      </Panel>

      <Panel
        title={localCopy.dashboard.jobsTitle}
        subtitle={localCopy.dashboard.jobsSubtitle}
        flush
      >
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{localCopy.dashboard.colJob}</th>
                <th>{localCopy.dashboard.colCreator}</th>
                <th>{localCopy.dashboard.colLanguage}</th>
                <th>{localCopy.dashboard.colStatus}</th>
                <th>{localCopy.dashboard.colCost}</th>
                <th>{localCopy.dashboard.colRevenue}</th>
                <th>{localCopy.dashboard.colProfit}</th>
                <th>{localCopy.dashboard.colRoi}</th>
                <th>{localCopy.dashboard.colUnlocks}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const down = job.profit.display.includes('-');
                return (
                  <tr key={job.jobId}>
                    <td>
                      <Link href={'/dub/' + job.jobId} style={{ fontWeight: 650 }}>
                        {job.jobId}
                      </Link>
                    </td>
                    <td style={{ color: 'var(--ink-soft)' }}>@{job.creatorHandle}</td>
                    <td>{job.targetLanguageName}</td>
                    <td>
                      <span className={down ? 'chip chip-berry' : 'chip chip-teal'}>
                        {job.statusLabel}
                      </span>
                    </td>
                    <td className="num">{job.cost.display}</td>
                    <td className="num">{job.revenue.display}</td>
                    <td className={down ? 'num money-down' : 'num money-up'}>{job.profit.display}</td>
                    <td className="num">{job.roiPercent === null ? '—' : job.roiPercent + '%'}</td>
                    <td className="num">{formatCount(job.unlocks)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title={localCopy.dashboard.decisionsTitle}
        subtitle={localCopy.dashboard.decisionsSubtitle}
      >
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.9rem' }}>
          {decisions.map((entry) => (
            <DecisionCard key={entry.jobId + entry.decidedAt} entry={entry} />
          ))}
        </ul>
      </Panel>

      <Panel title={localCopy.dashboard.agentsRosterTitle}>
        <div
          style={{
            display: 'grid',
            gap: '0.9rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
          }}
        >
          {agents.map((agent) => (
            <article
              key={agent.id}
              style={{
                border: '1px solid var(--rule)',
                borderRadius: 'var(--radius)',
                padding: '1rem',
                background: 'var(--paper-sunk)',
                display: 'grid',
                gap: '0.5rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}>
                <h3 style={{ fontSize: '1.1rem' }}>{agent.name}</h3>
                <span className="num" style={{ fontWeight: 650 }}>{agent.balance.display}</span>
              </div>
              <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>{agent.persona}</p>
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '0.35rem 0.75rem',
                  margin: 0,
                  fontSize: '0.8rem',
                }}
              >
                <Pair label={localCopy.dashboard.profit} value={agent.profit.display} />
                <Pair label={localCopy.dashboard.roi} value={agent.roiPercent === null ? '—' : agent.roiPercent + '%'} />
                <Pair label={localCopy.dashboard.jobsWon} value={formatCount(agent.jobsWon)} />
                <Pair label={localCopy.dashboard.jobsDeclined} value={formatCount(agent.jobsDeclined)} />
                <Pair label={localCopy.dashboard.qcPassRate} value={agent.qcPassRate + '%'} />
                <Pair
                  label={localCopy.dashboard.predictionError}
                  value={agent.predictionErrorPercent === null ? '—' : agent.predictionErrorPercent + '%'}
                />
              </dl>
              {agent.verifyUrl ? (
                <a
                  href={agent.verifyUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ fontSize: '0.78rem', color: 'var(--sky)', textDecoration: 'underline' }}
                >
                  {copy.receipt.verifyLink}
                </a>
              ) : null}
            </article>
          ))}
        </div>
      </Panel>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt style={{ color: 'var(--ink-faint)' }}>{label}</dt>
      <dd className="num" style={{ margin: 0, textAlign: 'right', fontWeight: 600 }}>
        {value}
      </dd>
    </>
  );
}

function DecisionCard({ entry }: { entry: DecisionLogEntryDto }) {
  const approved = entry.decision === 'APPROVE';
  return (
    <li
      style={{
        border: '1px solid var(--rule)',
        borderLeft: '4px solid ' + (approved ? 'var(--teal)' : 'var(--berry)'),
        borderRadius: 'var(--radius)',
        padding: '1rem',
        background: 'var(--paper-sunk)',
        display: 'grid',
        gap: '0.5rem',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <span className={approved ? 'chip chip-teal' : 'chip chip-berry'}>
          {approved ? localCopy.dashboard.approved : localCopy.dashboard.declined}
        </span>
        <strong style={{ fontSize: '0.95rem' }}>{entry.agentName}</strong>
        <span style={{ color: 'var(--ink-soft)', fontSize: '0.85rem' }}>
          @{entry.creatorHandle} · {entry.targetLanguageName}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: '0.72rem', color: 'var(--ink-faint)' }}>
          {formatWhen(entry.decidedAt)}
        </span>
      </div>

      <p style={{ fontSize: '0.95rem' }}>{entry.rationale}</p>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.4rem',
          fontSize: '0.75rem',
        }}
      >
        <span className="chip num">{formatCount(entry.math.predictedViews)} views</span>
        <span className="chip num">{entry.math.conversionPercent}% unlock rate</span>
        <span className="chip num">{entry.math.agentTakePerUnlock.display} per unlock</span>
        <span className="chip num">{entry.math.dubCost.display} to dub</span>
        <span className={'chip num ' + (entry.math.ev.display.includes('-') ? 'chip-berry' : 'chip-accent')}>
          {entry.math.ev.display} expected
        </span>
        <span className="chip num">{entry.math.confidencePercent}% confidence</span>
      </div>
    </li>
  );
}
