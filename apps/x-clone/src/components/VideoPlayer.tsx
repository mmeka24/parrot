'use client';

import { useRef, useState } from 'react';
import { X_TESTID } from '@parrot/shared';
import { recordView } from '@/lib/api';
import { formatClock, hueFor } from '@/lib/format';
import { PauseIcon, PlayIcon } from './icons';

/**
 * A post's video.
 *
 * A clip someone uploaded plays for real. The seeded demo posts have a length
 * and an audience but no media behind them, so they get a placeholder that
 * says so on its face instead of a fake video pretending to be footage.
 */
export function VideoPlayer({
  postId,
  durationS,
  url,
  placeholderLabel = 'Sample clip · no footage',
  onViewed,
}: {
  postId: string;
  durationS: number;
  url: string | null;
  placeholderLabel?: string;
  /** Called with the post's new view count the first time it is played. */
  onViewed?: (views: number) => void;
}) {
  // A view is counted once per page load, when the video is first played.
  const counted = useRef(false);
  const count = (): void => {
    if (counted.current) return;
    counted.current = true;
    recordView(postId)
      .then((result) => onViewed?.(result.views))
      .catch(() => {
        counted.current = false;
      });
  };

  return (
    <div
      data-testid={X_TESTID.videoPlayer}
      className="relative mt-3 aspect-video overflow-hidden rounded-2xl border border-rule bg-black"
    >
      {url ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          onPlay={count}
          className="h-full w-full object-contain"
        />
      ) : (
        <PlaceholderClip postId={postId} durationS={durationS} label={placeholderLabel} onPlay={count} />
      )}
    </div>
  );
}

function PlaceholderClip({
  postId,
  durationS,
  label,
  onPlay,
}: {
  postId: string;
  durationS: number;
  label: string;
  onPlay: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const hue = hueFor(postId);

  return (
    <div
      className="relative h-full w-full"
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 45% 22%), hsl(${(hue + 50) % 360} 55% 12%))`,
      }}
    >
      <span className="absolute left-3 top-3 rounded bg-black/60 px-1.5 py-0.5 text-[12px] font-medium text-white">
        {label}
      </span>

      <button
        type="button"
        onClick={() => {
          if (!playing) onPlay();
          setPlaying((p) => !p);
        }}
        aria-label={playing ? 'Pause' : 'Play'}
        className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-accent text-on-accent transition-colors hover:bg-accent-hover"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <span className="tabular absolute bottom-3 left-3 rounded bg-black/70 px-1.5 py-0.5 text-[13px] text-white">
        {formatClock(durationS)}
      </span>

      <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
        {playing ? (
          <div
            className="h-full origin-left bg-accent"
            style={{ animation: `clip-progress ${durationS}s linear forwards` }}
            onAnimationEnd={() => setPlaying(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
