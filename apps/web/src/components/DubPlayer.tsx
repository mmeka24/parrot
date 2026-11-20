'use client';

import { useEffect, useRef } from 'react';
import type { DubPageDto } from '@parrot/shared';
import { recordDubView } from '@/lib/api';

/**
 * Plays a dub and counts the viewer.
 *
 * A viewer is counted once, when playback actually starts - not on page load,
 * so a link preview or a tab opened and closed is not a view. The server
 * de-duplicates per browser, so calling twice is harmless.
 */
export function DubPlayer({ dub }: { dub: DubPageDto }) {
  const counted = useRef(false);

  const count = (): void => {
    if (counted.current) return;
    counted.current = true;
    void recordDubView(dub.id);
  };

  // A stand-in dub has nothing worth playing, so opening the page is all a
  // viewer can do; count that instead.
  useEffect(() => {
    if (dub.simulatedDub || !dub.mediaUrl) count();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dub.id]);

  if (dub.simulatedDub || !dub.mediaUrl) {
    return (
      <section
        className="panel"
        style={{
          aspectRatio: '16 / 9',
          display: 'grid',
          placeItems: 'center',
          textAlign: 'center',
          background: 'linear-gradient(135deg, color-mix(in srgb, var(--teal) 22%, var(--paper-sunk)), var(--paper-sunk))',
        }}
      >
        <div className="stack" style={{ ['--stack' as string]: '0.4rem', maxWidth: '26rem' }}>
          <div style={{ fontSize: '2.2rem' }} aria-hidden>
            {dub.flag}
          </div>
          <strong>This is a stand-in, not a real dub</strong>
          <p className="note">
            The demo posts have no footage behind them, so there is nothing to play here. A video you upload yourself is dubbed
            for real.
          </p>
        </div>
      </section>
    );
  }

  return (
    <div style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--rule)', background: '#000' }}>
      {dub.mediaKind === 'video' ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={dub.mediaUrl} controls playsInline preload="metadata" onPlay={count} style={{ width: '100%', display: 'block', maxHeight: '70vh' }} />
      ) : (
        <div style={{ padding: '2rem 1.25rem', background: 'var(--paper-sunk)' }}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <audio src={dub.mediaUrl} controls preload="metadata" onPlay={count} style={{ width: '100%' }} />
        </div>
      )}
    </div>
  );
}
