import type { Metadata } from 'next';
import { technicalCopy } from '@parrot/shared';
import { getSystemStatus } from '@/lib/api';
import { Panel, Stat, StatGrid } from '@/components/ui';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: technicalCopy.underTheHoodTitle };

/**
 * For judges and the curious. This is the one page allowed to say "wallet",
 * "USDC" and "on-chain": everywhere else the product keeps that out of sight.
 */
export default async function UnderTheHoodPage() {
  const status = await getSystemStatus();

  if (!status) {
    return (
      <section className="panel">
        <h1 style={{ fontSize: '1.6rem' }}>{technicalCopy.underTheHoodTitle}</h1>
        <p style={{ color: 'var(--ink-soft)', marginTop: '0.5rem' }}>Parrot&apos;s server cannot be reached right now.</p>
      </section>
    );
  }

  const { pricing, chain, house } = status;

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      <header className="stack" style={{ ['--stack' as string]: '0.4rem' }}>
        <span className="eyebrow">{technicalCopy.chainLabel}</span>
        <h1 style={{ fontSize: '2rem' }}>{technicalCopy.underTheHoodTitle}</h1>
        <p style={{ color: 'var(--ink-soft)' }}>{technicalCopy.underTheHoodSubtitle}</p>
      </header>

      <Panel title="What is simulated right now">
        {status.simulated.length === 0 ? (
          <p>Nothing. Every subsystem is running for real.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
            {status.simulated.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
        <p className="note" style={{ marginTop: '0.75rem' }}>
          Separately from this list: the seeded demo posts have no footage, so their dubs are always stand-ins, and the demo
          audience is generated. Both are labelled wherever they appear.
        </p>
      </Panel>

      <Panel title="The deal" subtitle="One set of numbers, used by the planner, the billing and every screen.">
        <StatGrid>
          <Stat label="A creator pays" value={pricing.pricePerThousand.display} hint="per 1,000 views a dub gets" />
          <Stat label="A dub costs Parrot" value={pricing.dubCostPerMinute.display} hint="per minute, per language (ElevenLabs)" />
          <Stat label="Default post budget" value={pricing.defaultPostBudget.display} hint="the most one post can cost a creator" />
          <Stat label="Example view value" value={pricing.defaultValuePerThousand.display} hint="per 1,000 views, until a creator sets theirs" />
        </StatGrid>
        <ul style={{ margin: '1rem 0 0', paddingLeft: '1.2rem', display: 'grid', gap: '0.4rem', color: 'var(--ink-soft)' }}>
          <li>
            The first {pricing.explorePosts} posts are dubbed into {pricing.exploreLanguages} languages each. After that, up to{' '}
            {pricing.maxWinners} proven languages plus one being tested.
          </li>
          <li>
            A language is proven when its dubs average at least the views needed for the creator&apos;s payments to cover the
            dub (a 30-second dub costs $0.25, so 250 views). It is dropped after falling short twice in a row, or once by a wide
            margin.
          </li>
          <li>A creator&apos;s &quot;worth&quot; figures use their own rate. They are never money anyone received.</li>
        </ul>
      </Panel>

      <Panel title="Parrot's side of the deal" subtitle="Across every creator on this server.">
        <StatGrid>
          <Stat label="Dubs made" value={String(house.dubsMade)} />
          <Stat label="Spent on dubs" value={house.dubSpend.display} tone="down" hint="at list price, stand-ins included" />
          <Stat label="Collected for views" value={house.collected.display} tone="up" />
          <Stat label="Net" value={house.net.display} tone={house.net.display.startsWith('-') ? 'down' : 'up'} />
        </StatGrid>
        <p className="note" style={{ marginTop: '0.75rem' }}>{technicalCopy.offChainCostNote}</p>
      </Panel>

      <Panel title="What is on Arc">
        <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.5rem' }}>
          <li>
            <strong>Every signed-in creator has an Arc wallet.</strong> It is created at sign-up and funded with a small amount
            of testnet USDC. {technicalCopy.custodialNote}
          </li>
          <li>
            <strong>Each payment for views is one USDC transfer</strong> from the creator&apos;s wallet to Parrot&apos;s, sent in
            batches rather than per view. A confirmed payment links to its transaction; a payment from a demo balance never
            does, because nothing was sent.
          </li>
          <li>{technicalCopy.gasNote}</li>
        </ul>
        <dl style={{ display: 'grid', gap: '0.5rem', marginTop: '1rem', fontSize: '0.9rem' }}>
          <div>
            <dt className="eyebrow">USDC on {chain.name}</dt>
            <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
              <a href={`${chain.explorerUrl}/address/${chain.usdcAddress}`} target="_blank" rel="noreferrer">
                {chain.usdcAddress}
              </a>
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Where creators&apos; payments arrive</dt>
            <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
              {chain.revenueAddress && chain.revenueAddressUrl ? (
                <a href={chain.revenueAddressUrl} target="_blank" rel="noreferrer">
                  {chain.revenueAddress}
                </a>
              ) : (
                'No wallet configured on this server: demo balances only.'
              )}
            </dd>
          </div>
          <div>
            <dt className="eyebrow">Accounts</dt>
            <dd style={{ margin: 0 }}>{status.accounts ? 'On: people can sign in and pay from their own balance.' : 'Off on this server: creators use demo balances.'}</dd>
          </div>
        </dl>
      </Panel>

      <Panel title="Who does what">
        <ul style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.5rem' }}>
          <li>
            <strong>ElevenLabs</strong> makes every dub (Dubbing API), one per language.
          </li>
          <li>
            <strong>xAI / Grok</strong> does everything that checks or reads: it hears each dub and judges whether it says the
            same thing as the original, reads creators&apos; requests, reads what language people reply in, and writes the short
            summary on a creator&apos;s page. The company that made a dub never grades it.
          </li>
          <li>
            <strong>Arc</strong> carries the money: creators&apos; wallets, and their payments for views.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
