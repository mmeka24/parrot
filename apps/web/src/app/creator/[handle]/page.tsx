import type { Metadata } from 'next';
import Link from 'next/link';
import { getCreator } from '@/lib/api';
import { timelineUrl } from '@/lib/site';
import { CreatorDashboard } from '@/components/dashboard/CreatorDashboard';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params;
  return { title: '@' + handle };
}

export default async function CreatorPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const data = await getCreator(handle);

  if (!data) {
    return (
      <section className="panel stack" style={{ ['--stack' as string]: '0.75rem' }}>
        <h1 style={{ fontSize: '1.6rem' }}>We cannot find @{handle}</h1>
        <p style={{ color: 'var(--ink-soft)' }}>
          Either nobody posts under that name yet, or Parrot could not be reached just now.
        </p>
        <div>
          <Link className="btn btn-primary" href="/">
            Back to the start
          </Link>
        </div>
      </section>
    );
  }

  return <CreatorDashboard initial={data} timelineUrl={timelineUrl} />;
}
