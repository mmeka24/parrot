/**
 * The learning loop.
 *
 * 24 hours after a dub publishes (one minute, in demo mode), compare what the
 * agent predicted against what actually happened and fold the error back into
 * the (category, language) bucket with exponential smoothing.
 *
 * This is what makes the decision loop defensible rather than decorative: the
 * cold-start prior is openly a guess, and this is the mechanism that corrects
 * it. The dashboard shows prediction error over time so the correction is
 * visible rather than claimed.
 *
 * In demo mode the realised outcome is SIMULATED, and every record it writes is
 * flagged `simulated: true` so the UI can label it. We never present a
 * simulated outcome as an observed one.
 */

import {
  updateBucket,
  predictionError,
  meanAbsolutePercentageError,
  engagementScore,
  clampPpm,
  DEMO_LEARNING_DELAY_MS,
  REAL_LEARNING_DELAY_MS,
  type BucketStats,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { Job } from '../store/types.js';
import { getConfig } from '../config.js';

export interface ResolveResult {
  jobId: string;
  predictedViews: number;
  actualViews: number;
  actualUnlocks: number;
  errorRatio: number;
  simulated: boolean;
}

export class LearningService {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: Store) {}

  private get delayMs(): number {
    return getConfig().isDemoMode ? DEMO_LEARNING_DELAY_MS : REAL_LEARNING_DELAY_MS;
  }

  /**
   * Resolve one job's prediction against reality.
   *
   * Idempotent: a prediction that already has `resolvedAt` is left alone, so a
   * re-run cannot smooth the same observation into a bucket twice and quietly
   * bias it.
   */
  resolve(jobId: string, options: { simulatedViews?: number } = {}): ResolveResult | null {
    const job = this.store.getJob(jobId);
    const prediction = this.store.getPrediction(jobId);
    if (!job || !prediction || prediction.resolvedAt !== null) return null;

    const unlocks = this.store.unlocksForJob(jobId);
    const actualUnlocks = unlocks.length;

    // Realised views. In demo mode we simulate them (clearly flagged); in a
    // real deployment this is where the X API view count would be read.
    const simulated = options.simulatedViews !== undefined || getConfig().isDemoMode;
    const actualViews =
      options.simulatedViews ??
      (job.viewCount > 0 ? job.viewCount : Math.max(actualUnlocks * 8, actualUnlocks));

    const actualConvPpm =
      actualViews > 0
        ? clampPpm(Math.round((actualUnlocks / actualViews) * 1_000_000))
        : prediction.predictedConvPpm;

    const errorRatio = predictionError(prediction.predictedViews, actualViews);

    this.store.updatePrediction(jobId, {
      actualViews,
      actualUnlocks,
      actualConvPpm,
      errorRatio,
      simulated,
      resolvedAt: new Date(),
    });

    // Fold the outcome into the bucket.
    const existing = this.store.getBucket(job.category, job.targetLang);
    const asStats: BucketStats | undefined = existing
      ? {
          category: existing.category,
          lang: existing.lang,
          avgViews: existing.avgViews,
          avgEngagementScore: existing.avgEngagementScore,
          conversionPpm: clampPpm(existing.conversionPpm),
          n: existing.n,
        }
      : undefined;

    const updated = updateBucket(
      asStats,
      {
        actualViews,
        actualUnlocks,
        engagementScore: job.signals ? engagementScore(job.signals) : 0,
      },
      { category: job.category, lang: job.targetLang },
    );

    this.store.upsertBucket({
      category: updated.category,
      lang: updated.lang,
      avgViews: updated.avgViews,
      avgEngagementScore: updated.avgEngagementScore,
      conversionPpm: updated.conversionPpm,
      n: updated.n,
      updatedAt: new Date(),
    });

    return {
      jobId,
      predictedViews: prediction.predictedViews,
      actualViews,
      actualUnlocks,
      errorRatio,
      simulated,
    };
  }

  /** Resolve every prediction whose waiting period has elapsed. */
  runOnce(): ResolveResult[] {
    const cutoff = Date.now() - this.delayMs;
    const results: ResolveResult[] = [];

    for (const prediction of this.store.predictions.values()) {
      if (prediction.resolvedAt !== null) continue;
      const job = this.store.getJob(prediction.jobId);
      if (!job || job.publishedAt === null) continue;
      if (job.publishedAt.getTime() > cutoff) continue;

      // Do not resolve a prediction against an empty world.
      //
      // In demo mode the window is 60s, which can elapse before anyone has
      // watched anything. Scoring that as "predicted 1,935, actual 0, 100%
      // wrong" would be measuring our own demo timing, not the agent's
      // judgement, and it makes a sound prediction look catastrophic. With no
      // views AND no unlocks there is simply nothing to learn yet, so we wait.
      const hasData = job.viewCount > 0 || this.store.unlocksForJob(job.id).length > 0;
      if (!hasData) continue;

      const result = this.resolve(prediction.jobId);
      if (result) results.push(result);
    }

    return results;
  }

  /**
   * Mean absolute percentage error of every resolved prediction: how far off
   * the view forecasts were. LOWER is better; 0 is perfect. Not an accuracy.
   */
  predictionErrorPercent(): number | null {
    const samples = this.store
      .resolvedPredictions()
      .map((p) => ({ predicted: p.predictedViews, actual: p.actualViews ?? 0 }));
    return meanAbsolutePercentageError(samples);
  }

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.runOnce();
      } catch {
        // A learning pass failing must never take the service down; the next
        // tick retries, and an unresolved prediction is harmless.
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Simulate realised views for a job, for the compressed demo timeline. */
  simulateOutcome(job: Job, multiplier = 1): ResolveResult | null {
    const prediction = this.store.getPrediction(job.id);
    if (!prediction) return null;
    // Deliberately imperfect: the demo is more honest, and more interesting,
    // when the agent is sometimes wrong.
    const noise = 0.55 + Math.random() * 0.8;
    const actualViews = Math.max(1, Math.round(prediction.predictedViews * noise * multiplier));
    return this.resolve(job.id, { simulatedViews: actualViews });
  }
}
