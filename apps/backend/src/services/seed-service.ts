/**
 * Demo seeding and simulated traffic.
 *
 * Everything created here is labelled test-mode or simulated, in the data and
 * therefore in the UI. The point of the demo is to show a real mechanism
 * working, not to fake outcomes - so simulated viewers perform REAL unlocks
 * through the same PaymentService path a human viewer uses. Only the viewer and
 * the view counts are synthetic.
 *
 * The seed tells the brief's three-part story deliberately:
 *   1. the worked example that gets dubbed and earns,
 *   2. a request the agents DECLINE because the numbers do not work, and
 *   3. a dub that FAILS QC, so the loss path is visible.
 */

import {
  parseUsd,
  UNLOCK_PRICE,


} from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { Agent, Creator, Job } from '../store/types.js';
import { PaymentService } from './payment-service.js';
import { AGENT_PERSONAS } from './decision-service.js';
import { getConfig } from '../config.js';
import { addressFromKey } from '../chain/client.js';

export interface SeededCreator {
  creator: Creator;
  postId: string;
}

export class SeedService {
  constructor(
    private readonly store: Store,
    private readonly payments: PaymentService,
  ) {}

  /** Create the agent personas, the revenue wallet and the treasury. */
  seedAgents(): Agent[] {
    if (this.store.agents.size > 0) return [...this.store.agents.values()];
    const config = getConfig();

    const keys: Record<string, string | undefined> = {
      Magpie: config.env.AGENT_MAGPIE_PRIVATE_KEY,
      Kestrel: config.env.AGENT_KESTREL_PRIVATE_KEY,
      Finch: config.env.AGENT_FINCH_PRIVATE_KEY,
    };

    const agents: Agent[] = [];
    for (const persona of AGENT_PERSONAS) {
      const key = keys[persona.name];
      const address = key ? addressFromKey(key as `0x${string}`) : null;

      const account = this.store.createAccount({
        kind: 'agent',
        label: persona.name,
        email: null,
        walletAddress: address,
      });

      const agent = this.store.createAgent({
        name: persona.name,
        persona: persona.persona,
        accountId: account.id,
        walletAddress: address,
        floor: parseUsd(persona.floorUsd),
        minMargin: parseUsd(persona.minMarginUsd),
        maxExposurePerJob: parseUsd(persona.maxExposureUsd),
        dailyCap: parseUsd(persona.dailyCapUsd),
        languageFocus: persona.languageFocus,
        optimismPpm: persona.optimismPpm,
        active: true,
      });

      // Test-mode funding. In a credentialed run these balances come from the
      // Circle faucet; here they are recorded so the P&L has a starting point.
      this.payments.fundFromFaucet(account.id, parseUsd('12.00'));
      agents.push(agent);
    }

    // Revenue wallet (the x402 seller) and the creator-payout treasury.
    const revenueKey = config.env.PARROT_REVENUE_PRIVATE_KEY;
    this.store.createAccount({
      kind: 'revenue',
      label: 'Parrot revenue',
      email: null,
      walletAddress: revenueKey ? addressFromKey(revenueKey as `0x${string}`) : null,
    });

    const treasuryKey = config.env.PARROT_TREASURY_PRIVATE_KEY;
    const treasury = this.store.createAccount({
      kind: 'treasury',
      label: 'Creator payouts',
      email: null,
      walletAddress: treasuryKey ? addressFromKey(treasuryKey as `0x${string}`) : null,
    });
    this.payments.fundFromFaucet(treasury.id, parseUsd('25.00'));

    return agents;
  }

