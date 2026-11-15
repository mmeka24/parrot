/**
 * The job pipeline - the spine that walks a request through the state machine.
 *
 *   REQUESTED -> PARSED -> EVALUATING -> (DECLINED | APPROVED)
 *             -> DUBBING -> QC -> (REJECTED_BY_QC | PUBLISHED) -> EARNING <-> SETTLED
 *
 * Every state change goes through `advance()`, which runs the typed reducer and
 * appends an append-only event row. Nothing else in the codebase is allowed to
 * assign `job.state` directly, so the event log is guaranteed to be a complete
 * history of what happened - which is exactly what the dashboard timeline and
 * the bot's replies are built from.
 *
 * The QC loss path is a first-class outcome here, not an error: a dub that
 * fails QC is NOT published, the agent eats the cost, its p_success drops, and
 * the creator is told the truth. That path is deliberately easy to trigger in
 * the demo.
 */

import {
  transition,
  isPublished,
  PREVIEW_SECONDS,
  DEFAULT_SPLIT_AGENT_BPS,
  DEFAULT_SPLIT_CREATOR_BPS,
  MAX_SOURCE_DURATION_S,
  MIN_SOURCE_DURATION_S,
  languageByCode,
  engagementScore,
  micros,
  type JobState,
  type JobEventType,
  type DeclineReason,
  type FailureReason,
  type Category,
  type QcReport,
} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { Job, Agent } from '../store/types.js';
import { DecisionService, estimateDubCost } from './decision-service.js';
import { PaymentService } from './payment-service.js';

export interface PipelineHooks {
  /** Called after every accepted transition, for SSE and bot replies. */
  onTransition?: (job: Job, event: JobEventType) => void | Promise<void>;
}

/** What the pipeline needs in order to actually produce a dub. */
export interface DubbingPort {
  createDub(input: {
    sourceUrl: string;
    targetLang: string;
    durationS: number;
  }): Promise<{ providerJobId: string; simulated: boolean }>;
  pollUntilReady(providerJobId: string): Promise<void>;
  downloadDub(
    providerJobId: string,
    languageCode: string,
  ): Promise<{ localPath: string; durationS: number; simulated: boolean }>;
}

/** What the pipeline needs in order to judge a dub. */
export interface QcPort {
  run(input: {
    dubPath: string;
    sourceDurationS: number;
    dubDurationS: number;
    targetLang: string;
  }): Promise<QcReport>;
}

export interface CreateJobInput {
  creatorId: string;
  sourceUrl: string;
  sourcePostId: string;
  requestMentionId: string | null;
  targetLang: string;
  durationS: number;
  category: Category;
  signals: Job['signals'];
}

export type IntakeResult =
  | { kind: 'created'; job: Job }
  | { kind: 'duplicate'; job: Job }
  | { kind: 'rejected'; reason: DeclineReason };

export class JobPipeline {
  constructor(
    private readonly store: Store,
    private readonly decisions: DecisionService,
    private readonly payments: PaymentService,
    private readonly dubbing: DubbingPort,
    private readonly qc: QcPort,
    private readonly hooks: PipelineHooks = {},
  ) {}

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  /**
   * The ONLY way a job changes state. Runs the reducer (which throws on an
   * illegal transition), writes the event row, then fires hooks.
   */
  private async advance(
    job: Job,
    event: JobEventType,
    patch: Partial<Job> = {},
    payload: Record<string, unknown> | null = null,
  ): Promise<Job> {
    const from: JobState = job.state;
    const to = transition(from, event);

    const updated = this.store.updateJob(job.id, { ...patch, state: to });
    this.store.appendEvent({
      jobId: job.id,
      type: event,
      fromState: from,
      toState: to,
      payload,
      txHash: null,
    });

    await this.hooks.onTransition?.(updated, event);
    return updated;
  }

  private async fail(job: Job, reason: FailureReason, detail?: string): Promise<Job> {
    return this.advance(job, 'FAILED', { failureReason: reason }, { reason, detail: detail ?? null });
  }

  // -------------------------------------------------------------------------
  // Intake
  // -------------------------------------------------------------------------

