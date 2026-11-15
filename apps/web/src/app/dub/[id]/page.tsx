import type { Metadata } from 'next';
import Link from 'next/link';
import { copy, fill } from '@parrot/shared';
import { getDub } from '@/lib/api';
import { sampleDubIds } from '@/lib/fixtures';
import { localCopy } from '@/lib/local-copy';
import { DubView } from '@/components/DubView';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const { data } = await getDub(id);
  return {
    title: fill(copy.viewer.dubbedInto, { language: data.targetLanguageName }),
    description: copy.viewer.howItWorksBody,
  };
}

export default async function DubPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data } = await getDub(id);

  const others = sampleDubIds.filter((other) => other !== data.jobId).slice(0, 3);

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      <DubView dub={data} />

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{localCopy.dub.moreDubs}</h2>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {others.map((other) => (
            <Link key={other} className="btn btn-secondary" href={'/dub/' + other}>
              {other}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
