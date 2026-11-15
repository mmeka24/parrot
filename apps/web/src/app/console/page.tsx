import type { Metadata } from 'next';
import { copy } from '@parrot/shared';
import { getBotConsole } from '@/lib/api';
import { localCopy } from '@/lib/local-copy';
import { BotConsole } from '@/components/BotConsole';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: localCopy.console.title };

export default async function ConsolePage() {
  const { data } = await getBotConsole();

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      <header className="stack" style={{ ['--stack' as string]: '0.5rem' }}>
        <span className="eyebrow">{copy.demo.simulatedBadge}</span>
        <h1 style={{ fontSize: '2rem' }}>{localCopy.console.title}</h1>
        <p style={{ color: 'var(--ink-soft)', maxWidth: '42rem' }}>{localCopy.console.subtitle}</p>
        {data.simulated ? (
          <p
            role="note"
            style={{
              background: 'var(--mango-wash)',
              border: '1px solid color-mix(in srgb, var(--mango) 35%, transparent)',
              color: 'var(--mango-deep)',
              borderRadius: 'var(--radius)',
              padding: '0.75rem 1rem',
              fontSize: '0.88rem',
            }}
          >
            {localCopy.console.simulationNotice}
          </p>
        ) : null}
      </header>

      <BotConsole initial={data} />
    </div>
  );
}
