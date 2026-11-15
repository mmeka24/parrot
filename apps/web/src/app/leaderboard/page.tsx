import type { Metadata } from 'next';
import { copy } from '@parrot/shared';
import { getAgents } from '@/lib/api';
import { localCopy } from '@/lib/local-copy';
import { Panel, formatCount } from '@/components/ui';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: localCopy.leaderboard.title };

export default async function LeaderboardPage() {
  const { data } = await getAgents();

  // Ordering comes from the server's own `profit` display string ranking only
  // as a tiebreak-free list: the UI never parses money, so it keeps the order
  // the backend sent and marks the first row as the leader.
  const agents = data.agents;

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      <header className="stack" style={{ ['--stack' as string]: '0.5rem' }}>
        <span className="eyebrow">{copy.demo.badge}</span>
        <h1 style={{ fontSize: '2rem' }}>{localCopy.leaderboard.title}</h1>
        <p style={{ color: 'var(--ink-soft)' }}>{localCopy.leaderboard.subtitle}</p>
      </header>

      <Panel flush>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>{localCopy.leaderboard.rank}</th>
                <th>{localCopy.leaderboard.agent}</th>
                <th>{localCopy.dashboard.balance}</th>
                <th>{localCopy.dashboard.profit}</th>
                <th>{localCopy.dashboard.roi}</th>
                <th title={localCopy.leaderboard.winRateHint}>{localCopy.leaderboard.winRate}</th>
                <th title={localCopy.leaderboard.errorHint}>
                  {localCopy.dashboard.predictionError}
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent, i) => (
                <tr key={agent.id}>
                  <td className="num" style={{ color: 'var(--ink-faint)' }}>
                    {i + 1}
                  </td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <strong>{agent.name}</strong>
                      {i === 0 ? (
                        <span className="chip chip-accent">{localCopy.leaderboard.leaderBadge}</span>
                      ) : null}
                    </div>
                    <span style={{ fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
                      {agent.persona}
                    </span>
                  </td>
                  <td className="num">{agent.balance.display}</td>
                  <td
                    className={
                      agent.profit.display.includes('-') ? 'num money-down' : 'num money-up'
                    }
                  >
                    {agent.profit.display}
                  </td>
                  <td className="num">
                    {agent.roiPercent === null ? '—' : agent.roiPercent + '%'}
                  </td>
                  <td className="num">{agent.qcPassRate}%</td>
                  <td className="num">
                    {agent.predictionErrorPercent === null
                      ? '—'
                      : agent.predictionErrorPercent + '%'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel>
        <div
          style={{
            display: 'grid',
            gap: '0.85rem',
            gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
          }}
        >
          {agents.map((agent) => (
            <div key={agent.id} className="stack" style={{ ['--stack' as string]: '0.35rem' }}>
              <strong>{agent.name}</strong>
              <span style={{ fontSize: '0.82rem', color: 'var(--ink-soft)' }}>
                {formatCount(agent.jobsWon)} {localCopy.dashboard.jobsWon.toLowerCase()} ·{' '}
                {formatCount(agent.jobsDeclined)} {localCopy.dashboard.jobsDeclined.toLowerCase()}
              </span>
              <Meter percent={agent.qcPassRate} />
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/**
 * A pass-rate meter. `qcPassRate` arrives as a percentage string, which is not
 * money, so rendering it as a width is safe.
 */
function Meter({ percent }: { percent: string }) {
  const value = Math.max(0, Math.min(100, Number(percent)));
  return (
    <div
      role="img"
      aria-label={percent + '%'}
      style={{
        height: 8,
        borderRadius: 999,
        background: 'var(--paper-sunk)',
        border: '1px solid var(--rule)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: value + '%',
          height: '100%',
          background: 'var(--teal)',
        }}
      />
    </div>
  );
}
