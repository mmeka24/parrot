'use client';

import { useState } from 'react';
import type { MoneyDto } from '@parrot/shared';
import { copy, fill } from '@parrot/shared';

type Phase = 'idle' | 'sending' | 'done';

export function ClaimButton({ amount, enabled }: { amount: MoneyDto; enabled: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle');

  if (!enabled) {
    return (
      <div className="stack" style={{ ['--stack' as string]: '0.35rem' }}>
        <button type="button" className="btn btn-primary btn-lg" disabled>
          {fill(copy.creator.claimCta, { amount: amount.display })}
        </button>
        <p style={{ fontSize: '0.8rem', color: 'var(--ink-faint)' }}>
          {copy.creator.claimEmptyBody}
        </p>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div
        className="fade-in stack"
        role="status"
        style={{
          ['--stack' as string]: '0.25rem',
          background: 'var(--teal-wash)',
          border: '1px solid color-mix(in srgb, var(--teal) 40%, transparent)',
          borderRadius: 'var(--radius)',
          padding: '0.9rem 1rem',
        }}
      >
        <strong style={{ color: 'var(--teal)' }}>{copy.creator.claimedTitle}</strong>
        <span style={{ fontSize: '0.88rem', color: 'var(--ink-soft)' }}>
          {fill(copy.creator.claimedBody, { amount: amount.display })}
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="btn btn-primary btn-lg"
      disabled={phase === 'sending'}
      onClick={() => {
        setPhase('sending');
        setTimeout(() => setPhase('done'), 900);
      }}
    >
      {phase === 'sending'
        ? copy.creator.claimingCta
        : fill(copy.creator.claimCta, { amount: amount.display })}
    </button>
  );
}
