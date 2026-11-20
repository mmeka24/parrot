'use client';

import Link from 'next/link';
import { useAccount } from '@/lib/account';

/** The landing page's main button: your dashboard, sign in, or the demo. */
export function HomeCta({ firstCreator }: { firstCreator: string | null }) {
  const { status, me, config } = useAccount();
  const mine = status === 'in' ? me?.creatorHandle : null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
      {mine ? (
        <Link className="btn btn-primary btn-lg" href={`/creator/${mine}`}>
          Open my dashboard
        </Link>
      ) : status === 'out' ? (
        <Link className="btn btn-primary btn-lg" href="/signin">
          Sign in to start
        </Link>
      ) : firstCreator && status !== 'in' ? (
        <Link className="btn btn-primary btn-lg" href={`/creator/${firstCreator}`}>
          See a creator&apos;s dashboard
        </Link>
      ) : null}
      {firstCreator && (mine || status === 'out') ? (
        <Link className="btn btn-secondary btn-lg" href={`/creator/${firstCreator}`}>
          See a demo creator
        </Link>
      ) : null}
      {status === 'out' && config ? (
        <span className="note">A new account starts with {config.bonus} to pay for your first views.</span>
      ) : null}
    </div>
  );
}
