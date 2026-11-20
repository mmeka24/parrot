import type { Metadata } from 'next';
import Link from 'next/link';
import { copy, fill, type DubPageDto } from '@parrot/shared';
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
  const title = fill(copy.viewer.dubbedInto, { language: data.targetLanguageName });
  const description = previewDescription(data);
  const url = '/dub/' + encodeURIComponent(id);
  // The image itself comes from ./opengraph-image.tsx, which Next wires into
  // og:image and twitter:image automatically.
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: 'video.other', url, title, description },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/** One line for the card under the title: who made it and what it costs. */
function previewDescription(dub: DubPageDto): string {
  return [
    'From ' + dub.creator.displayName + ' (@' + dub.creator.handle + ')',
    copy.viewer.previewBadge,
    fill(copy.viewer.unlockCta, { price: dub.price.display }),
  ].join(' · ');
}

export default async function DubPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data, live } = await getDub(id);

  // Only offer the sample dubs when we are running on fixtures. Against a live
  // backend these ids do not exist, so showing them hands the viewer three
  // links that 404.
  const others = live ? [] : sampleDubIds.filter((other) => other !== data.jobId).slice(0, 3);

  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      <DubView dub={data} />

      {others.length > 0 ? (
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
      ) : null}
    </div>
  );
}
