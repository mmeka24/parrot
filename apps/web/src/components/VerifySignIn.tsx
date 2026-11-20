'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { fill } from '@parrot/shared';
import { takeNext, useAccount } from '@/lib/account';
import { verifyEmailSignIn } from '@/lib/api';
import { localCopy } from '@/lib/local-copy';

const t = localCopy.account;

type View =
  | { kind: 'working' }
  | { kind: 'done'; created: boolean }
  | { kind: 'failed'; title: string; detail: string };

/**
 * Spends the one-time link from the email.
 *
 * The link lands on a PAGE, and this page does the confirming POST. That is
 * deliberate: mail programs often "open" links to scan them, and a scan that
 * made the sign-in request would use the link up before the person clicked it.
 */
export function VerifySignIn() {
  const { refresh, config } = useAccount();
  const [view, setView] = useState<View>({ kind: 'working' });
  const started = useRef(false);

  useEffect(() => {
    // React runs effects twice in development; a one-time link must be spent once.
    if (started.current) return;
    started.current = true;

    const token = new URLSearchParams(window.location.search).get('token') ?? '';
    // Take the secret out of the address bar (history, screenshots, shoulder-surfers).
    window.history.replaceState(null, '', '/auth/verify');

    void (async () => {
      const result = await verifyEmailSignIn(token);
      if (!result.ok) {
        setView({ kind: 'failed', title: t.verifyFailedTitle, detail: t.verifyFailedBody });
        return;
      }
      setView({ kind: 'done', created: result.created });
      await refresh();
      const next = takeNext() ?? '/';
      setTimeout(() => window.location.replace(next), 1200);
    })();
  }, [refresh]);

  const bonus = config?.bonus ?? '$1.00';

  return (
    <section className="panel stack" role="status" style={{ maxWidth: '28rem' }}>
      {view.kind === 'working' ? <h1 className="panel-title">{t.verifyingTitle}</h1> : null}
      {view.kind === 'done' ? (
        <div className="fade-in stack" style={{ ['--stack' as string]: '0.3rem' }}>
          <h1 className="panel-title">{t.verifiedTitle}</h1>
          <p className="panel-sub">{view.created ? fill(t.verifiedNew, { bonus }) : t.verifiedBack}</p>
        </div>
      ) : null}
      {view.kind === 'failed' ? (
        <div className="stack" style={{ ['--stack' as string]: '0.5rem' }}>
          <h1 className="panel-title">{view.title}</h1>
          <p className="panel-sub">{view.detail}</p>
          <Link className="btn btn-primary" href="/signin">
            {t.newLink}
          </Link>
        </div>
      ) : null}
    </section>
  );
}
