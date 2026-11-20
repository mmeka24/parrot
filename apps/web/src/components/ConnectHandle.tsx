'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { connectHandle } from '@/lib/api';
import { useAccount } from '@/lib/account';

/**
 * For someone who has signed in but not yet said what name they post under.
 * Connecting it makes that creator page theirs: only they can change it, and
 * its views are paid for from their own balance.
 */
export function ConnectHandle() {
  const { status, me, refresh } = useAccount();
  const router = useRouter();
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status !== 'in' || !me || me.creatorHandle) return null;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await connectHandle(handle);
    setBusy(false);
    if (!result.ok) {
      setError(`${result.title}. ${result.detail}`);
      return;
    }
    await refresh();
    router.push(`/creator/${result.handle}`);
  }

  return (
    <section className="panel plan-card stack" style={{ ['--stack' as string]: '0.9rem' }}>
      <div>
        <span className="eyebrow">One more step</span>
        <h2 style={{ fontSize: '1.35rem', marginTop: '0.2rem' }}>What name do you post under?</h2>
        <p style={{ color: 'var(--ink-soft)', marginTop: '0.3rem' }}>
          Parrot uses it to find your videos. From then on your dubs&apos; views are paid for from your own balance
          {me.balance ? ` (${me.balance.display} to start)` : ''}.
        </p>
      </div>
      <form onSubmit={(e) => void submit(e)} style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="sr-only" htmlFor="connect-handle">
          The name you post under
        </label>
        <input
          id="connect-handle"
          className="input"
          style={{ maxWidth: '16rem' }}
          placeholder="@yourname"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={16}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={busy || handle.trim().length === 0}>
          {busy ? <span className="spin" aria-hidden /> : null}
          Connect
        </button>
      </form>
      {error ? (
        <p className="callout callout-bad" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
