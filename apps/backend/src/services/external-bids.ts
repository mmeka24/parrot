/**
 * Asking third-party agents for their sealed bids.
 *
 * Request (POST, JSON) to each external agent's bidUrl:
 *   {
 *     "jobId": "...", "targetLang": "es", "category": "comedy", "durationS": 30,
 *     "signals": { "likes": ..., "sourceViews": ..., ... },
 *     "quote": {
 *       "dubCostMicros": "250000",       // what the agent pays to dub it
 *       "unlockPriceMicros": "20000",    // what each viewer pays
 *       "reserveBps": 4000,              // the highest share it may bid
 *       "forecast": { "low": 380, "likely": 680, "high": 1210 },  // dub viewers
 *       "conversionPpm": 125000          // forecast unlocks per viewer
 *     }
 *   }
 * Response: { "bidBps": 1500 }  - the share it needs (1..reserveBps), or
 *           { "bidBps": null }  - pass.
 *
 * Every agent is asked in parallel with a short timeout; a slow, broken or
 * malformed answer is a pass. One bad agent can never stall an auction.
 */

import { UNLOCK_PRICE, predictViews } from '@parrot/shared';
import type { Store } from '../store/store.js';
import type { Agent, Job } from '../store/types.js';
import { estimateDubCost } from './decision-service.js';

export const EXTERNAL_BID_TIMEOUT_MS = 3_000;

/** agentId -> the share it bid, or null for a pass. */
export type ExternalBids = ReadonlyMap<string, number | null>;

type Fetch = typeof fetch;

export async function collectExternalBids(
  store: Store,
  job: Job,
  fetchImpl: Fetch = fetch,
): Promise<ExternalBids> {
  const agents = store.activeAgents().filter((a): a is Agent & { bidUrl: string } => Boolean(a.bidUrl));
  if (agents.length === 0) return new Map();

  const signals = job.signals ?? {
    likes: 0, replies: 0, reposts: 0, quotes: 0, sourceViews: 0, authorFollowers: 0, ageHours: 0,
  };
  const prediction = predictViews(signals, job.targetLang, store.getBucket(job.category, job.targetLang));
  const bodyFor = (agent: Agent) => JSON.stringify({
    jobId: job.id,
    targetLang: job.targetLang,
    category: job.category,
    durationS: job.durationS,
    signals,
    quote: {
      // This agent's own cost: its own dubber's price, or the house rate.
      dubCostMicros: estimateDubCost(job.durationS, agent.dubCostPerMinute).toString(),
      unlockPriceMicros: UNLOCK_PRICE.toString(),
      reserveBps: job.splitAgentBps,
      forecast: prediction.range,
      conversionPpm: prediction.conversionPpm,
    },
  });

  const answers = await Promise.all(
    agents.map(
      async (agent) => [agent.id, await askOne(agent.bidUrl, bodyFor(agent), job.splitAgentBps, fetchImpl)] as const,
    ),
  );
  return new Map(answers);
}

async function askOne(url: string, body: string, reserveBps: number, fetchImpl: Fetch): Promise<number | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(EXTERNAL_BID_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { bidBps?: unknown };
    const bid = json.bidBps;
    if (typeof bid !== 'number' || !Number.isInteger(bid) || bid < 1 || bid > reserveBps) return null;
    return bid;
  } catch {
    return null;
  }
}
