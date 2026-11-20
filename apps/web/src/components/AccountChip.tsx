'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAccount } from '@/lib/account';
import { localCopy } from '@/lib/local-copy';

/** The header's account control: "Sign in", or your balance and a way out. */
export function AccountChip() {
  const { status, me, signOut } = useAccount();
  const pathname = usePathname();

  // Nothing while loading, and nothing at all if this server has no accounts.
  if (status === 'loading' || status === 'off') return null;

  if (status === 'out') {
    const next = pathname && pathname !== '/signin' && pathname !== '/auth/verify' ? `?next=${encodeURIComponent(pathname)}` : '';
    return (
      <Link className="btn btn-secondary" href={`/signin${next}`} style={{ marginLeft: '0.5rem', padding: '0.45rem 0.9rem' }}>
        {localCopy.account.signIn}
      </Link>
    );
  }

  const name = (me?.email ?? '').split('@')[0];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', marginLeft: '0.5rem' }}>
      <span className="chip chip-teal" title={me?.email} aria-live="polite">
        {me?.balance ? me.balance.display : localCopy.account.settingUp}
      </span>
      {me?.creatorHandle ? (
        <Link className="btn btn-ghost desktop-only" style={{ padding: '0.35rem 0.6rem' }} href={`/creator/${me.creatorHandle}`}>
          @{me.creatorHandle}
        </Link>
      ) : (
        <span className="desktop-only" style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
          {name}
        </span>
      )}
      <button type="button" className="btn btn-ghost" style={{ padding: '0.35rem 0.6rem' }} onClick={() => void signOut()}>
        {localCopy.account.signOut}
      </button>
      <style>{`.desktop-only{display:none}@media(min-width:860px){.desktop-only{display:inline-flex}}`}</style>
    </span>
  );
}