  /** Create a creator and the X post that will be dubbed. */
  seedCreator(input: {
    handle: string;
    displayName: string;
    xUserId: string;
    followers: number;
    postText: string;
    durationS: number;
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    views: number;
    ageHours: number;
  }): SeededCreator {
    const account = this.store.createAccount({
      kind: 'creator',
      label: `@${input.handle}`,
      email: null,
      walletAddress: null,
    });

    const creator = this.store.createCreator({
      xUserId: input.xUserId,
      handle: input.handle,
      displayName: input.displayName,
      accountId: account.id,
      followers: input.followers,
      claimed: false,
    });

    const post = this.store.createBotPost({
      authorHandle: input.handle,
      authorDisplayName: input.displayName,
      authorXUserId: input.xUserId,
      text: input.postText,
      createdAt: new Date(Date.now() - input.ageHours * 3_600_000),
      isBot: false,
      inReplyToId: null,
      parentAuthorXUserId: null,
      metrics: {
        likes: input.likes,
        replies: input.replies,
        reposts: input.reposts,
        quotes: input.quotes,
        views: input.views,
      },
      hasVideo: true,
      videoDurationS: input.durationS,
      jobId: null,
      posted: false,
    });

    return { creator, postId: post.id };
  }

  /** The three creators whose stories the demo tells. */
  seedDemoCreators(): SeededCreator[] {
    return [
      // 1. The worked example: a viral clip (1.2M views), gets dubbed, earns.
      this.seedCreator({
        handle: 'maria',
        displayName: 'Maria Okonkwo',
        xUserId: 'x-maria',
        followers: 50_000,
        postText: 'The one kitchen trick nobody taught me until I was 30. 30 seconds, changed everything.',
        durationS: 30,
        likes: 18_000,
        replies: 640,
        reposts: 2_900,
        quotes: 210,
        views: 1_200_000,
        ageHours: 2,
      }),
      // 2. Not enough signal: the agents decline, and say why.
      this.seedCreator({
        handle: 'devlog',
        displayName: 'Sam / devlog',
        xUserId: 'x-devlog',
        followers: 240,
        postText: 'Quick demo of the parser I have been writing this week.',
        durationS: 45,
        likes: 4,
        replies: 1,
        reposts: 0,
        quotes: 0,
        views: 90,
        ageHours: 60,
      }),
      // 3. Good signal, but this dub will fail the QC gate.
      this.seedCreator({
        handle: 'chefleo',
        displayName: 'Chef Leo',
        xUserId: 'x-chefleo',
        followers: 18_000,
        postText: 'Three minutes, one pan, zero excuses.',
        durationS: 28,
        likes: 14_000,
        replies: 520,
        reposts: 2_100,
        quotes: 160,
        views: 900_000,
        ageHours: 5,
      }),
    ];
  }

  /**
   * Perform one simulated unlock against a published job.
   *
   * The viewer is synthetic; the payment is not. It runs through the same
   * PaymentService.recordUnlock path a real viewer uses, so the split, the
   * ledger and the settlement queue all behave identically.
   */
  simulateUnlock(job: Job, index: number): boolean {
    const agent = job.claimedByAgentId ? this.store.agents.get(job.claimedByAgentId) : undefined;
    const creator = this.store.creators.get(job.creatorId);
    if (!agent || !creator) return false;

    const viewer = this.store.createAccount({
      kind: 'viewer',
      label: `Simulated viewer ${index + 1}`,
      email: null,
      walletAddress: null,
    });
    this.payments.grantStarterCredit(viewer.id);

    try {
      this.payments.recordUnlock({
        jobId: job.id,
        viewerAccountId: viewer.id,
        amount: UNLOCK_PRICE,
        agentAccountId: agent.accountId,
        creatorAccountId: creator.accountId,
        splitAgentBps: job.splitAgentBps,
        splitCreatorBps: job.splitCreatorBps,
        paymentRef: `sim:${job.id}:${index}`,
        simulated: true,
      });
      // Each unlock implies some number of people who watched the preview and
      // did not pay. 8 views per unlock is the 12.5% conversion the model
      // assumes, which keeps simulated reality consistent with the prediction.
      this.store.updateJob(job.id, { viewCount: job.viewCount + 8 });
      return true;
    } catch {
      return false;
    }
  }
}

