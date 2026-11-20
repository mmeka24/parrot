/**
 * DubbingService - the only place Parrot talks to the ElevenLabs dubbing API.
 *
 * Endpoints used (verified against the official reference, 2026-11-15):
 *   POST   /v1/dubbing                               create a dub
 *   GET    /v1/dubbing/{dubbing_id}                  poll status
 *   GET    /v1/dubbing/{dubbing_id}/audio/{lang}     download the rendered bytes
 *   DELETE /v1/dubbing/{dubbing_id}                  clean up
 *
 * HONESTY RULES, same as the rest of the system:
 *  - With no ELEVENLABS_API_KEY (`capabilities.dubbing === false`, the default
 *    right now) every call runs in MOCK MODE: a deterministic fake job id and a
 *    fixture audio file. Every result carries `simulated: true` so no caller,
 *    log line or dashboard can mistake it for a real dub.
 *  - The API key is never logged, never put in an error message and never in a
 *    URL. Errors carry status codes and provider messages only.
 *
 * RATE REALITY: self-serve ElevenLabs plans allow only
 * ELEVENLABS_MAX_CONCURRENT_DUBS (3) concurrent dubbing jobs, so a semaphore
 * gates job creation. A permit is held from createDub() until the job reaches a
 * terminal state (pollUntilReady resolving or throwing) or release() is called.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ELEVENLABS_MAX_CONCURRENT_DUBS,
  elevenLabsCreateDubSchema,
  elevenLabsDubStatusSchema,
} from '@parrot/shared';
import { getConfig } from '../config.js';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

/** Where the shipped fixture audio lives (apps/backend/fixtures). */
const FIXTURE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../fixtures');
const MOCK_FIXTURE = join(FIXTURE_DIR, 'mock-dub.wav');

/**
 * The one status value the docs show for a finished legacy dub. The reference
 * does not enumerate the rest, so anything we do not recognise is treated as
 * STILL RUNNING rather than as a failure - guessing a new status means failing
 * a job we were paid to deliver.
 */
const SUCCESS_STATUSES = new Set(['dubbed']);
/** Statuses that clearly mean the provider gave up. */
const FAILURE_STATUSES = new Set(['failed', 'error', 'dubbing_failed', 'cancelled', 'canceled']);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class DubbingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DubbingError';
    this.code = code;
  }
}

/** The provider answered, and the answer was bad. Never carries credentials. */
export class DubbingProviderError extends DubbingError {
  readonly status: number | undefined;
  readonly providerJobId: string | undefined;
  constructor(message: string, opts: { status?: number; providerJobId?: string } = {}) {
    super('DUBBING_PROVIDER_ERROR', message);
    this.name = 'DubbingProviderError';
    this.status = opts.status;
    this.providerJobId = opts.providerJobId;
  }
}

/** We waited the agreed budget of time and the job was still not ready. */
export class DubbingTimeoutError extends DubbingError {
  readonly providerJobId: string;
  readonly waitedMs: number;
  readonly lastStatus: string | undefined;
  constructor(providerJobId: string, waitedMs: number, lastStatus?: string) {
    super(
      'DUBBING_TIMEOUT',
      `dub ${providerJobId} was still "${lastStatus ?? 'unknown'}" after ${waitedMs}ms`,
    );
    this.name = 'DubbingTimeoutError';
    this.providerJobId = providerJobId;
    this.waitedMs = waitedMs;
    this.lastStatus = lastStatus;
  }
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

/** Minimal FIFO counting semaphore. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    this.available = limit;
  }

  get inFlight(): number {
    return this.limit - this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((res) => {
      this.waiters.push(res);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    if (this.available < this.limit) this.available += 1;
  }
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface CreateDubInput {
  /** A publicly fetchable media URL. One of sourceUrl / filePath is required. */
  readonly sourceUrl?: string;
  readonly filePath?: string;
  /** REQUIRED by the API. */
  readonly targetLang: string;
  /** Omitted means "let the provider detect it". */
  readonly sourceLang?: string;
  /** Source duration in seconds, used for the poll budget and cost mirroring. */
  readonly durationS: number;
  readonly numSpeakers?: number;
  readonly watermark?: boolean;
  readonly name?: string;
  /**
   * Force the fixture path even when a key is configured. Set for sources that
   * have no real media behind them (the seeded demo posts): sending those to
   * the provider could only fail, and would make a keyed demo boot broken.
   */
  readonly simulate?: boolean;
}

