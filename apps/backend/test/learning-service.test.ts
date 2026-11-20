import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  COLD_START_CONVERSION,
  DEFAULT_SPLIT_AGENT_BPS,
  DEFAULT_SPLIT_CREATOR_BPS,
  funnelEstimate,
  micros,
} from '@parrot/shared';
import { Store } from '../src/store/store.js';
import { LearningService } from '../src/services/learning-service.js';
import { resetConfig } from '../src/config.js';
import type { Job } from '../src/store/types.js';

const VIRAL = {
  likes: 18_000,
  replies: 640,
  reposts: 2_900,
  quotes: 210,
  sourceViews: 1_200_000,
  authorFollowers: 50_000,
  ageHours: 2,
};

beforeEach(() => {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  process.env.DEMO_MODE = 'true';
  resetConfig();
});

afterEach(() => {
  delete process.env.DEMO_MODE;
  resetConfig();
});

/** A published job whose window has elapsed, with an agent's prediction on file. */
function publishedJob(store: Store, predictedViews: number): Job {
  const account = store.createAccount({ kind: 'creator', label: '@maria', email: null, walletAddress: null });
  const creator = store.createCreator({
    xUserId: 'x-1',
    handle: 'maria',
    displayName: 'Maria',
    accountId: account.id,
    followers: 50_000,
    claimed: false,
  });
  const job = store.createJob({
    creatorId: creator.id,
    sourceUrl: 'https://x.com/maria/status/1',
    sourcePostId: '1',
    requestMentionId: null,
    targetLang: 'es',
    durationS: 30,
    category: 'comedy',
    state: 'PUBLISHED',
    claimedByAgentId: null,
    claimedAt: null,
    splitAgentBps: DEFAULT_SPLIT_AGENT_BPS,
    splitCreatorBps: DEFAULT_SPLIT_CREATOR_BPS,
    dubCost: 0n,
    decision: null,
    qcReport: null,
    providerJobId: null,
    dubUrl: null,
    previewUrl: null,
    posterUrl: null,
    declineReason: null,
    failureReason: null,
    signals: VIRAL,
    viewCount: 24,
    qcDemoFail: false,
    publishedAt: new Date(Date.now() - 5 * 60_000),
  });
  store.createPrediction({
    jobId: job.id,
    category: 'comedy',
    lang: 'es',
    predictedViews,
    predictedConvPpm: COLD_START_CONVERSION,
    confidencePpm: 250_000,
    engagementScore: 0,
    basis: 'cold_start',
    actualViews: null,
    actualUnlocks: null,
    actualConvPpm: null,
    errorRatio: null,
    simulated: false,
    resolvedAt: null,
  });
  // Three early unlocks: a sliver of a "day" of traffic.
  for (let i = 0; i < 3; i++) {
    store.createUnlock({
      jobId: job.id,
      viewerAccountId: `viewer-${i}`,
      amount: micros(20_000n),
      agentShare: micros(8_000n),
      creatorShare: micros(12_000n),
      paymentRef: null,
      simulated: true,
      settledAt: null,
    });
  }
  return job;
}

describe('demo-mode learning', () => {
  it('scores against a simulated full day, not the few views seen so far', () => {
    const store = new Store();
    const likely = funnelEstimate(VIRAL, 'es').viewers.likely;
    const job = publishedJob(store, likely);

    const [result] = new LearningService(store).runOnce();

    expect(result?.simulated).toBe(true);
    // Not the 24 views on the job: somewhere in the simulated band around likely.
    expect(result?.actualViews).toBeGreaterThan(likely * 0.5);
    expect(result?.actualViews).toBeLessThan(likely * 1.4);
    expect(Math.abs(result?.errorRatio ?? 99)).toBeLessThan(1);
    expect(store.getPrediction(job.id)?.resolvedAt).not.toBeNull();
  });

  it('learns a sane unlock rate rather than 3 unlocks over thousands of views', () => {
    const store = new Store();
    publishedJob(store, funnelEstimate(VIRAL, 'es').viewers.likely);
    new LearningService(store).runOnce();

    const bucket = store.getBucket('comedy', 'es');
    // Cold start is 12.5%; simulated conversion noise is 0.7x-1.3x of it.
    expect(bucket?.conversionPpm).toBeGreaterThan(80_000);
    expect(bucket?.conversionPpm).toBeLessThan(170_000);
  });

  it('proves an over-optimistic agent wrong instead of agreeing with it', () => {
    const store = new Store();
    const { high, likely } = funnelEstimate(VIRAL, 'es').viewers;
    publishedJob(store, high);

    const [result] = new LearningService(store).runOnce();

    // The world is centred on the likely case, so the high-end bet overshoots.
    expect(high).toBeGreaterThan(likely * 3);
    expect(result?.errorRatio ?? 0).toBeGreaterThan(1);
  });
});
