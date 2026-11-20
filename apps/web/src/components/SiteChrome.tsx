'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { SystemStatusDto } from '@parrot/shared';
import { copy } from '@parrot/shared';
import { localCopy } from '@/lib/local-copy';
import { ParrotMark } from './ParrotMark';

const NAV = [
  { href: '/', label: localCopy.nav.home },
  { href: '/agents', label: localCopy.nav.agents },
  { href: '/leaderboard', label: localCopy.nav.leaderboard },
  { href: '/console', label: localCopy.nav.console },
  { href: '/under-the-hood', label: localCopy.nav.underTheHood },
  { href: '/extension', label: localCopy.nav.extension },
];

export function SiteHeader({ status }: { status: SystemStatusDto }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        backdropFilter: 'blur(12px)',
        background: 'color-mix(in srgb, var(--paper) 86%, transparent)',
        borderBottom: '1px solid var(--rule)',
      }}
    >
      <div
        className="shell"
        style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: 64 }}
      >
        <Link
          href="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.55rem',
            textDecoration: 'none',
            fontFamily: 'var(--font-display)',
            fontSize: '1.2rem',
            fontWeight: 650,
            letterSpacing: '-0.02em',
          }}
        >
          <ParrotMark size={30} title={copy.brand.name} />
          {copy.brand.name}
        </Link>

        {status.demoMode ? (
          <span className="chip chip-accent" style={{ marginLeft: '0.1rem' }}>
            {copy.demo.badge}
          </span>
        ) : null}

        <nav
          aria-label="Primary"
          style={{ marginLeft: 'auto', display: 'none', gap: '0.25rem' }}
          className="desktop-nav"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              style={{
                padding: '0.5rem 0.75rem',
                borderRadius: 999,
                fontSize: '0.88rem',
                fontWeight: 600,
                textDecoration: 'none',
                color: pathname === item.href ? 'var(--mango-deep)' : 'var(--ink-soft)',
                background: pathname === item.href ? 'var(--mango-wash)' : 'transparent',
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <button
          type="button"
          className="btn btn-ghost mobile-toggle"
          aria-expanded={open}
          aria-controls="mobile-nav"
          onClick={() => setOpen((v) => !v)}
          style={{ marginLeft: 'auto' }}
        >
          {open ? localCopy.nav.close : localCopy.nav.menu}
        </button>
      </div>

      {open ? (
        <nav
          id="mobile-nav"
          aria-label="Primary"
          className="shell fade-in"
          style={{ paddingBottom: '0.85rem', display: 'grid', gap: '0.3rem' }}
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
              style={{
                padding: '0.8rem 0.9rem',
                borderRadius: 'var(--radius)',
                textDecoration: 'none',
                fontWeight: 600,
                background: pathname === item.href ? 'var(--mango-wash)' : 'var(--paper-sunk)',
                color: pathname === item.href ? 'var(--mango-deep)' : 'var(--ink)',
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}

      <style>{`
        @media (min-width: 860px) {
          .desktop-nav { display: flex !important; }
          .mobile-toggle { display: none !important; }
        }
      `}</style>
    </header>
  );
}

export function SimulatedBanner({ items }: { items: readonly string[] }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || items.length === 0) return null;

  return (
    <div
      role="status"
      style={{
        background: 'var(--mango-wash)',
        borderBottom: '1px solid color-mix(in srgb, var(--mango) 35%, transparent)',
        color: 'var(--mango-deep)',
      }}
    >
      <div
        className="shell"
        style={{
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-start',
          padding: '0.75rem 16px',
          fontSize: '0.84rem',
        }}
      >
        <div style={{ flex: 1 }}>
          <strong style={{ display: 'block', marginBottom: '0.15rem' }}>
            {localCopy.shell.simulatedBannerTitle}
          </strong>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'grid', gap: '0.15rem' }}>
            {items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => setDismissed(true)}>
          {localCopy.shell.simulatedBannerDismiss}
        </button>
      </div>
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer
      style={{
        marginTop: '4rem',
        borderTop: '1px solid var(--rule)',
        background: 'var(--paper-sunk)',
      }}
    >
      <div
        className="shell"
        style={{
          padding: '2rem 16px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '1rem',
          alignItems: 'center',
          justifyContent: 'space-between',
          color: 'var(--ink-soft)',
          fontSize: '0.85rem',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
          <ParrotMark size={22} />
          {copy.brand.name} — {localCopy.shell.footerTagline}
        </span>
        <span>{localCopy.home.footerNote}</span>
      </div>
    </footer>
  );
}

/** Registers the service worker so the app is installable. */
export function ServiceWorker() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* offline support is a nicety; never break the page over it */
      });
    };
    window.addEventListener('load', onLoad);
    return () => window.removeEventListener('load', onLoad);
  }, []);
  return null;
}
