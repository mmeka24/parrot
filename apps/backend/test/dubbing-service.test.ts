import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ELEVENLABS_MAX_CONCURRENT_DUBS } from '@parrot/shared';
import {
  DubbingService,
  DubbingProviderError,
  DubbingTimeoutError,
  Semaphore,
} from '../src/services/dubbing-service.js';
import { resetConfig } from '../src/config.js';

const API_KEY = 'xi-secret-key-that-must-never-be-logged';

/** No credentials: capabilities.dubbing === false, the default demo path. */
function mockEnv(): void {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  delete process.env.ELEVENLABS_API_KEY;
  resetConfig();
}

/** A key is present: the live ElevenLabs path. Network is still faked. */
function liveEnv(): void {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  process.env.ELEVENLABS_API_KEY = API_KEY;
  resetConfig();
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fetch stand-in that replays a queue of responses and records every call. */
function fakeFetch(responses: Array<() => Promise<Response> | Response>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next === undefined) throw new Error('fake fetch ran out of responses');
    return await next();
  };
  return { impl, calls, get count() { return calls.length; } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Backoff without the wait, so retry tests finish instantly. */
const noSleep = async (): Promise<void> => {};

let mediaDir: string;

beforeEach(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), 'parrot-dub-'));
});

afterEach(async () => {
  await rm(mediaDir, { recursive: true, force: true });
  delete process.env.ELEVENLABS_API_KEY;
  resetConfig();
});

describe('Semaphore', () => {
  it('admits up to the limit and queues the rest in order', async () => {
    const sem = new Semaphore(2);
    await sem.acquire();
    await sem.acquire();
    expect(sem.inFlight).toBe(2);

    let third = false;
    const pending = sem.acquire().then(() => {
      third = true;
    });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(sem.queued).toBe(1);

    sem.release();
    await pending;
    expect(third).toBe(true);
  });
});

