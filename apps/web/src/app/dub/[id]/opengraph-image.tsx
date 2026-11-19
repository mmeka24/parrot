/**
 * The link-preview image for a dub: what shows up when Parrot's reply link is
 * unfurled on X (or pasted into iMessage, Slack, Discord...).
 *
 * Rendered to PNG on request. X and most unfurlers ignore SVG, so the posters
 * in /public cannot be used directly. All text comes from the shared copy map,
 * so the no-crypto-vocabulary rule still holds here.
 */

import { ImageResponse } from 'next/og';
import { copy, fill } from '@parrot/shared';
import { getDub } from '@/lib/api';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = copy.viewer.poweredBy;

const INK = '#f6efe3';
const SOFT = '#bdb3a1';
const MANGO = '#ff8a3d';
const TEAL = '#4fd1b9';
const BG = '#14130f';

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { data: dub } = await getDub(id);

  const minutes = Math.floor(dub.durationS / 60);
  const seconds = String(Math.round(dub.durationS % 60)).padStart(2, '0');

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 72px',
          background: `radial-gradient(circle at 15% 0%, #1f4a43 0%, ${BG} 55%)`,
          color: INK,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 999,
              background: TEAL,
              display: 'flex',
            }}
          />
          <div style={{ fontSize: 34, fontWeight: 700 }}>{copy.brand.name}</div>
          <div style={{ fontSize: 26, color: SOFT, marginLeft: 8 }}>{copy.brand.tagline}</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', gap: 14 }}>
            <Pill color={TEAL}>{copy.viewer.previewBadge}</Pill>
            <Pill color={SOFT}>{`${minutes}:${seconds}`}</Pill>
          </div>
          <div style={{ fontSize: 88, fontWeight: 700, lineHeight: 1.05 }}>
            {fill(copy.viewer.dubbedInto, { language: dub.targetLanguageName })}
          </div>
          <div style={{ fontSize: 34, color: SOFT }}>
            {`${dub.creator.displayName}  @${dub.creator.handle}`}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div
            style={{
              display: 'flex',
              padding: '18px 34px',
              borderRadius: 999,
              background: MANGO,
              color: BG,
              fontSize: 34,
              fontWeight: 700,
            }}
          >
            {fill(copy.viewer.unlockCta, { price: dub.price.display })}
          </div>
          <div style={{ fontSize: 26, color: SOFT }}>{copy.viewer.poweredBy}</div>
        </div>
      </div>
    ),
    size,
  );
}

function Pill({ color, children }: { color: string; children: string }) {
  return (
    <div
      style={{
        display: 'flex',
        padding: '8px 20px',
        borderRadius: 999,
        border: `2px solid ${color}`,
        color,
        fontSize: 26,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}
