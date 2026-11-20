import Link from 'next/link';
import { copy } from '@parrot/shared';
import { getSystemStatus } from '@/lib/api';
import { timelineUrl } from '@/lib/site';
import { ConnectHandle } from '@/components/ConnectHandle';
import { HomeCta } from '@/components/HomeCta';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const status = await getSystemStatus();
  const pricing = status?.pricing;
  const creators = (status?.creators ?? []).filter((c) => c.handle !== 'parrot');

  return (
    <div className="stack" style={{ ['--stack' as string]: '2.5rem' }}>
      <section className="stack" style={{ ['--stack' as string]: '1.1rem', paddingTop: '1rem' }}>
        <span className="eyebrow">For video creators</span>
        <h1 className="hero-title">Get your videos seen in every language.</h1>
        <p style={{ fontSize: '1.15rem', color: 'var(--ink-soft)', maxWidth: '40rem' }}>
          Parrot dubs your video into several languages, finds the ones your audience actually watches, and keeps dubbing only
          those. {copy.brand.promise}
        </p>
        <HomeCta firstCreator={creators[0]?.handle ?? null} />
      </section>

      <ConnectHandle />

      {!status ? (
        <p className="callout callout-bad" role="status">
          Parrot&apos;s server cannot be reached right now, so there is nothing to show yet. Start it and reload.
        </p>
      ) : null}

      <section className="steps" aria-label="How it works">
        <div className="panel stack" style={{ ['--stack' as string]: '0.6rem' }}>
          <span className="step-num">1</span>
          <h2 style={{ fontSize: '1.15rem' }}>First post: try several languages</h2>
          <p style={{ color: 'var(--ink-soft)' }}>
            With nothing to go on, Parrot dubs your video into {pricing?.exploreLanguages ?? 6} languages and posts each one
            under it. You pay nothing to try them.
          </p>
        </div>
        <div className="panel stack" style={{ ['--stack' as string]: '0.6rem' }}>
          <span className="step-num">2</span>
          <h2 style={{ fontSize: '1.15rem' }}>See which ones get watched</h2>
          <p style={{ color: 'var(--ink-soft)' }}>
            Each dub is its own post with its own view count. After {pricing?.explorePosts ?? 2} posts Parrot knows which
            languages pay for themselves and drops the ones that do not.
          </p>
        </div>
        <div className="panel stack" style={{ ['--stack' as string]: '0.6rem' }}>
          <span className="step-num">3</span>
          <h2 style={{ fontSize: '1.15rem' }}>Pay only for the views</h2>
          <p style={{ color: 'var(--ink-soft)' }}>
            {pricing?.pricePerThousand.display ?? '$1.00'} for every 1,000 views your dubs get, up to a limit you set per post.
            A dub nobody watches costs you nothing: that one is on Parrot.
          </p>
        </div>
      </section>

      {creators.length > 0 ? (
        <section className="panel stack" style={{ ['--stack' as string]: '0.9rem' }}>
          <div>
            <h2 className="panel-title">Look around with a demo creator</h2>
            <p className="panel-sub">
              These creators live on the stand-in timeline. Open one to see what Parrot has learned about their audience, dub
              a post, and watch the numbers move.
            </p>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            {creators.map((creator) => (
              <Link key={creator.handle} className="btn btn-secondary" href={`/creator/${creator.handle}`}>
                {creator.displayName} <span style={{ color: 'var(--ink-faint)', fontWeight: 500 }}>@{creator.handle}</span>
              </Link>
            ))}
            <a className="btn btn-ghost" href={timelineUrl} target="_blank" rel="noreferrer">
              Open the timeline
            </a>
          </div>
        </section>
      ) : null}
    </div>
  );
}