describe('DubbingService - mock mode (no credentials)', () => {
  beforeEach(mockEnv);

  it('reports itself as not live', () => {
    const svc = new DubbingService({ mediaDir });
    expect(svc.isLive).toBe(false);
  });

  it('returns a deterministic simulated job id and never touches the network', async () => {
    const fetchImpl = fakeFetch([() => json({})]);
    const svc = new DubbingService({ mediaDir, fetchImpl: fetchImpl.impl });

    const a = await svc.createDub({
      sourceUrl: 'https://example.com/clip.mp4',
      targetLang: 'es',
      durationS: 42,
    });
    svc.release(a.providerJobId);
    const b = await svc.createDub({
      sourceUrl: 'https://example.com/clip.mp4',
      targetLang: 'es',
      durationS: 42,
    });
    svc.release(b.providerJobId);

    expect(a.simulated).toBe(true);
    expect(a.providerJobId).toMatch(/^sim_dub_[0-9a-f]{16}$/);
    expect(b.providerJobId).toBe(a.providerJobId);
    expect(a.expectedDurationSec).toBe(42);
    expect(fetchImpl.count).toBe(0);
  });

  it('gives a different id for a different target language', async () => {
    const svc = new DubbingService({ mediaDir });
    const es = await svc.createDub({ sourceUrl: 'https://e/c.mp4', targetLang: 'es', durationS: 10 });
    const ja = await svc.createDub({ sourceUrl: 'https://e/c.mp4', targetLang: 'ja', durationS: 10 });
    expect(es.providerJobId).not.toBe(ja.providerJobId);
  });

  it('resolves immediately and writes a fixture audio file marked simulated', async () => {
    const svc = new DubbingService({ mediaDir });
    const created = await svc.createDub({
      sourceUrl: 'https://example.com/clip.mp4',
      targetLang: 'es',
      durationS: 30,
    });
    const status = await svc.pollUntilReady(created.providerJobId, {
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(status.ready).toBe(true);
    expect(status.simulated).toBe(true);

    const file = await svc.downloadDub(created.providerJobId, 'es');
    expect(file.simulated).toBe(true);
    expect(file.bytes).toBeGreaterThan(0);
    expect(file.path).toContain('.sim.');
    const info = await stat(file.path);
    expect(info.size).toBe(file.bytes);
  });

  it('rejects a request with neither a source url nor a file', async () => {
    const svc = new DubbingService({ mediaDir });
    await expect(svc.createDub({ targetLang: 'es', durationS: 10 })).rejects.toThrow(
      /sourceUrl or a filePath/,
    );
    expect(svc.inFlight).toBe(0);
  });
});

describe('DubbingService - live mode (faked network)', () => {
  beforeEach(liveEnv);

  it('creates a dub with target_lang and the xi-api-key header', async () => {
    const fetchImpl = fakeFetch([
      () => json({ dubbing_id: 'dub_abc', expected_duration_sec: 61 }),
    ]);
    const svc = new DubbingService({ mediaDir, fetchImpl: fetchImpl.impl, sleep: noSleep });

    const created = await svc.createDub({
      sourceUrl: 'https://example.com/clip.mp4',
      targetLang: 'es',
      sourceLang: 'en',
      durationS: 60,
    });

    expect(created).toEqual({
      providerJobId: 'dub_abc',
      expectedDurationSec: 61,
      simulated: false,
    });
    const call = fetchImpl.calls[0];
    expect(call?.url).toBe('https://api.elevenlabs.io/v1/dubbing');
    expect(call?.init?.method).toBe('POST');
    expect((call?.init?.headers as Record<string, string>)['xi-api-key']).toBe(API_KEY);
    const body = call?.init?.body as FormData;
    expect(body.get('target_lang')).toBe('es');
    expect(body.get('source_lang')).toBe('en');
    expect(body.get('source_url')).toBe('https://example.com/clip.mp4');
    svc.release('dub_abc');
  });

  it('retries a 429 with backoff and then succeeds', async () => {
    const fetchImpl = fakeFetch([
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
      () => new Response('slow down', { status: 429 }),
      () => json({ dubbing_id: 'dub_retry', expected_duration_sec: 10 }),
    ]);
    const delays: number[] = [];
    const svc = new DubbingService({
      mediaDir,
      fetchImpl: fetchImpl.impl,
      sleep: async (ms) => {
        delays.push(ms);
      },
      baseRetryDelayMs: 100,
    });

    const created = await svc.createDub({
      sourceUrl: 'https://example.com/c.mp4',
      targetLang: 'es',
      durationS: 10,
    });
    expect(created.providerJobId).toBe('dub_retry');
    expect(fetchImpl.count).toBe(3);
    // First wait honours Retry-After (1s), second is exponential backoff.
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    svc.release('dub_retry');
  });

  it('retries a 500 up to maxRetries and then gives up with a typed error', async () => {
    const fetchImpl = fakeFetch([() => new Response('boom', { status: 500 })]);
    const svc = new DubbingService({
      mediaDir,
      fetchImpl: fetchImpl.impl,
      sleep: noSleep,
      maxRetries: 2,
    });

    await expect(
      svc.createDub({ sourceUrl: 'https://e/c.mp4', targetLang: 'es', durationS: 10 }),
    ).rejects.toBeInstanceOf(DubbingProviderError);
    expect(fetchImpl.count).toBe(3); // first try + 2 retries
    expect(svc.inFlight).toBe(0); // the permit came back
  });

  it('does not retry a 400 and never puts the key in the error', async () => {
    const fetchImpl = fakeFetch([() => new Response('bad request', { status: 400 })]);
    const svc = new DubbingService({ mediaDir, fetchImpl: fetchImpl.impl, sleep: noSleep });

    await expect(
      svc.createDub({ sourceUrl: 'https://e/c.mp4', targetLang: 'es', durationS: 10 }),
    ).rejects.toThrow(/400/);
    expect(fetchImpl.count).toBe(1);

    try {
      await svc.createDub({ sourceUrl: 'https://e/c.mp4', targetLang: 'es', durationS: 10 });
    } catch (err) {
      const text = `${(err as Error).message} ${(err as Error).stack ?? ''}`;
      expect(text).not.toContain(API_KEY);
    }
  });

  it('treats an unknown status as still running and resolves on "dubbed"', async () => {
    const fetchImpl = fakeFetch([
      () => json({ dubbing_id: 'dub_x', status: 'queued' }),
      () => json({ dubbing_id: 'dub_x', status: 'some_new_status_we_have_never_seen' }),
      () =>
        json({
          dubbing_id: 'dub_x',
          status: 'dubbed',
          media_metadata: { content_type: 'audio/mpeg', duration: 30.2 },
        }),
    ]);
    const svc = new DubbingService({ mediaDir, fetchImpl: fetchImpl.impl, sleep: noSleep });

    const status = await svc.pollUntilReady('dub_x', { timeoutMs: 10_000, intervalMs: 1 });
    expect(status.ready).toBe(true);
    expect(status.durationS).toBe(30.2);
    expect(fetchImpl.count).toBe(3);
  });

  it('throws DubbingProviderError when the provider reports a failure', async () => {
    const fetchImpl = fakeFetch([
      () => json({ dubbing_id: 'dub_f', status: 'failed', error: 'unsupported media' }),
    ]);
    const svc = new DubbingService({ mediaDir, fetchImpl: fetchImpl.impl, sleep: noSleep });
    await expect(
      svc.pollUntilReady('dub_f', { timeoutMs: 5_000, intervalMs: 1 }),
    ).rejects.toBeInstanceOf(DubbingProviderError);
  });

  it('throws DubbingTimeoutError when the job never finishes', async () => {
    const fetchImpl = fakeFetch([() => json({ dubbing_id: 'dub_t', status: 'dubbing' })]);
    let clock = 0;
    const svc = new DubbingService({
      mediaDir,
      fetchImpl: fetchImpl.impl,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });

    const err = await svc
      .pollUntilReady('dub_t', { timeoutMs: 1_000, intervalMs: 250 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DubbingTimeoutError);
    expect((err as DubbingTimeoutError).lastStatus).toBe('dubbing');
    expect((err as DubbingTimeoutError).providerJobId).toBe('dub_t');
  });

  it('downloads the rendered audio to the media directory', async () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4]);
    const fetchImpl = fakeFetch([
      () => new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    ]);
    const svc = new DubbingService({ mediaDir, fetchImpl: fetchImpl.impl, sleep: noSleep });

    const file = await svc.downloadDub('dub_d', 'es');
    expect(file.bytes).toBe(audio.byteLength);
    expect(file.simulated).toBe(false);
    expect(file.path).toBe(join(mediaDir, 'dub_d.es.mp3'));
    expect(fetchImpl.calls[0]?.url).toBe('https://api.elevenlabs.io/v1/dubbing/dub_d/audio/es');
    const info = await stat(file.path);
    expect(info.size).toBe(audio.byteLength);
  });

  it('rejects an empty audio download rather than publishing silence', async () => {
    const fetchImpl = fakeFetch([() => new Response(new Uint8Array([]), { status: 200 })]);
    const svc = new DubbingService({ mediaDir, fetchImpl: fetchImpl.impl, sleep: noSleep });
    await expect(svc.downloadDub('dub_e', 'es')).rejects.toThrow(/empty audio/);
  });

  it(`never runs more than ${ELEVENLABS_MAX_CONCURRENT_DUBS} dubs at once`, async () => {
    expect(ELEVENLABS_MAX_CONCURRENT_DUBS).toBe(3);

    const gates: Array<() => void> = [];
    let started = 0;
    const svc = new DubbingService({
      mediaDir,
      sleep: noSleep,
      fetchImpl: async () => {
        started += 1;
        const id = `dub_${started}`; // unique per call, as real ids are
        await new Promise<void>((res) => gates.push(res));
        return json({ dubbing_id: id, expected_duration_sec: 5 });
      },
    });

    const start = (i: number) =>
      svc.createDub({ sourceUrl: `https://e/${i}.mp4`, targetLang: 'es', durationS: 5 });
    const p0 = start(0);
    const p1 = start(1);
    const p2 = start(2);
    const p3 = start(3);
    await new Promise((res) => setTimeout(res, 10));

    expect(started).toBe(ELEVENLABS_MAX_CONCURRENT_DUBS);
    expect(svc.inFlight).toBe(ELEVENLABS_MAX_CONCURRENT_DUBS);
    expect(svc.queued).toBe(1);

    // Finish one: the queued job is admitted, and still only 3 are running.
    gates[0]?.();
    const first = await p0;
    svc.release(first.providerJobId);
    await new Promise((res) => setTimeout(res, 10));
    expect(started).toBe(4);
    expect(svc.inFlight).toBeLessThanOrEqual(ELEVENLABS_MAX_CONCURRENT_DUBS);

    for (const gate of gates) gate();
    for (const r of await Promise.all([p1, p2, p3])) svc.release(r.providerJobId);
    expect(svc.inFlight).toBe(0);
  });
});