export interface CreateDubResult {
  readonly providerJobId: string;
  readonly expectedDurationSec: number;
  /** True when no real dub was bought. Render this, do not hide it. */
  readonly simulated: boolean;
}

export interface DubStatus {
  readonly providerJobId: string;
  readonly status: string;
  readonly ready: boolean;
  readonly error: string | null;
  readonly durationS: number | null;
  readonly contentType: string | null;
  readonly simulated: boolean;
}

export interface DownloadedDub {
  readonly providerJobId: string;
  readonly languageCode: string;
  readonly path: string;
  readonly bytes: number;
  readonly simulated: boolean;
}

export interface PollOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface DubbingServiceDeps {
  readonly fetchImpl?: FetchImpl;
  readonly now?: () => number;
  /** Injected so tests do not actually wait out the backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Overrides MEDIA_STORAGE_DIR; tests point this at a temp directory. */
  readonly mediaDir?: string;
  readonly maxConcurrent?: number;
  readonly maxRetries?: number;
  readonly baseRetryDelayMs?: number;
  readonly requestTimeoutMs?: number;
}

/** Every simulated provider job id starts with this. See isLiveJob(). */
export const SIMULATED_JOB_PREFIX = 'sim_dub_';

const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DubbingService {
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly mediaDirOverride: string | undefined;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly semaphore: Semaphore;
  /** Jobs holding a concurrency permit, by provider job id. */
  private readonly heldPermits = new Set<string>();

  constructor(deps: DubbingServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms)));
    this.mediaDirOverride = deps.mediaDir;
    this.maxRetries = deps.maxRetries ?? 3;
    this.baseRetryDelayMs = deps.baseRetryDelayMs ?? 500;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 60_000;
    this.semaphore = new Semaphore(deps.maxConcurrent ?? ELEVENLABS_MAX_CONCURRENT_DUBS);
  }

  /** True when a real API key is configured. Read per call so tests can flip it. */
  get isLive(): boolean {
    return getConfig().capabilities.dubbing;
  }

  /**
   * Whether THIS job was really bought. A simulated job keeps its `sim_dub_`
   * id for life, so status and download can never reach the provider for it,
   * even when a key is present.
   */
  private isLiveJob(providerJobId: string): boolean {
    return this.isLive && !providerJobId.startsWith(SIMULATED_JOB_PREFIX);
  }

  /** How many dub jobs currently hold a concurrency permit. */
  get inFlight(): number {
    return this.semaphore.inFlight;
  }

  /** How many createDub() calls are parked waiting for a permit. */
  get queued(): number {
    return this.semaphore.queued;
  }

  private get mediaDir(): string {
    return this.mediaDirOverride ?? getConfig().env.MEDIA_STORAGE_DIR;
  }

  private get apiKey(): string {
    const key = getConfig().env.ELEVENLABS_API_KEY;
    if (key === undefined) {
      throw new DubbingError('NO_CREDENTIALS', 'no dubbing credentials are configured');
    }
    return key;
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  /**
   * Start a dub. Blocks while the provider's 3-job concurrency budget is full.
   * The permit is held until the job finishes (pollUntilReady) or release().
   */
  async createDub(input: CreateDubInput): Promise<CreateDubResult> {
    if (input.sourceUrl === undefined && input.filePath === undefined) {
      throw new DubbingError('BAD_INPUT', 'a dub needs either a sourceUrl or a filePath');
    }
    if (input.targetLang.trim() === '') {
      throw new DubbingError('BAD_INPUT', 'targetLang is required');
    }

    await this.semaphore.acquire();
    let acquired = true;
    try {
      const result =
        this.isLive && input.simulate !== true
          ? await this.createDubLive(input)
          : this.createDubMock(input);
      this.heldPermits.add(result.providerJobId);
      acquired = false; // ownership moved to heldPermits
      return result;
    } finally {
      if (acquired) this.semaphore.release();
    }
  }

  /**
   * Mock mode: deterministic fake id derived from the request, so the same
   * request twice is the same job and a demo replays identically. Needs zero
   * credentials and touches no network.
   */
  private createDubMock(input: CreateDubInput): CreateDubResult {
    const seed = [
      input.sourceUrl ?? input.filePath ?? '',
      input.targetLang,
      input.sourceLang ?? 'auto',
      String(input.durationS),
    ].join('|');
    const digest = createHash('sha256').update(seed).digest('hex').slice(0, 16);
    return {
      providerJobId: `${SIMULATED_JOB_PREFIX}${digest}`,
      expectedDurationSec: Math.max(1, Math.round(input.durationS)),
      simulated: true,
    };
  }

  private async createDubLive(input: CreateDubInput): Promise<CreateDubResult> {
    const form = new FormData();
    form.set('target_lang', input.targetLang);
    if (input.sourceLang !== undefined) form.set('source_lang', input.sourceLang);
    if (input.numSpeakers !== undefined) form.set('num_speakers', String(input.numSpeakers));
    if (input.watermark !== undefined) form.set('watermark', String(input.watermark));
    if (input.name !== undefined) form.set('name', input.name);
    // Dubbing v1 is the tier the economics assume; studio mode is a different product.
    form.set('dubbing_studio', 'false');

    if (input.sourceUrl !== undefined) {
      form.set('source_url', input.sourceUrl);
    } else if (input.filePath !== undefined) {
      const bytes = await readFile(input.filePath);
      form.set(
        'file',
        // ElevenLabs rejects 'application/octet-stream' (400 invalid_file_type),
        // so the part must say what kind of media it is.
        new Blob([new Uint8Array(bytes)], { type: mediaTypeFor(input.filePath) }),
        basename(input.filePath),
      );
    }

    const res = await this.request('/v1/dubbing', { method: 'POST', body: form });
    const json: unknown = await res.json();
    const parsed = elevenLabsCreateDubSchema.safeParse(json);
    if (!parsed.success) {
      throw new DubbingProviderError('the dubbing service returned an unreadable create response', {
        status: res.status,
      });
    }
    return {
      providerJobId: parsed.data.dubbing_id,
      expectedDurationSec:
        parsed.data.expected_duration_sec ?? Math.max(1, Math.round(input.durationS)),
      simulated: false,
    };
  }

  // -------------------------------------------------------------------------
  // Poll
  // -------------------------------------------------------------------------

  /** One status read. Does not retry past the transport-level retries. */
  async getStatus(providerJobId: string): Promise<DubStatus> {
    if (!this.isLiveJob(providerJobId)) {
      return {
        providerJobId,
        status: 'dubbed',
        ready: true,
        error: null,
        durationS: null,
        contentType: 'audio/wav',
        simulated: true,
      };
    }
    const res = await this.request(`/v1/dubbing/${encodeURIComponent(providerJobId)}`, {
      method: 'GET',
    });
    const json: unknown = await res.json();
    const parsed = elevenLabsDubStatusSchema.safeParse(json);
    if (!parsed.success) {
      throw new DubbingProviderError('the dubbing service returned an unreadable status', {
        status: res.status,
        providerJobId,
      });
    }
    const data = parsed.data;
    return {
      providerJobId: data.dubbing_id,
      status: data.status,
      ready: SUCCESS_STATUSES.has(data.status.toLowerCase()),
      error: data.error ?? null,
      durationS: data.media_metadata?.duration ?? null,
      contentType: data.media_metadata?.content_type ?? null,
      simulated: false,
    };
  }

  /**
   * Poll until the job is ready. Unknown statuses count as "still working".
   * Releases the job's concurrency permit on every exit path.
   */
  async pollUntilReady(providerJobId: string, options: PollOptions = {}): Promise<DubStatus> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startedAt = this.now();
    let lastStatus: string | undefined;

    try {
      for (;;) {
        const status = await this.getStatus(providerJobId);
        lastStatus = status.status;
        if (status.ready) return status;
        if (FAILURE_STATUSES.has(status.status.toLowerCase())) {
          throw new DubbingProviderError(
            `the dubbing service reported "${status.status}"${
              status.error ? `: ${status.error}` : ''
            }`,
            { providerJobId },
          );
        }
        const elapsed = this.now() - startedAt;
        if (elapsed + intervalMs > timeoutMs) {
          throw new DubbingTimeoutError(providerJobId, elapsed, lastStatus);
        }
        await this.sleep(intervalMs);
      }
    } finally {
      this.release(providerJobId);
    }
  }

  /** Hand back a job's concurrency permit. Safe to call twice. */
  release(providerJobId: string): void {
    if (this.heldPermits.delete(providerJobId)) {
      this.semaphore.release();
    }
  }

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /** Fetch the rendered dub and write it under MEDIA_STORAGE_DIR. */
  async downloadDub(providerJobId: string, languageCode: string): Promise<DownloadedDub> {
    await mkdir(this.mediaDir, { recursive: true });

    if (!this.isLiveJob(providerJobId)) {
      const target = join(this.mediaDir, `${providerJobId}.${languageCode}.sim.wav`);
      await this.ensureFixture();
      await copyFile(MOCK_FIXTURE, target);
      const info = await stat(target);
      return {
        providerJobId,
        languageCode,
        path: target,
        bytes: info.size,
        simulated: true,
      };
    }

    const res = await this.request(
      `/v1/dubbing/${encodeURIComponent(providerJobId)}/audio/${encodeURIComponent(languageCode)}`,
      { method: 'GET' },
    );
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new DubbingProviderError('the dubbing service returned an empty audio file', {
        providerJobId,
      });
    }
    const ext = extensionFor(res.headers.get('content-type'));
    const target = join(this.mediaDir, `${providerJobId}.${languageCode}${ext}`);
    await writeFile(target, buf);
    return {
      providerJobId,
      languageCode,
      path: target,
      bytes: buf.byteLength,
      simulated: false,
    };
  }

  /** Best-effort cleanup. A failure here never fails a job. */
  async deleteDub(providerJobId: string): Promise<boolean> {
    if (!this.isLiveJob(providerJobId)) return false;
    try {
      await this.request(`/v1/dubbing/${encodeURIComponent(providerJobId)}`, { method: 'DELETE' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create, wait and download in one call. The concurrency permit covers create
   * and polling - the provider's limit is on running jobs, and by download time
   * the job is finished, so the slot is handed back before the bytes are pulled.
   */
  async dub(
    input: CreateDubInput,
    poll: PollOptions = {},
  ): Promise<CreateDubResult & DownloadedDub> {
    const created = await this.createDub(input);
    try {
      await this.pollUntilReady(created.providerJobId, poll);
    } catch (err) {
      this.release(created.providerJobId);
      throw err;
    }
    const downloaded = await this.downloadDub(created.providerJobId, input.targetLang);
    return { ...created, ...downloaded };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * One authenticated request, with a timeout and exponential backoff on 429
   * and 5xx. The key goes in the `xi-api-key` header and nowhere else - not in
   * a log line, not in an error, not in a URL.
   */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = `${ELEVENLABS_BASE_URL}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            'xi-api-key': this.apiKey,
          },
          signal: controller.signal,
        });
        clearTimeout(timer);
      } catch (err) {
        clearTimeout(timer);
        lastError = new DubbingProviderError(
          `could not reach the dubbing service: ${describe(err)}`,
        );
        if (attempt === this.maxRetries) break;
        await this.sleep(this.backoffMs(attempt, null));
        continue;
      }

      if (res.ok) return res;

      const retryable = res.status === 429 || res.status >= 500;
      const body = await safeText(res);
      lastError = new DubbingProviderError(
        `the dubbing service returned ${res.status}${body ? `: ${body}` : ''}`,
        { status: res.status },
      );
      if (!retryable || attempt === this.maxRetries) break;
      await this.sleep(this.backoffMs(attempt, res.headers.get('retry-after')));
    }

    throw lastError ?? new DubbingProviderError('the dubbing service could not be reached');
  }

  /** Exponential backoff with jitter, honouring Retry-After when it is sane. */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) {
        return Math.round(seconds * 1000);
      }
    }
    const base = this.baseRetryDelayMs * 2 ** attempt;
    return Math.round(base + Math.random() * this.baseRetryDelayMs);
  }

  private async ensureFixture(): Promise<void> {
    try {
      await stat(MOCK_FIXTURE);
      return;
    } catch {
      // Fixture missing (a trimmed checkout): synthesise one so mock mode never
      // fails for want of a file. One second of 8kHz mono silence.
      await mkdir(dirname(MOCK_FIXTURE), { recursive: true });
      await writeFile(MOCK_FIXTURE, silentWav(1));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? 'source';
}

function extensionFor(contentType: string | null): string {
  if (contentType === null) return '.mp3';
  if (contentType.includes('mp4') || contentType.includes('video')) return '.mp4';
  if (contentType.includes('wav')) return '.wav';
  return '.mp3';
}

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 300);
  } catch {
    return '';
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A minimal valid PCM WAV of silence, so mock mode is never empty-handed. */
export function silentWav(seconds: number, sampleRate = 8_000): Buffer {
  const frames = Math.max(1, Math.round(seconds * sampleRate));
  const data = Buffer.alloc(frames * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The media type ElevenLabs needs on an uploaded source file, from its extension. */
export function mediaTypeFor(filePath: string): string {
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  const types: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
  };
  return types[ext] ?? 'video/mp4';
}
