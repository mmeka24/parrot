import type { Metadata } from 'next';
import Link from 'next/link';
import { copy } from '@parrot/shared';
import { getDub } from '@/lib/api';
import { DubPlayer } from '@/components/DubPlayer';
import { formatCount } from '@/components/ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const dub = await getDub(id);
  if (!dub) return { title: copy.errors.dubNotFoundTitle };
  const title = `${dub.creatorDisplayName} in ${dub.name}`;
  const description = `Watch @${dub.creatorHandle}'s video in ${dub.name}. Free, dubbed by Parrot.`;
  const url = '/dub/' + encodeURIComponent(id);
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'video.other', url, title, description },
    twitter: { card: 'summary', title, description },
  };
}

export default async function DubPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dub = await getDub(id);

  if (!dub) {
    return (
      <section className="panel stack" style={{ ['--stack' as string]: '0.75rem' }}>
        <h1 style={{ fontSize: '1.6rem' }}>{copy.errors.dubNotFoundTitle}</h1>
        <p style={{ color: 'var(--ink-soft)' }}>{copy.errors.dubNotFoundBody}</p>
        <div>
          <Link className="btn btn-primary" href="/">
            Back to the start
          </Link>
        </div>
      </section>
    );
  }

  const live = dub.state === 'PUBLISHED';

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.25rem', maxWidth: '46rem', marginInline: 'auto' }}>
      <header className="stack" style={{ ['--stack' as string]: '0.4rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="chip chip-teal">
            <span className="flag" aria-hidden>
              {dub.flag}
            </span>
            {dub.nativeName}
          </span>
          <span className="chip">Free to watch</span>
          {dub.simulatedDub ? <span className="chip chip-accent">Stand-in audio</span> : null}
        </div>
        <h1 style={{ fontSize: 'clamp(1.5rem, 4.6vw, 2.1rem)', lineHeight: 1.2 }}>{dub.originalText}</h1>
        <p style={{ color: 'var(--ink-soft)' }}>
          {dub.creatorDisplayName}{' '}
          <Link href={`/creator/${dub.creatorHandle}`} style={{ color: 'inherit' }}>
            @{dub.creatorHandle}
          </Link>{' '}
          · dubbed into {dub.name} · {formatCount(dub.views)} {dub.views === 1 ? 'view' : 'views'}
        </p>
      </header>

      {live ? (
        <DubPlayer dub={dub} />
      ) : (
        <section className="panel stack" style={{ ['--stack' as string]: '0.5rem' }}>
          <h2 style={{ fontSize: '1.2rem' }}>{copy.errors.dubUnavailableTitle}</h2>
          <p style={{ color: 'var(--ink-soft)' }}>
            {copy.errors.dubUnavailableBody} ({dub.statusLabel})
          </p>
        </section>
      )}

      <section className="panel stack" style={{ ['--stack' as string]: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <a className="btn btn-secondary btn-sm" href={dub.originalUrl} target="_blank" rel="noreferrer">
            See the original post
          </a>
          {dub.alsoIn.length > 0 ? <span className="note">Also in</span> : null}
          {dub.alsoIn.map((other) => (
            <Link key={other.code} className="lang-pill" href={other.watchPath} style={{ textDecoration: 'none' }}>
              <span className="flag" aria-hidden>
                {other.flag}
              </span>
              {other.nativeName}
            </Link>
          ))}
        </div>
        <p className="note">
          Watching is free. {dub.creatorDisplayName} pays a small amount for each view, and only for views that happen.
        </p>
      </section>
    </div>
  );
}
