/**
 * Fetches the real video behind an x.com post so it can be dubbed.
 *
 * Why this exists: on x.com there is no X API (see bot/x-adapter.ts), so the
 * only thing Parrot knows about a post is its link. The dubbing provider cannot
 * be trusted to fetch an arbitrary page, and a "dub" of a link with no media
 * behind it is always the simulated stand-in. So we download the video
 * ourselves, with yt-dlp, and hand the provider the bytes - the same route an
 * uploaded Chirp clip takes.
 *
 * Safety:
 *  - The URL is matched against one strict pattern (an x.com / twitter.com
 *    status link). Anything else is refused before a process is spawned.
 *  - yt-dlp is run with execFile-style argv (no shell), so no part of the URL
 *    can become a command.
 *  - Length and size are capped by yt-dlp itself, so an over-long clip is never
 *    downloaded. A clip the agents have priced as short cannot silently turn
 *    into a long, expensive one.
 *
 * yt-dlp is an optional dependency. If it is not installed, fetch() resolves
 * null and the caller decides what to do; it never throws for "not installed".
 */

import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MAX_SOURCE_DURATION_S } from '@parrot/shared';
import { getConfig } from '../config.js';

/** An x.com or twitter.com status link, nothing more. */
export const X_STATUS_URL = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/([0-9]{1,25})$/;

export interface RunResult {
  readonly code: number | null;
  readonly stderr: string;
}

/** Runs the binary with an argv (no shell). Rejects with ENOENT if it is missing. */
export type YtDlpRunner = (args: string[]) => Promise<RunResult>;

export interface MediaFetcherDeps {
  readonly ytDlpPath?: string;
  readonly mediaDir?: string;
  readonly run?: YtDlpRunner;
  /** Test seam: does the file exist? Resolves its size in bytes or null. */
  readonly sizeOf?: (path: string) => Promise<number | null>;
  readonly timeoutMs?: number;
}

export class MediaFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaFetchError';
  }
}

const MAX_BYTES = '100M';
const DEFAULT_TIMEOUT_MS = 120_000;

export class MediaFetcher {
  private readonly ytDlpPath: string;
  private readonly mediaDirOverride: string | undefined;
  private readonly runner: YtDlpRunner;
  private readonly sizeOf: (path: string) => Promise<number | null>;

  constructor(deps: MediaFetcherDeps = {}) {
    this.ytDlpPath = deps.ytDlpPath ?? getConfig().env.YT_DLP_PATH ?? 'yt-dlp';
    this.mediaDirOverride = deps.mediaDir;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runner = deps.run ?? ((args) => defaultRunner(this.ytDlpPath, args, timeoutMs));
    this.sizeOf =
      deps.sizeOf ??
      (async (path) => {
        try {
          return (await stat(path)).size;
        } catch {
          return null;
        }
      });
  }

  private get mediaDir(): string {
    return resolve(this.mediaDirOverride ?? getConfig().env.MEDIA_STORAGE_DIR);
  }

  /**
   * Download the post's video to MEDIA_STORAGE_DIR and return its path.
   * Resolves null when yt-dlp is not installed. Throws MediaFetchError for
   * everything else (bad link, too long, no video, download failed).
   */
  /** Downloads in progress, so eight dubs of one post start one download, not eight. */
  private readonly inflight = new Map<string, Promise<string | null>>();

  fetch(url: string): Promise<string | null> {
    const running = this.inflight.get(url);
    if (running) return running;
    const started = this.download(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, started);
    return started;
  }

  private async download(url: string): Promise<string | null> {
    const match = X_STATUS_URL.exec(url);
    if (!match) throw new MediaFetchError('that is not an x.com post link');
    const postId = match[2] as string;

    await mkdir(this.mediaDir, { recursive: true });
    const target = join(this.mediaDir, `xsrc_${postId}.mp4`);

    // Already fetched (a second language for the same post): do not download
    // it again.
    const existing = await this.sizeOf(target);
    if (existing !== null && existing > 0) return target;

    const args = [
      '--no-playlist',
      '--no-progress',
      '--quiet',
      '--no-warnings',
      // Over-long clips are skipped by yt-dlp itself, never downloaded.
      '--match-filter',
      `duration<=${MAX_SOURCE_DURATION_S}`,
      '--max-filesize',
      MAX_BYTES,
      '-f',
      'b[height<=720][ext=mp4]/bv*[height<=720]+ba/b[height<=720]/b',
      '--remux-video',
      'mp4',
      '-o',
      target,
      url,
    ];

    let result: RunResult;
    try {
      result = await this.runner(args);
    } catch (error: unknown) {
      if (isMissingBinary(error)) return null;
      throw new MediaFetchError(
        `the video downloader could not run (${error instanceof Error ? error.message : String(error)})`,
      );
    }

    if (result.code !== 0) {
      throw new MediaFetchError(
        `the video could not be downloaded (${firstLine(result.stderr) || `exit ${result.code ?? 'none'}`})`,
      );
    }
    const size = await this.sizeOf(target);
    if (size === null || size === 0) {
      // yt-dlp exits 0 when --match-filter skips a clip.
      throw new MediaFetchError(
        `no video was downloaded: the post may have no video, or it is longer than ${MAX_SOURCE_DURATION_S} seconds`,
      );
    }
    return target;
  }
}

function isMissingBinary(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}

function defaultRunner(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((res, rej) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      rej(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      res({ code, stderr });
    });
  });
}