  /**
   * Create a job from a validated request.
   *
   * Dedupe rule: one dub per (source video, target language). A repeat request
   * returns the existing link instantly instead of paying to dub it twice -
   * the requester becomes a co-promoter rather than a second customer.
   */
  intake(input: CreateJobInput): IntakeResult {
    const existing = this.store.findJobBySourceAndLang(input.sourcePostId, input.targetLang);
    if (existing) return { kind: 'duplicate', job: existing };

    if (!languageByCode(input.targetLang)) {
      return { kind: 'rejected', reason: 'UNSUPPORTED_LANGUAGE' };
    }
    if (input.durationS > MAX_SOURCE_DURATION_S) {
      return { kind: 'rejected', reason: 'TOO_LONG' };
    }
    if (input.durationS < MIN_SOURCE_DURATION_S) {
      return { kind: 'rejected', reason: 'NO_VIDEO' };
    }

    const job = this.store.createJob({
      creatorId: input.creatorId,
      sourceUrl: input.sourceUrl,
      sourcePostId: input.sourcePostId,
      requestMentionId: input.requestMentionId,
      targetLang: input.targetLang,
      durationS: input.durationS,
      category: input.category,
      state: 'REQUESTED',
      claimedByAgentId: null,
      claimedAt: null,
      splitAgentBps: DEFAULT_SPLIT_AGENT_BPS,
      splitCreatorBps: DEFAULT_SPLIT_CREATOR_BPS,
      dubCost: micros(0n),
      decision: null,
      qcReport: null,
      providerJobId: null,
      dubUrl: null,
      previewUrl: null,
      posterUrl: null,
      declineReason: null,
      failureReason: null,
      signals: input.signals,
      viewCount: 0,
      publishedAt: null,
    });

    this.store.appendEvent({
      jobId: job.id,
      type: 'PARSED',
      fromState: null,
      toState: 'REQUESTED',
      payload: { sourceUrl: input.sourceUrl, targetLang: input.targetLang },
      txHash: null,
    });

    return { kind: 'created', job };
  }

  // -------------------------------------------------------------------------
  // The main run
  // -------------------------------------------------------------------------

  /**
   * Drive a job from REQUESTED to a terminal-ish state.
   *
   * Returns the final job. Never throws for an expected outcome (declined,
   * QC-rejected); those are states, not errors. Genuine faults become FAILED
   * with a reason the bot can explain.
   */
  async run(jobId: string): Promise<Job> {
    let job = this.store.getJob(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);

    try {
      if (job.state === 'REQUESTED') job = await this.advance(job, 'PARSED');
      if (job.state === 'PARSED') job = await this.advance(job, 'EVALUATION_STARTED');

      if (job.state === 'EVALUATING') {
        const outcome = this.decisions.runAuction(job);

        // Record every agent's reasoning, winners and losers alike. The losing
        // bids are half the story on the dashboard.
        for (const bid of outcome.bids) {
          this.store.appendEvent({
            jobId: job.id,
            type: bid.approved ? 'APPROVED' : 'DECLINED',
            fromState: 'EVALUATING',
            toState: null,
            payload: { decision: bid.decision as unknown as Record<string, unknown> },
            txHash: null,
          });
        }

        if (!outcome.winner || !outcome.winningDecision) {
          return this.advance(
            job,
            'DECLINED',
            { declineReason: outcome.declineReason },
            { reason: outcome.declineReason },
          );
        }

        const prediction = outcome.winningDecision;
        this.store.createPrediction({
          jobId: job.id,
          category: job.category,
          lang: job.targetLang,
          predictedViews: prediction.inputs.predictedViews,
          predictedConvPpm: prediction.inputs.conversionPpm,
          confidencePpm: prediction.result.confidencePpm,
          // Recomputed rather than stored, so it always matches the model the
          // learning loop will later compare against.
          engagementScore: job.signals ? engagementScore(job.signals) : 0,
          basis: prediction.result.basis,
          actualViews: null,
          actualUnlocks: null,
          actualConvPpm: null,
          errorRatio: null,
          simulated: false,
          resolvedAt: null,
        });
        this.store.seedBucketIfMissing(job.category, job.targetLang);

        job = await this.advance(
          job,
          'APPROVED',
          { decision: outcome.winningDecision },
          { agent: outcome.winner.name },
        );
      }

      if (job.state === 'APPROVED') {
        job = await this.produceDub(job);
      }

      if (job.state === 'QC') {
        job = await this.runQc(job);
      }

      return job;
    } catch (error: unknown) {
      const current = this.store.getJob(jobId);
      if (!current || ['DECLINED', 'REJECTED_BY_QC', 'FAILED'].includes(current.state)) {
        return current ?? job;
      }
      const detail = error instanceof Error ? error.message : String(error);
      return this.fail(current, 'INTERNAL_ERROR', detail);
    }
  }

