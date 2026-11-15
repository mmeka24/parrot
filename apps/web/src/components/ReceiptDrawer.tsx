'use client';

import { useState } from 'react';
import type { ReceiptDto } from '@parrot/shared';
import { copy } from '@parrot/shared';
import { localCopy } from '@/lib/local-copy';
import { formatWhen } from './ui';

/**
 * Collapsed by default. The ONLY place in the viewer flow where the
 * "Verify on Arc" link is allowed to appear.
 */
export function ReceiptDrawer({ receipts }: { receipts: readonly ReceiptDto[] }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="panel" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="receipt-drawer"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          background: 'transparent',
          border: 0,
          padding: '1.1rem 1.25rem',
          cursor: 'pointer',
          textAlign: 'left',
          minHeight: 56,
        }}
      >
        <span style={{ fontWeight: 650 }}>{localCopy.dub.receiptsToggle}</span>
        <span style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>
          {localCopy.dub.receiptsHint}
        </span>
        <span
          aria-hidden
          style={{
            marginLeft: 'auto',
            transition: 'transform 180ms ease',
            transform: open ? 'rotate(180deg)' : 'none',
            color: 'var(--ink-faint)',
          }}
        >
          ▾
        </span>
      </button>

      {open ? (
        <div
          id="receipt-drawer"
          className="fade-in"
          style={{ borderTop: '1px solid var(--rule)', padding: '0.5rem 0' }}
        >
          {receipts.length === 0 ? (
            <p style={{ padding: '1rem 1.25rem', color: 'var(--ink-soft)', fontSize: '0.9rem' }}>
              {copy.creator.claimEmptyBody}
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {receipts.map((r) => (
                <ReceiptRow key={r.id} receipt={r} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function ReceiptRow({ receipt }: { receipt: ReceiptDto }) {
  return (
    <li
      style={{
        display: 'flex',
        gap: '0.9rem',
        alignItems: 'flex-start',
        padding: '0.9rem 1.25rem',
        borderBottom: '1px solid var(--rule)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 650, fontSize: '0.95rem' }}>{receipt.title}</div>
        <div style={{ color: 'var(--ink-soft)', fontSize: '0.86rem' }}>{receipt.detail}</div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
            marginTop: '0.35rem',
            fontSize: '0.75rem',
            color: 'var(--ink-faint)',
          }}
        >
          <span>
            {receipt.status === 'pending'
              ? copy.receipt.pending
              : receipt.status === 'failed'
                ? copy.errors.genericTitle
                : formatWhen(receipt.at)}
          </span>
          {receipt.verifyUrl ? (
            <a
              href={receipt.verifyUrl}
              target="_blank"
              rel="noreferrer noopener"
              title={copy.receipt.verifyHint}
              style={{ color: 'var(--sky)', textDecoration: 'underline', fontWeight: 600 }}
            >
              {copy.receipt.verifyLink}
            </a>
          ) : null}
        </div>
      </div>
      <div className="num" style={{ fontWeight: 650, whiteSpace: 'nowrap' }}>
        {receipt.amount.display}
      </div>
    </li>
  );
}
