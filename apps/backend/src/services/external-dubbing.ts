/**
 * Bring-your-own dubber. An agent that registered a `dubUrl` makes the dub
 * with its own provider (HeyGen, Rask, its own model - anything), so agents
 * compete on dub quality and cost, not only on price.
 *
 * Request (POST, JSON) to the agent's dubUrl:
 *   { "jobId": "...", "sourceUrl": "https://...", "targetLang": "es", "durationS": 30 }
 * Response, once the dub is ready (within EXTERNAL_DUB_TIMEOUT_MS):
 *   { "mediaUrl": "https://.../dub.mp4" }
 *
 * Parrot downloads the file and puts it through the same independent QC as
 * every other dub. A slow, broken or oversized answer fails the job, and the
 * agent bears the cost - exactly as if its provider had failed.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Agent, Job } from '../store/types.js';
import { isAllowedBidUrl } from './agent-registry.js';

export const EXTERNAL_DUB_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_EXTERNAL_DUB_BYTES = 100 * 1024 * 1024;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export class ExternalDubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalDubError';
  }
}

/** Only https, so a registered agent cannot point the backend at internal hosts. */
function safeUrl(raw: string, production: boolean): boolean {
  try {
    return isAllowedBidUrl(raw, production);
  } catch {
    return false;
  }
}

export async function dubExternally(
  agent: Agent,
  job: Job,
  options: { mediaDir: string; production?: boolean; fetchImpl?: Fetch; timeoutMs?: number },
): Promise<{ localPath: string }> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const production = options.production ?? false;
  if (!agent.dubUrl || !safeUrl(agent.dubUrl, production)) {
    throw new ExternalDubError(`${agent.name} has no usable dubbing endpoint`);
  }

  const res = await fetchImpl(agent.dubUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jobId: job.id,
      sourceUrl: job.sourceUrl,
      targetLang: job.targetLang,
      durationS: job.durationS,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? EXTERNAL_DUB_TIMEOUT_MS),
  });
  if (!res.ok) throw new ExternalDubError(`${agent.name}'s dubber answered ${res.status}`);
  const body = (await res.json()) as { mediaUrl?: unknown };
  if (typeof body.mediaUrl !== 'string' || !safeUrl(body.mediaUrl, production)) {
    throw new ExternalDubError(`${agent.name}'s dubber returned no usable mediaUrl`);
  }

  const media = await fetchImpl(body.mediaUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? EXTERNAL_DUB_TIMEOUT_MS),
  });
  if (!media.ok) throw new ExternalDubError(`the dub file answered ${media.status}`);
  const bytes = new Uint8Array(await media.arrayBuffer());
  if (bytes.byteLength === 0) throw new ExternalDubError('the dub file is empty');
  if (bytes.byteLength > MAX_EXTERNAL_DUB_BYTES) throw new ExternalDubError('the dub file is over 100 MB');

  const ext = /\.(mp4|mp3|wav|webm|m4a)(\?|$)/i.exec(body.mediaUrl)?.[1]?.toLowerCase() ?? 'mp4';
  await mkdir(options.mediaDir, { recursive: true });
  const localPath = join(options.mediaDir, `ext_${job.id}.${job.targetLang}.${ext}`);
  await writeFile(localPath, bytes);
  return { localPath };
}
