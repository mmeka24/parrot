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
import {
  DecisionService,
  estimateDubCost,
  dubProviderFor,
  HOUSE_DUB_PROVIDER,
  type DecisionOutcome,
} from './decision-service.js';
import { makePreview } from './preview.js';
import { dubExternally } from './external-dubbing.js';
import { PaymentService } from './payment-service.js';
import { agentPrivateKey, getConfig } from '../config.js';
import { recordAuctionOnchain, recordQcOnchain } from '../chain/splitter.js';
import { collectExternalBids } from './external-bids.js';

export interface PipelineHooks {
  /** Cuts the free preview of a dub. Defaults to ffmpeg; null means no preview. */
  previewMaker?: (fullPath: string) => Promise<string | null>;
  /** Called after every accepted transition, for SSE and bot replies. */
  onTransition?: (job: Job, event: JobEventType) => void | Promise<void>;
  /** Makes a dub with an agent's own provider. Tests inject a fake. */
  externalDubber?: (agent: Agent, job: Job) => Promise<{ localPath: string }>;
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
    /** Demo determinism: force this dub to fail the gate. */
    forceFail?: boolean;
    /** The original clip, for the meaning (back-translation) check. */
    sourceUrl?: string;
    /** Who made the dub, so the report can show the judge is someone else. */
    dubProvider?: string;
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
  qcDemoFail?: boolean;
}

export type IntakeResult =
  | { kind: 'created'; job: Job }
  | { kind: 'duplicate'; job: Job }
  | { kind: 'rejected'; reason: DeclineReason };

