'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { fill } from '@parrot/shared';
import { rememberNext, useAccount } from '@/lib/account';
import { googleSignInUrl, startEmailSignIn } from '@/lib/api';
import { localCopy } from '@/lib/local-copy';

const t = localCopy.account;

/** A path on this site, or nothing. Never an address on another site. */
function safeNext(raw: string | null): string | null {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : null;
}

export function SignInForm() {
  const params = useSearchParams();
  const router = useRouter();
  const { status, config } = useAccount();
  const next = safeNext(params.get('next'));
  const urlError = params.get('error');

  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);

  // Already in: nothing to do here.
  useEffect(() => {
    if (status === 'in') router.replace(next ?? '/');
  }, [status, next, router]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPhase('sending');
    rememberNext(next);
    const result = await startEmailSignIn(email);
    if (result.ok) {
      setPhase('sent');
    } else {
      setPhase('idle');
      setError({ title: result.title, detail: result.detail });
    }
  }

  const bonus = config?.bonus ?? '$1.00';

  if (status === 'off') {
    return (
      <section className="panel stack">
        <h1 className="panel-title">{t.signInTitle}</h1>
        <p className="panel-sub">{t.unavailable}</p>
      </section>
    );
  }

  if (phase === 'sent') {
    return (
      <section className="panel stack fade-in" role="status">
        <h1 className="panel-title">{t.checkEmailTitle}</h1>
        <p className="panel-sub">{fill(t.checkEmailBody, { email })}</p>
        <button type="button" className="btn btn-ghost" onClick={() => setPhase('idle')}>
          {t.useDifferent}
        </button>
      </section>
    );
  }

  const failure =
    error ??
    (urlError === 'google_failed'
      ? { title: t.googleFailed, detail: '' }
      : urlError === 'google_unavailable'
        ? { title: t.googleUnavailable, detail: '' }
        : null);

  return (
    <section className="panel stack" style={{ ['--stack' as string]: '1rem', maxWidth: '28rem' }}>
      <div className="stack" style={{ ['--stack' as string]: '0.3rem' }}>
        <h1 className="panel-title">{t.signInTitle}</h1>
        <p className="panel-sub">{fill(t.signInIntro, { bonus })}</p>
      </div>

      {failure ? (
        <div role="alert" style={{ background: 'var(--berry-wash)', border: '1px solid var(--berry)', borderRadius: 'var(--radius)', padding: '0.75rem 1rem' }}>
          <strong style={{ display: 'block', color: 'var(--berry)' }}>{failure.title}</strong>
          {failure.detail ? <span style={{ fontSize: '0.88rem', color: 'var(--ink-soft)' }}>{failure.detail}</span> : null}
        </div>
      ) : null}

      {config?.providers.google ? (
        <a className="btn btn-primary btn-lg btn-block" href={googleSignInUrl} onClick={() => rememberNext(next)}>
          {t.google}
        </a>
      ) : null}

      {config?.providers.google && config.providers.email ? (
        <p style={{ textAlign: 'center', color: 'var(--ink-faint)', fontSize: '0.85rem', margin: 0 }}>{t.or}</p>
      ) : null}

      {config?.providers.email ? (
        <form onSubmit={onSubmit} className="stack" style={{ ['--stack' as string]: '0.6rem' }}>
          <label htmlFor="email" style={{ fontWeight: 600, fontSize: '0.9rem' }}>
            {t.emailLabel}
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t.emailPlaceholder}
            style={{ padding: '0.7rem 0.85rem', borderRadius: 'var(--radius)', border: '1px solid var(--rule)', font: 'inherit', background: 'var(--paper)', color: 'var(--ink)' }}
          />
          <button type="submit" className="btn btn-secondary btn-lg btn-block" disabled={phase === 'sending' || email.trim() === ''}>
            {phase === 'sending' ? t.emailSending : t.emailCta}
          </button>
        </form>
      ) : null}

      {status === 'loading' ? <p className="panel-sub">…</p> : null}
      <Link href="/" style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>
        ← {localCopy.nav.home}
      </Link>
    </section>
  );
}