  /** APPROVED -> DUBBING -> QC. The agent pays before it knows if it worked. */
  private async produceDub(job: Job): Promise<Job> {
    const agent = job.claimedByAgentId ? this.store.agents.get(job.claimedByAgentId) : undefined;
    if (!agent) return this.fail(job, 'INTERNAL_ERROR', 'approved job has no agent');

    const dubCost = estimateDubCost(job.durationS);

    job = await this.advance(job, 'DUBBING_STARTED', { dubCost }, { costMicros: dubCost.toString() });

    // The agent fronts the cost HERE, before knowing whether the dub will pass
    // QC. That is the risk that makes it an economic actor.
    await this.payments.chargeDubCost({
      agentAccountId: agent.accountId,
      jobId: job.id,
      amount: dubCost,
    });

    let created: { providerJobId: string; simulated: boolean };
    try {
      created = await this.dubbing.createDub({
        sourceUrl: job.sourceUrl,
        targetLang: job.targetLang,
        durationS: job.durationS,
      });
    } catch (error: unknown) {
      return this.fail(
        this.store.getJob(job.id) as Job,
        'DUBBING_PROVIDER_ERROR',
        error instanceof Error ? error.message : String(error),
      );
    }

    try {
      await this.dubbing.pollUntilReady(created.providerJobId);
    } catch (error: unknown) {
      return this.fail(
        this.store.getJob(job.id) as Job,
        'DUBBING_TIMEOUT',
        error instanceof Error ? error.message : String(error),
      );
    }

    const downloaded = await this.dubbing.downloadDub(created.providerJobId, job.targetLang);

    return this.advance(
      this.store.getJob(job.id) as Job,
      'DUB_RENDERED',
      {
        providerJobId: created.providerJobId,
        dubUrl: downloaded.localPath,
        previewUrl: downloaded.localPath,
      },
      { simulated: created.simulated || downloaded.simulated, durationS: downloaded.durationS },
    );
  }

  /** QC -> PUBLISHED or REJECTED_BY_QC. The loss path is a real outcome. */
  private async runQc(job: Job): Promise<Job> {
    const dubPath = job.dubUrl;
    if (!dubPath) return this.fail(job, 'STORAGE_ERROR', 'no rendered dub to check');

    const report = await this.qc.run({
      dubPath,
      sourceDurationS: job.durationS,
      dubDurationS: job.durationS,
      targetLang: job.targetLang,
    });

    if (!report.passed) {
      // Not published, cost already booked as a loss, p_success falls, and the
      // creator is told the truth rather than handed a bad dub.
      return this.advance(
        job,
        'QC_FAILED',
        { qcReport: report },
        { failed: report.checks.filter((c) => !c.passed).map((c) => c.name) },
      );
    }

    return this.advance(
      job,
      'QC_PASSED',
      { qcReport: report, publishedAt: new Date() },
      { previewSeconds: PREVIEW_SECONDS },
    );
  }

  // -------------------------------------------------------------------------
  // Earning
  // -------------------------------------------------------------------------

  /** Move a published job to EARNING on its first unlock. Idempotent. */
  async notePaidUnlock(jobId: string): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);

    if (job.state === 'PUBLISHED') return this.advance(job, 'FIRST_UNLOCK');
    if (job.state === 'SETTLED') return this.advance(job, 'UNLOCKED_AFTER_SETTLEMENT');
    return job;
  }

  /** Mark a job settled after a payout run. */
  async noteSettled(jobId: string, txHash: string | null): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    if (job.state !== 'EARNING') return job;

    const from = job.state;
    const to = transition(from, 'SETTLED');
    const updated = this.store.updateJob(job.id, { state: to });
    this.store.appendEvent({
      jobId: job.id,
      type: 'SETTLED',
      fromState: from,
      toState: to,
      payload: null,
      txHash,
    });
    await this.hooks.onTransition?.(updated, 'SETTLED');
    return updated;
  }

  /** Can this job's media be served? */
  canServe(job: Job): boolean {
    return isPublished(job.state);
  }
}
