import type { Metadata } from 'next';
import Link from 'next/link';
import { copy, fill } from '@parrot/shared';
import { getCreator } from '@/lib/api';
import { localCopy } from '@/lib/local-copy';
import { ClaimButton } from '@/components/ClaimButton';
import { ReceiptRow } from '@/components/ReceiptDrawer';
import { EmptyState, Panel, Stat, StatGrid, formatCount } from '@/components/ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  return { title: copy.creator.dashboardTitle + ' — @' + handle };
}

export default async function CreatorPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const { data } = await getCreator(handle);
  const hasEarnings = data.readyToClaim.micros !== '0';

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      <header className="stack" style={{ ['--stack' as string]: '0.5rem' }}>
        <span className="eyebrow">@{data.handle}</span>
        <h1 style={{ fontSize: '2rem' }}>{copy.creator.dashboardTitle}</h1>
        <p style={{ color: 'var(--ink-soft)' }}>{copy.brand.creatorTagline}</p>
      </header>

      <section
        className="panel stack"
        style={{
          ['--stack' as string]: '1rem',
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--mango) 14%, var(--paper-raised)), var(--paper-raised))',
        }}
      >
        <StatGrid>
          <Stat label={copy.creator.totalEarned} value={data.totalEarned.display} />
          <Stat label={copy.creator.pendingLabel} value={data.readyToClaim.display} tone="up" />
          <Stat label={copy.creator.paidOutLabel} value={data.paidOut.display} />
        </StatGrid>

        <ClaimButton amount={data.readyToClaim} enabled={hasEarnings && data.signedIn} />

        {hasEarnings ? (
          <p style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
            {fill(copy.creator.earningsWaiting, { amount: data.readyToClaim.display })}
          </p>
        ) : null}

        {!data.signedIn ? (
          <div className="stack" style={{ ['--stack' as string]: '0.25rem' }}>
            <strong>{copy.creator.signInPrompt}</strong>
            <span style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
              {copy.creator.signInBody}
            </span>
          </div>
        ) : null}
      </section>

      <Panel title={localCopy.creator.backToDubs} subtitle={localCopy.creator.shareHint} flush>
        {data.dubs.length === 0 ? (
          <EmptyState
            title={copy.creator.noDubsTitle}
            body={fill(copy.creator.noDubsBody, { mention: copy.bot.mention })}
            action={
              <Link className="btn btn-secondary" href="/console">
                {localCopy.nav.console}
              </Link>
            }
          />
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>{localCopy.creator.colDub}</th>
                  <th>{localCopy.creator.colStatus}</th>
                  <th>{localCopy.creator.colViews}</th>
                  <th>{localCopy.creator.colUnlocks}</th>
                  <th>{localCopy.creator.colEarned}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.dubs.map((dub) => (
                  <tr key={dub.jobId}>
                    <td style={{ fontWeight: 650 }}>{dub.targetLanguageName}</td>
                    <td>
                      <span
                        className={
                          dub.state === 'DECLINED' || dub.state === 'REJECTED_BY_QC'
                            ? 'chip chip-berry'
                            : dub.state === 'DUBBING'
                              ? 'chip'
                              : 'chip chip-teal'
                        }
                      >
                        {dub.statusLabel}
                      </span>
                    </td>
                    <td className="num">{formatCount(dub.views)}</td>
                    <td className="num">{formatCount(dub.unlocks)}</td>
                    <td className="num money-up">{dub.earned.display}</td>
                    <td style={{ textAlign: 'right' }}>
                      <Link className="btn btn-ghost" href={dub.dubPath}>
                        {localCopy.creator.viewDub}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={copy.creator.explainerTitle}>
        <p style={{ color: 'var(--ink-soft)' }}>
          {fill(copy.creator.explainerBody, { creatorShare: data.creatorSharePercent + '%' })}
        </p>
      </Panel>

      <Panel title={localCopy.creator.receiptsTitle} flush>
        {data.receipts.length === 0 ? (
          <EmptyState title={copy.creator.claimEmptyTitle} body={copy.creator.claimEmptyBody} />
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data.receipts.map((receipt) => (
              <ReceiptRow key={receipt.id} receipt={receipt} />
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
