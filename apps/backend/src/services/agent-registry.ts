/**
 * Open agent registration: anyone can enter a dubbing agent into the auction.
 *
 * Two kinds of entrant, same auction, same budget rules:
 *  - PARAMETERISED: pick a margin, budget, language and optimism; the built-in
 *    EV formula bids for you (exactly how Magpie, Kestrel and Finch work).
 *  - EXTERNAL: give a `bidUrl`. Before each auction Parrot POSTs the job and
 *    its own forecast there, and your server answers with a bid. Bring any
 *    model you like - see external-bids.ts for the wire format.
 *
 * A wallet address is optional but recommended: with the ParrotSplitter
 * deployed, the contract pays an agent's share straight to it.
 */

import { z } from 'zod';
import { getAddress, isAddress } from 'viem';
import { SUPPORTED_LANGUAGE_CODES, parseUsd } from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { Agent } from '../store/types.js';
import type { PaymentService } from './payment-service.js';

/** Keeps one person from flooding the auction. */
export const MAX_AGENTS = 25;
/** Test-mode starting balance, same as the house agents. */
export const NEW_AGENT_CREDIT_USD = '12.00';

const usd = z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, 'a dollar amount like "0.10"');

export const registerAgentSchema = z.object({
  name: z.string().trim().min(2).max(24).regex(/^[A-Za-z0-9 _-]+$/, 'letters, numbers, spaces, - and _'),
  persona: z.string().trim().max(160).default('A community agent.'),
  walletAddress: z
    .string()
    .refine((v) => isAddress(v), 'not an EVM address')
    .transform((v) => getAddress(v))
    .nullable()
    .default(null),
  minMarginUsd: usd.default('0.10'),
  floorUsd: usd.default('1.00'),
  maxExposureUsd: usd.default('2.00'),
  dailyCapUsd: usd.default('10.00'),
  languageFocus: z.enum(SUPPORTED_LANGUAGE_CODES as [string, ...string[]]).nullable().default(null),
  /** Which end of the forecast range the built-in formula plans on. */
  optimism: z.enum(['cautious', 'likely', 'optimistic']).default('likely'),
  bidUrl: z.string().url().nullable().default(null),
});

export type RegisterAgentInput = z.input<typeof registerAgentSchema>;

export class AgentRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRegistrationError';
  }
}

const OPTIMISM_PPM = { cautious: 800_000, likely: 1_000_000, optimistic: 1_350_000 } as const;

/**
 * Only https endpoints, so the backend cannot be pointed at internal services.
 * Plain http is allowed to localhost outside production, for local testing.
 */
export function isAllowedBidUrl(raw: string, production: boolean): boolean {
  const url = new URL(raw);
  if (url.protocol === 'https:') return true;
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return !production && url.protocol === 'http:' && local;
}

export class AgentRegistry {
  constructor(
    private readonly store: Store,
    private readonly payments: PaymentService,
    private readonly production = false,
  ) {}

  register(raw: unknown): Agent {
    const parsed = registerAgentSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new AgentRegistrationError(`${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}`);
    }
    const input = parsed.data;

    if (this.store.agents.size >= MAX_AGENTS) {
      throw new AgentRegistrationError(`the auction is full (${MAX_AGENTS} agents)`);
    }
    const taken = [...this.store.agents.values()].some(
      (a) => a.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (taken) throw new AgentRegistrationError(`an agent called ${input.name} already exists`);
    if (input.bidUrl && !isAllowedBidUrl(input.bidUrl, this.production)) {
      throw new AgentRegistrationError('bidUrl must be https');
    }
    if (parseUsd(input.maxExposureUsd) > parseUsd(input.dailyCapUsd)) {
      throw new AgentRegistrationError('maxExposureUsd cannot exceed dailyCapUsd');
    }

    const account = this.store.createAccount({
      kind: 'agent',
      label: input.name,
      email: null,
      walletAddress: input.walletAddress,
    });
    const agent = this.store.createAgent({
      name: input.name,
      persona: input.persona,
      accountId: account.id,
      walletAddress: input.walletAddress,
      floor: parseUsd(input.floorUsd),
      minMargin: parseUsd(input.minMarginUsd),
      maxExposurePerJob: parseUsd(input.maxExposureUsd),
      dailyCap: parseUsd(input.dailyCapUsd),
      languageFocus: input.languageFocus,
      optimismPpm: OPTIMISM_PPM[input.optimism],
      active: true,
      bidUrl: input.bidUrl,
    });
    this.payments.fundFromFaucet(account.id, parseUsd(NEW_AGENT_CREDIT_USD));
    return agent;
  }
}
