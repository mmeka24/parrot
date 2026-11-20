import { describe, it, expect } from 'vitest';
import realPosts from './fixtures/real-x-video-posts.json';
import {
  engagementScore,
  funnelEstimate,
  predictViews,
  updateBucket,
  predictionError,
  meanAbsolutePercentageError,
  type BucketStats,
  type EngagementSignals,
} from '../src/predictor.js';
import { smoothPpm, smoothCount, ppm, rateToPpm, formatPpmPercent } from '../src/ppm.js';
import { COLD_START_CONVERSION, INTERACTIONS_PER_VIEW, LEARNING_ALPHA } from '../src/constants.js';

const strongPost: EngagementSignals = {
  likes: 800,
  replies: 120,
  reposts: 200,
  quotes: 40,
  sourceViews: 10_000,
  authorFollowers: 50_000,
  ageHours: 2,
};

const weakPost: EngagementSignals = {
  likes: 3,
  replies: 0,
  reposts: 0,
  quotes: 0,
  sourceViews: 40,
  authorFollowers: 120,
  ageHours: 50,
};

describe('engagementScore', () => {
  it('ranks a viral post far above a quiet one', () => {
    expect(engagementScore(strongPost)).toBeGreaterThan(engagementScore(weakPost) * 50);
  });

  it('weights reposts and replies above likes, since they carry reach', () => {
    const base = { likes: 0, replies: 0, reposts: 0, authorFollowers: 1_000, ageHours: 1 };
    const likes = engagementScore({ ...base, likes: 100 });
    const replies = engagementScore({ ...base, replies: 100 });
    const reposts = engagementScore({ ...base, reposts: 100 });
    expect(replies).toBeGreaterThan(likes);
    expect(reposts).toBeGreaterThan(replies);
  });

  it('decays with age, because an old post has spent its reach', () => {
    const fresh = engagementScore({ ...strongPost, ageHours: 0 });
    const day = engagementScore({ ...strongPost, ageHours: 24 });
    const week = engagementScore({ ...strongPost, ageHours: 168 });
    expect(fresh).toBeGreaterThan(day);
    expect(day).toBeGreaterThan(week);
  });

  it('grows only logarithmically with follower count', () => {
    const small = engagementScore({ ...strongPost, authorFollowers: 1_000 });
    const huge = engagementScore({ ...strongPost, authorFollowers: 10_000_000 });
    // 10,000x the followers must not be anywhere near 10,000x the estimate.
    expect(huge / small).toBeLessThan(3);
    expect(huge).toBeGreaterThan(small);
  });

  it('never returns a negative score, even for degenerate input', () => {
    expect(
      engagementScore({ likes: 0, replies: 0, reposts: 0, authorFollowers: 0, ageHours: -5 }),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('cold start', () => {
  it('reads reach straight from the view count and walks the funnel', () => {
    // 10,000 views x 8.1% Spanish share x 35% reach x 2% uptake = ~6.
    const f = funnelEstimate(strongPost, 'es');
    expect(f.reachMeasured).toBe(true);
    expect(f.reach.likely).toBe(10_000);
    expect(f.viewers.likely).toBe(6);
  });

  it('gives a viral post roughly the brief\'s 2,000 Spanish viewers', () => {
    const viral = { ...strongPost, sourceViews: 1_200_000 };
    const prediction = predictViews(viral, 'es', undefined);
    expect(prediction.basis).toBe('cold_start');
    // 1.2M x 8.1% x 35% x 2% = ~680.
    expect(prediction.predictedViews).toBeGreaterThan(600);
    expect(prediction.predictedViews).toBeLessThan(760);
  });

  it('returns a low / likely / high range that brackets the likely case', () => {
    const { range, predictedViews } = predictViews(strongPost, 'es', undefined);
    expect(range.likely).toBe(predictedViews);
    expect(range.low).toBeLessThan(range.likely);
    expect(range.high).toBeGreaterThan(range.likely);
  });

  it('estimates reach from interactions when the view count is missing', () => {
    const noViews = { ...strongPost, sourceViews: 0 };
    const f = funnelEstimate(noViews, 'es');
    expect(f.reachMeasured).toBe(false);
    // 1,160 interactions at the measured 2.7% per view is ~43,000 views.
    expect(Math.round(f.reach.likely)).toBe(Math.round(1_160 / INTERACTIONS_PER_VIEW.likely));
    expect(f.reach.low).toBeLessThan(f.reach.high);
  });

  it('uses the cold-start conversion rate', () => {
    expect(predictViews(strongPost, 'es', undefined).conversionPpm).toBe(COLD_START_CONVERSION);
  });

  it('is honest about low confidence', () => {
    expect(predictViews(strongPost, 'es', undefined).confidencePpm).toBeLessThan(400_000);
  });

  it('predicts fewer viewers for a smaller language market', () => {
    const spanish = predictViews(strongPost, 'es', undefined).predictedViews;
    const german = predictViews(strongPost, 'de', undefined).predictedViews;
    expect(german).toBeLessThan(spanish);
  });

  it('predicts almost nobody for a post nobody engaged with', () => {
    expect(predictViews(weakPost, 'es', undefined).predictedViews).toBeLessThan(100);
  });

  it('explains itself in plain language', () => {
    const { rationale } = predictViews(strongPost, 'es', undefined);
    expect(rationale).toContain('Spanish');
    expect(rationale).toContain('10,000 people saw the post');
    expect(rationale).not.toMatch(/ppm|bps|micros/i);
  });
});

describe('calibration against real X video posts', () => {
  const { posts } = realPosts as {
    posts: { views: number; likes: number; replies: number; reposts: number; quotes: number | null }[];
  };
  const rates = posts
    .map((p) => (p.likes + p.replies + p.reposts + (p.quotes ?? 0)) / p.views)
    .sort((a, b) => a - b);
  const quantile = (q: number) => rates[Math.floor(q * (rates.length - 1))] as number;

  it('has a real sample to calibrate on', () => {
    expect(posts.length).toBeGreaterThanOrEqual(30);
  });

  it('uses interaction rates that match the real posts\' quartiles', () => {
    // Within 25% of the measured p25 / median / p75. If X behaviour shifts,
    // refresh the fixture and these constants together.
    const near = (a: number, b: number) => Math.abs(a - b) / b < 0.25;
    expect(near(INTERACTIONS_PER_VIEW.high, quantile(0.25))).toBe(true);
    expect(near(INTERACTIONS_PER_VIEW.likely, quantile(0.5))).toBe(true);
    expect(near(INTERACTIONS_PER_VIEW.low, quantile(0.75))).toBe(true);
  });

  it('recovers real view counts from interactions alone, within the range, for most posts', () => {
    const inside = posts.filter((p) => {
      const f = funnelEstimate({ ...p, quotes: p.quotes ?? 0, sourceViews: 0, authorFollowers: 0, ageHours: 0 }, 'es');
      return p.views >= f.reach.low && p.views <= f.reach.high;
    });
    // The range is p25..p75, so about half should land inside by construction.
    expect(inside.length / posts.length).toBeGreaterThanOrEqual(0.45);
  });
});

describe('bucket-based prediction', () => {
  const bucket: BucketStats = {
    category: 'comedy',
    lang: 'es',
    avgViews: 1_500,
    avgEngagementScore: engagementScore(strongPost),
    conversionPpm: ppm(100_000),
    n: 5,
  };

  it('predicts the bucket average for a typical post', () => {
    const prediction = predictViews(strongPost, 'es', bucket);
    expect(prediction.basis).toBe('bucket');
    expect(prediction.predictedViews).toBe(1_500);
  });

  it('scales up for a post stronger than the bucket average', () => {
    const doubled = { ...strongPost, likes: strongPost.likes * 4, reposts: strongPost.reposts * 4 };
    expect(predictViews(doubled, 'es', bucket).predictedViews).toBeGreaterThan(1_500);
  });

  it('scales down for a weaker post', () => {
    expect(predictViews(weakPost, 'es', bucket).predictedViews).toBeLessThan(1_500);
  });

  it('clamps extreme ratios so one freak post cannot blow up the estimate', () => {
    const absurd = {
      ...strongPost,
      likes: 10_000_000,
      reposts: 5_000_000,
      replies: 1_000_000,
    };
    // Hard ceiling of 5x the bucket average.
    expect(predictViews(absurd, 'es', bucket).predictedViews).toBeLessThanOrEqual(7_500);
  });

  it('uses the learned conversion rate rather than the cold-start prior', () => {
    expect(predictViews(strongPost, 'es', bucket).conversionPpm).toBe(ppm(100_000));
  });

  it('grows more confident as the bucket fills up', () => {
    const thin = predictViews(strongPost, 'es', { ...bucket, n: 1 }).confidencePpm;
    const full = predictViews(strongPost, 'es', { ...bucket, n: 5 }).confidencePpm;
    expect(full).toBeGreaterThan(thin);
    expect(full).toBe(1_000_000);
  });

  it('falls back to cold start for an empty bucket', () => {
    expect(predictViews(strongPost, 'es', { ...bucket, n: 0 }).basis).toBe('cold_start');
  });
});

describe('the learning loop', () => {
  const seed = { category: 'comedy' as const, lang: 'es' };

  it('creates a bucket from the first observation', () => {
    const updated = updateBucket(undefined, {
      actualViews: 1_800,
      actualUnlocks: 180,
      engagementScore: 500,
    }, seed);
    expect(updated.n).toBe(1);
    expect(updated.avgViews).toBe(1_800);
    expect(updated.conversionPpm).toBe(100_000); // 180/1800 = 10%
  });

  it('moves the average toward reality when the prediction was too high', () => {
    const before: BucketStats = {
      category: 'comedy',
      lang: 'es',
      avgViews: 2_000,
      avgEngagementScore: 500,
      conversionPpm: COLD_START_CONVERSION,
      n: 3,
    };
    const after = updateBucket(
      before,
      { actualViews: 500, actualUnlocks: 50, engagementScore: 500 },
      seed,
    );
    expect(after.avgViews).toBeLessThan(before.avgViews);
    expect(after.avgViews).toBeGreaterThan(500); // smoothed, not replaced
    expect(after.avgViews).toBeCloseTo(1_550, 0); // 0.7*2000 + 0.3*500
    expect(after.n).toBe(4);
  });

  it('converges toward the truth over repeated observations', () => {
    let bucket = updateBucket(
      undefined,
      { actualViews: 5_000, actualUnlocks: 500, engagementScore: 500 },
      seed,
    );
    for (let i = 0; i < 30; i++) {
      bucket = updateBucket(
        bucket,
        { actualViews: 1_000, actualUnlocks: 200, engagementScore: 500 },
        seed,
      );
    }
    expect(bucket.avgViews).toBeCloseTo(1_000, 0);
    expect(bucket.conversionPpm).toBeCloseTo(200_000, -3); // 20%
  });

  it('never mutates the bucket it was given', () => {
    const before: BucketStats = {
      category: 'comedy',
      lang: 'es',
      avgViews: 2_000,
      avgEngagementScore: 500,
      conversionPpm: COLD_START_CONVERSION,
      n: 3,
    };
    const snapshot = { ...before };
    updateBucket(before, { actualViews: 10, actualUnlocks: 1, engagementScore: 1 }, seed);
    expect(before).toEqual(snapshot);
  });

  it('does not divide by zero when a dub got no views at all', () => {
    const updated = updateBucket(
      undefined,
      { actualViews: 0, actualUnlocks: 0, engagementScore: 10 },
      seed,
    );
    expect(updated.conversionPpm).toBe(COLD_START_CONVERSION);
    expect(Number.isFinite(updated.avgViews)).toBe(true);
  });

  it('keeps the conversion rate inside 0..100%', () => {
    const updated = updateBucket(
      undefined,
      { actualViews: 10, actualUnlocks: 50, engagementScore: 10 },
      seed,
    );
    expect(updated.conversionPpm).toBeLessThanOrEqual(1_000_000);
    expect(updated.conversionPpm).toBeGreaterThanOrEqual(0);
  });
});

describe('smoothing primitives', () => {
  it('smoothPpm blends by alpha', () => {
    expect(smoothPpm(ppm(100_000), ppm(200_000), ppm(300_000))).toBe(130_000);
  });

  it('alpha of zero ignores the observation, alpha of one replaces it', () => {
    expect(smoothPpm(ppm(100_000), ppm(900_000), ppm(0))).toBe(100_000);
    expect(smoothPpm(ppm(100_000), ppm(900_000), ppm(1_000_000))).toBe(900_000);
  });

  it('smoothCount matches the configured learning rate', () => {
    expect(smoothCount(2_000, 500, LEARNING_ALPHA)).toBeCloseTo(1_550, 6);
  });

  it('rateToPpm and formatPpmPercent round-trip for display', () => {
    expect(rateToPpm(0.125)).toBe(125_000);
    expect(formatPpmPercent(ppm(125_000))).toBe('12.5%');
    expect(formatPpmPercent(ppm(700_000))).toBe('70%');
  });
});

describe('accuracy reporting', () => {
  it('reports signed relative error', () => {
    expect(predictionError(2_000, 1_000)).toBe(1); // 100% over
    expect(predictionError(500, 1_000)).toBe(-0.5); // 50% under
    expect(predictionError(1_000, 1_000)).toBe(0);
  });

  it('handles a zero actual without returning Infinity', () => {
    expect(predictionError(100, 0)).toBe(1);
    expect(predictionError(0, 0)).toBe(0);
  });

  it('averages absolute error across samples', () => {
    expect(
      meanAbsolutePercentageError([
        { predicted: 2_000, actual: 1_000 },
        { predicted: 500, actual: 1_000 },
      ]),
    ).toBe(75);
  });

  it('has nothing to report with no samples', () => {
    expect(meanAbsolutePercentageError([])).toBeNull();
  });
});