/** The real bring-your-own dubber: calls the agent's dubUrl. */
function defaultExternalDubber(agent: Agent, job: Job): Promise<{ localPath: string }> {
  const env = getConfig().env;
  return dubExternally(agent, job, {
    mediaDir: env.MEDIA_STORAGE_DIR,
    production: env.NODE_ENV === 'production',
  });
}

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
    txHash: string | null = null,
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
      txHash,
    });

    await this.hooks.onTransition?.(updated, event);
    return updated;
  }

  private async fail(job: Job, reason: FailureReason, detail?: string): Promise<Job> {
    // A failed job is otherwise silent: the viewer sees a generic apology and
    // the reason lives only in the job's event log. Say it where we can see it.
    console.error(`[pipeline] job ${job.id} failed: ${reason}${detail ? ` - ${detail}` : ''}`);
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
      qcDemoFail: input.qcDemoFail ?? false,
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
        // Third-party agents answer from their own servers; ask them first.
        const externalBids = await collectExternalBids(this.store, job);
        const outcome = this.decisions.runAuction(job, externalBids);

        // Record every agent's reasoning, winners and losers alike. The losing
        // bids are half the story on the dashboard.
        for (const bid of outcome.bids) {
          const won = outcome.winner?.id === bid.agent.id;
          this.store.appendEvent({
            jobId: job.id,
            type: bid.approved ? 'APPROVED' : 'DECLINED',
            fromState: 'EVALUATING',
            toState: null,
            payload: {
              // The winner's entry carries the auction result: its bid and the
              // share it is actually paid.
              decision: (won && outcome.winningDecision
                ? outcome.winningDecision
                : bid.decision) as unknown as Record<string, unknown>,
              // Several agents can approve; only one wins the claim. Recording
              // this is what stops the dashboard crediting a losing bidder.
              won,
              claimedByAgentName: outcome.winner?.name ?? null,
            },
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

        // The auction set the split; re-read the job so it carries it.
        job = this.store.getJob(job.id) as Job;
        const auctionTx = await this.recordAuctionOnchain(job, outcome);
        job = await this.advance(
          job,
          'APPROVED',
          { decision: outcome.winningDecision },
          { agent: outcome.winner.name, auction: outcome.auction },
          auctionTx,
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

  /**
   * Write the auction's result to the ParrotSplitter contract: winner, share,
   * and a hash of every agent's decision. Best effort - a chain hiccup must not
   * cost the creator their dub, so failure is logged and unlocks fall back to
   * the revenue-wallet path.
   */
  private async recordAuctionOnchain(job: Job, outcome: DecisionOutcome): Promise<string | null> {
    const payees = this.payments.splitPayees(job);
    const operatorKey = getConfig().env.PARROT_REVENUE_PRIVATE_KEY;
    const splitter = getConfig().env.SPLITTER_ADDRESS;
    if (!payees || !operatorKey || !splitter || !outcome.auction) return null;
    try {
      return await recordAuctionOnchain({
        operatorKey: operatorKey as `0x${string}`,
        splitter: splitter as `0x${string}`,
        jobId: job.id,
        creator: payees.creator,
        agent: payees.agent,
        agentBps: outcome.auction.clearingBps,
        bidders: outcome.auction.bids.length,
        decisions: outcome.bids.map((b) => b.decision),
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[pipeline] job ${job.id}: recording the auction on-chain failed - ${detail}`);
      return null;
    }
  }

  /**
   * Write the QC verdict to the contract, next to this job's auction. Best
   * effort, like the auction record: only for jobs whose auction is on-chain,
   * and a chain hiccup never blocks publishing.
   */
  private async recordQcOnchain(job: Job, report: QcReport): Promise<string | null> {
    const operatorKey = getConfig().env.PARROT_REVENUE_PRIVATE_KEY;
    const splitter = getConfig().env.SPLITTER_ADDRESS;
    const onchain = this.store.eventsForJob(job.id).some((e) => e.type === 'APPROVED' && e.txHash !== null);
    if (!operatorKey || !splitter || !onchain) return null;
    const meaning = report.checks.find((c) => c.name === 'back_translation');
    const score = meaning?.measured?.['meaningScore'];
    try {
      return await recordQcOnchain({
        operatorKey: operatorKey as `0x${string}`,
        splitter: splitter as `0x${string}`,
        jobId: job.id,
        passed: report.passed,
        meaningScore: typeof score === 'number' ? score : null,
        report,
      });
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[pipeline] job ${job.id}: recording QC on-chain failed - ${detail}`);
      return null;
    }
  }

  /** APPROVED -> DUBBING -> QC. The agent pays before it knows if it worked. */
  private async produceDub(job: Job): Promise<Job> {
    const agent = job.claimedByAgentId ? this.store.agents.get(job.claimedByAgentId) : undefined;
    if (!agent) return this.fail(job, 'INTERNAL_ERROR', 'approved job has no agent');

    const dubCost = estimateDubCost(job.durationS, agent.dubCostPerMinute);
    const provider = dubProviderFor(agent);

    job = await this.advance(
      job,
      'DUBBING_STARTED',
      { dubCost },
      { costMicros: dubCost.toString(), provider },
    );

    // The agent fronts the cost HERE, before knowing whether the dub will pass
    // QC. That is the risk that makes it an economic actor.
    await this.payments.chargeDubCost({
      agentAccountId: agent.accountId,
      jobId: job.id,
      amount: dubCost,
      agentPrivateKey: agentPrivateKey(agent.name),
    });

    // Bring-your-own dubber: the agent's own provider makes the dub, and it
    // faces the same independent QC as everyone else.
    if (agent.dubUrl) {
      try {
        const external = await (this.hooks.externalDubber ?? defaultExternalDubber)(agent, job);
        return this.advance(
          this.store.getJob(job.id) as Job,
          'DUB_RENDERED',
          {
            providerJobId: `external:${job.id}`,
            dubUrl: external.localPath,
            previewUrl: await (this.hooks.previewMaker ?? makePreview)(external.localPath),
          },
          { simulated: false, provider },
        );
      } catch (error: unknown) {
        return this.fail(
          this.store.getJob(job.id) as Job,
          'DUBBING_PROVIDER_ERROR',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

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
        previewUrl: await (this.hooks.previewMaker ?? makePreview)(downloaded.localPath),
      },
      { simulated: created.simulated || downloaded.simulated, durationS: downloaded.durationS },
    );
  }

  /** QC -> PUBLISHED or REJECTED_BY_QC. The loss path is a real outcome. */
  private async runQc(job: Job): Promise<Job> {
    const dubPath = job.dubUrl;
    if (!dubPath) return this.fail(job, 'STORAGE_ERROR', 'no rendered dub to check');
    const qcAgent = job.claimedByAgentId ? this.store.agents.get(job.claimedByAgentId) : undefined;

    const report = await this.qc.run({
      dubPath,
      sourceDurationS: job.durationS,
      dubDurationS: job.durationS,
      targetLang: job.targetLang,
      forceFail: job.qcDemoFail,
      sourceUrl: job.sourceUrl,
      dubProvider: qcAgent ? dubProviderFor(qcAgent) : HOUSE_DUB_PROVIDER,
    });

    // The verdict goes on-chain next to the auction: the agent's public,
    // uneditable track record.
    const qcTx = await this.recordQcOnchain(job, report);

    if (!report.passed) {
      const failed = report.checks.filter((c) => !c.passed);
      console.error(
        `[pipeline] job ${job.id} failed QC: ${failed.map((c) => `${c.name} (${JSON.stringify(c)})`).join('; ')}`,
      );
      // Not published, cost already booked as a loss, p_success falls, and the
      // creator is told the truth rather than handed a bad dub.
      return this.advance(
        job,
        'QC_FAILED',
        { qcReport: report },
        { failed: report.checks.filter((c) => !c.passed).map((c) => c.name) },
        qcTx,
      );
    }

    return this.advance(
      job,
      'QC_PASSED',
      { qcReport: report, publishedAt: new Date() },
      { previewSeconds: PREVIEW_SECONDS },
      qcTx,
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
