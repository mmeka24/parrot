import Link from 'next/link';
import { copy } from '@parrot/shared';

export default function NotFound() {
  return (
    <section className="panel stack" style={{ ['--stack' as string]: '0.75rem' }}>
      <h1 style={{ fontSize: '1.6rem' }}>{copy.errors.notFoundTitle}</h1>
      <p style={{ color: 'var(--ink-soft)' }}>{copy.errors.notFoundBody}</p>
      <div>
        <Link className="btn btn-primary" href="/">
          Back to the start
        </Link>
      </div>
    </section>
  );
}
