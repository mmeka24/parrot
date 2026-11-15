'use client';

import { useId, useState } from 'react';
import type { AccuracyPointDto } from '@parrot/shared';
import { localCopy } from '@/lib/local-copy';
import { formatCount } from './ui';

/**
 * Hand-rolled dual-series line chart: predicted views against actual views.
 * Both series measure the same thing on the same scale, so there is one axis.
 * Identity is never colour-alone - the predicted series is dashed and both are
 * named in the legend and direct-labelled at the final point.
 */
export function AccuracyChart({ points }: { points: readonly AccuracyPointDto[] }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <p className="panel-sub">{localCopy.dashboard.emptyTickerBody}</p>
    );
  }

  const W = 640;
  const H = 240;
  const padL = 46;
  const padR = 58;
  const padT = 16;
  const padB = 28;

  const values = points.flatMap((p) => [p.predicted, p.actual]);
  const maxRaw = Math.max(...values);
  const max = Math.ceil(maxRaw / 500) * 500;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const x = (i: number) => padL + (plotW * i) / (points.length - 1);
  const y = (v: number) => padT + plotH - (plotH * v) / max;

  const line = (key: 'predicted' | 'actual') =>
    points.map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p[key]).toFixed(1)).join(' ');

  const ticks = [0, max / 2, max];
  const active = hover === null ? null : points[hover];
  const last = points[points.length - 1]!;

  return (
    <figure style={{ margin: 0 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.9rem',
          alignItems: 'center',
          marginBottom: '0.5rem',
          fontSize: '0.8rem',
          color: 'var(--ink-soft)',
        }}
      >
        <LegendSwatch color="var(--mango)" dashed label={localCopy.dashboard.predictedLegend} />
        <LegendSwatch color="var(--teal)" label={localCopy.dashboard.actualLegend} />
        {active ? (
          <span className="num" style={{ marginLeft: 'auto', color: 'var(--ink)' }}>
            {localCopy.dashboard.predictedLegend} {formatCount(active.predicted)} ·{' '}
            {localCopy.dashboard.actualLegend} {formatCount(active.actual)}
          </span>
        ) : null}
      </div>

      <svg
        viewBox={'0 0 ' + W + ' ' + H}
        width="100%"
        role="img"
        aria-labelledby={id + '-title'}
        style={{ display: 'block', overflow: 'visible' }}
        onMouseLeave={() => setHover(null)}
      >
        <title id={id + '-title'}>{localCopy.dashboard.accuracySubtitle}</title>

        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--rule)"
              strokeWidth={1}
            />
            <text
              x={padL - 8}
              y={y(t) + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--ink-faint)"
              className="num"
            >
              {formatCount(t)}
            </text>
          </g>
        ))}

        <path d={line('predicted')} fill="none" stroke="var(--mango)" strokeWidth={2} strokeDasharray="6 4" strokeLinecap="round" />
        <path d={line('actual')} fill="none" stroke="var(--teal)" strokeWidth={2} strokeLinecap="round" />

        {points.map((p, i) => (
          <g key={p.at}>
            <circle cx={x(i)} cy={y(p.predicted)} r={hover === i ? 5.5 : 4} fill="var(--paper-raised)" stroke="var(--mango)" strokeWidth={2} />
            <circle cx={x(i)} cy={y(p.actual)} r={hover === i ? 5.5 : 4} fill="var(--paper-raised)" stroke="var(--teal)" strokeWidth={2} />
            <rect
              x={x(i) - plotW / (points.length * 2)}
              y={padT}
              width={plotW / points.length}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              tabIndex={-1}
            />
          </g>
        ))}

        {hover !== null ? (
          <line
            x1={x(hover)}
            x2={x(hover)}
            y1={padT}
            y2={padT + plotH}
            stroke="var(--rule-strong)"
            strokeWidth={1}
          />
        ) : null}

        <text x={W - padR + 8} y={y(last.predicted) + 4} fontSize={11} fill="var(--ink-soft)">
          {localCopy.dashboard.predictedLegend}
        </text>
        <text x={W - padR + 8} y={y(last.actual) + 4} fontSize={11} fill="var(--ink-soft)">
          {localCopy.dashboard.actualLegend}
        </text>
      </svg>

      <figcaption className="sr-only">
        {points
          .map((p) => formatCount(p.predicted) + ' predicted, ' + formatCount(p.actual) + ' actual')
          .join('; ')}
      </figcaption>
    </figure>
  );
}

function LegendSwatch({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
      <svg width="22" height="8" aria-hidden>
        <line
          x1="1"
          y1="4"
          x2="21"
          y2="4"
          stroke={color}
          strokeWidth="2"
          strokeDasharray={dashed ? '5 3' : undefined}
          strokeLinecap="round"
        />
      </svg>
      {label}
    </span>
  );
}
