'use client';

import { copy } from '@parrot/shared';

export default function ErrorBoundary({ reset }: { error: Error; reset: () => void }) {
  return (
    <section className="panel stack" style={{ ['--stack' as string]: '0.75rem' }}>
      <h1 style={{ fontSize: '1.6rem' }}>{copy.errors.genericTitle}</h1>
      <p style={{ color: 'var(--ink-soft)' }}>{copy.errors.genericBody}</p>
      <div>
        <button type="button" className="btn btn-primary" onClick={reset}>
          Try again
        </button>
      </div>
    </section>
  );
}
