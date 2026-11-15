import Link from 'next/link';
import { copy, fill } from '@parrot/shared';
import { heroDubId } from '@/lib/fixtures';
import { localCopy } from '@/lib/local-copy';
import { ParrotMark } from '@/components/ParrotMark';
import { Panel } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const steps = [
    { title: localCopy.home.step1Title, body: localCopy.home.step1Body },
    { title: localCopy.home.step2Title, body: localCopy.home.step2Body },
    { title: localCopy.home.step3Title, body: localCopy.home.step3Body },
  ];

  return (
    <div className="stack" style={{ ['--stack' as string]: '2.5rem' }}>
      <section
        className="stack"
        style={{ ['--stack' as string]: '1.1rem', paddingTop: '1rem', maxWidth: '44rem' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <ParrotMark size={64} />
          <span className="eyebrow">{localCopy.home.eyebrow}</span>
        </div>
        <h1 style={{ fontSize: 'clamp(2.1rem, 7vw, 3.4rem)' }}>{localCopy.home.heroTitle}</h1>
        <p style={{ fontSize: '1.1rem', color: 'var(--ink-soft)' }}>{localCopy.home.heroBody}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
          <Link className="btn btn-primary btn-lg" href={'/dub/' + heroDubId}>
            {localCopy.home.heroCtaPrimary}
          </Link>
          <Link className="btn btn-secondary btn-lg" href="/agents">
            {localCopy.home.heroCtaSecondary}
          </Link>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
          <span className="chip chip-accent">{copy.demo.badge}</span>
          <span className="chip chip-teal">{copy.brand.tagline}</span>
          <span className="chip">{fill(copy.viewer.unlockCta, { price: '$0.02' })}</span>
        </div>
      </section>

      <section
        style={{
          display: 'grid',
          gap: '1rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
        }}
      >
        {steps.map((step, i) => (
          <article
            key={step.title}
            className="panel stack"
            style={{ ['--stack' as string]: '0.45rem' }}
          >
            <span
              aria-hidden
              className="num"
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: '2rem',
                color: 'var(--mango)',
                lineHeight: 1,
              }}
            >
              {i + 1}
            </span>
            <h2 style={{ fontSize: '1.15rem' }}>{step.title}</h2>
            <p style={{ color: 'var(--ink-soft)', fontSize: '0.95rem' }}>{step.body}</p>
          </article>
        ))}
      </section>

      <Panel title={localCopy.home.proofTitle}>
        <div className="stack" style={{ ['--stack' as string]: '0.9rem' }}>
          <p style={{ color: 'var(--ink-soft)' }}>{localCopy.home.proofBody}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <Link className="btn btn-secondary" href={'/dub/' + heroDubId}>
              {localCopy.home.proofCta}
            </Link>
            <Link className="btn btn-ghost" href="/creator/maya_builds">
              {copy.creator.dashboardTitle}
            </Link>
          </div>
        </div>
      </Panel>

      <section
        className="panel stack"
        style={{
          ['--stack' as string]: '0.5rem',
          background:
            'linear-gradient(135deg, color-mix(in srgb, var(--teal) 13%, var(--paper-raised)), var(--paper-raised))',
        }}
      >
        <h2 style={{ fontSize: '1.3rem' }}>{localCopy.home.riskTitle}</h2>
        <p style={{ color: 'var(--ink-soft)' }}>{localCopy.home.riskBody}</p>
        <p style={{ color: 'var(--ink-soft)' }}>{copy.viewer.howItWorksBody}</p>
      </section>
    </div>
  );
}
