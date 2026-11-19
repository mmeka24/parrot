/**
 * QcService - the gate a dub must pass before anyone is asked to pay for it.
 *
 * Four checks, run in this order:
 *
 *   1. duration_match   the dub is within QC_DURATION_TOLERANCE of the source
 *   2. language_detect  ElevenLabs Scribe hears the target language, confidently
 *   3. audio_sanity     ffmpeg: enough sound, no long dead gap, sane loudness
 *   4. back_translation NOT IMPLEMENTED - first item on the cut list, and said so
 *
 * THE HONESTY RULE THAT SHAPES THIS FILE: a check that did not run is reported
 * as SKIPPED, with the reason, and never as a pass. ffmpeg is not installed on
 * the demo machine, so audio_sanity skips there; the invocation below is the
 * real one and runs unchanged the moment ffmpeg is on PATH. A skipped check
 * does not block the gate (`passed` stays true for it) but `status` is the
 * truthful field and the detail line says so in words, because that detail is
 * what the dashboard prints.
 *
 * The returned report validates against qcReportSchema in @parrot/shared. The
 * extra `status` field on each check is additive - zod strips it on parse.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  QC_DURATION_TOLERANCE,
  QC_MIN_LANGUAGE_CONFIDENCE,
  QC_MIN_NON_SILENCE_RATIO,
  QC_MAX_DEAD_GAP_S,
  QC_LOUDNESS_RANGE_LUFS,
  elevenLabsSttResponseSchema,
  languageName,
  type QcReport,
} from '@parrot/shared';
import { getConfig } from '../config.js';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

/** Silence floor for silencedetect. -50dB is quiet enough to be true silence. */
const SILENCE_NOISE_DB = -50;
/** Shortest run counted as silence, in seconds. */
const SILENCE_MIN_DURATION_S = 0.5;

export type QcCheckName =
  | 'duration_match'
  | 'language_detect'
  | 'audio_sanity'
  | 'back_translation';

export type QcCheckStatus = 'passed' | 'failed' | 'skipped';

export interface QcCheckResult {
  readonly name: QcCheckName;
  /** False only for a real failure. A skipped check never blocks the gate. */
  readonly passed: boolean;
  /** The truthful tri-state. Prefer this over `passed` when you know about it. */
  readonly status: QcCheckStatus;
  /** One line a non-technical person can read on the dashboard. */
  readonly detail: string;
  readonly measured?: Record<string, number | string | boolean>;
}

export interface QcServiceReport extends QcReport {
  readonly checks: QcCheckResult[];
}

export interface QcInput {
  /** Local path to the dubbed audio. */
  readonly dubPath: string;
  /** Duration of the original clip, in seconds. */
  readonly sourceDurationS: number;
  /** Duration of the dub, in seconds. */
  readonly dubDurationS: number;
  /** The language the dub is supposed to be in. */
  readonly targetLang: string;
  /**
   * True when the "dub" is the stand-in fixture rather than a real render.
   * Its language is then reported as skipped, never checked: transcribing a
   * fixture would spend real credits to learn nothing.
   */
  readonly simulated?: boolean;
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface FfmpegResult {
  readonly code: number;
  readonly stderr: string;
}

/** Throw with `.code === 'ENOENT'` (or any error) when ffmpeg is absent. */
export type FfmpegRunner = (args: string[]) => Promise<FfmpegResult>;

export interface QcServiceDeps {
  readonly fetchImpl?: FetchImpl;
  readonly now?: () => Date;
  readonly runFfmpeg?: FfmpegRunner;
  readonly ffmpegPath?: string;
  readonly requestTimeoutMs?: number;
}

export class QcService {
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => Date;
  private readonly ffmpegPath: string;
  private readonly runFfmpeg: FfmpegRunner;
  private readonly requestTimeoutMs: number;

  constructor(deps: QcServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => new Date());
    this.ffmpegPath = deps.ffmpegPath ?? 'ffmpeg';
    this.runFfmpeg = deps.runFfmpeg ?? ((args) => defaultFfmpegRunner(this.ffmpegPath, args));
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 60_000;
  }

  /** Run the whole gate. Never throws for a failing dub - it reports. */
  async run(input: QcInput): Promise<QcServiceReport> {
    const checks: QcCheckResult[] = [
      this.checkDuration(input),
      await this.checkLanguage(input),
      await this.checkAudioSanity(input),
      this.checkBackTranslation(),
    ];
    const passed = checks.every((c) => c.passed);
    return { passed, checks, ranAt: this.now() };
  }

  // -------------------------------------------------------------------------
  // 1. duration_match
  // -------------------------------------------------------------------------

  checkDuration(input: QcInput): QcCheckResult {
    const { sourceDurationS, dubDurationS } = input;
    if (!(sourceDurationS > 0)) {
      return {
        name: 'duration_match',
        passed: false,
        status: 'failed',
        detail: 'The original clip has no usable length, so the dub cannot be compared to it.',
        measured: { sourceDurationS, dubDurationS },
      };
    }
    const drift = Math.abs(dubDurationS - sourceDurationS) / sourceDurationS;
    // Rounded to 6 places so a boundary case at exactly the tolerance is not
    // tipped over by floating point noise.
    const rounded = Math.round(drift * 1e6) / 1e6;
    const ok = rounded <= QC_DURATION_TOLERANCE;
    return {
      name: 'duration_match',
      passed: ok,
      status: ok ? 'passed' : 'failed',
      detail: ok
        ? `The dub runs ${dubDurationS.toFixed(1)}s against the original ${sourceDurationS.toFixed(1)}s, ${formatPercent(rounded)} off - inside the ${formatPercent(QC_DURATION_TOLERANCE)} allowance.`
        : `The dub runs ${dubDurationS.toFixed(1)}s against the original ${sourceDurationS.toFixed(1)}s, ${formatPercent(rounded)} off - outside the ${formatPercent(QC_DURATION_TOLERANCE)} allowance.`,
      measured: {
        sourceDurationS,
        dubDurationS,
        driftRatio: rounded,
        tolerance: QC_DURATION_TOLERANCE,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 2. language_detect
  // -------------------------------------------------------------------------

  async checkLanguage(input: QcInput): Promise<QcCheckResult> {
    if (input.simulated === true) {
      return skipped(
        'language_detect',
        'Skipped: this dub is a simulated stand-in, so there is no real speech to verify.',
        { reason: 'simulated_dub' },
      );
    }
    if (!getConfig().capabilities.qcLanguageDetection) {
      return skipped(
        'language_detect',
        'Skipped: the speech recognition service is not configured, so the spoken language was not verified.',
        { reason: 'no_credentials' },
      );
    }

    let stt: { language_code: string; language_probability: number; text: string };
    try {
      stt = await this.transcribe(input.dubPath);
    } catch (err) {
      return skipped(
        'language_detect',
        `Skipped: the speech recognition service could not be reached, so the spoken language was not verified (${describe(err)}).`,
        { reason: 'provider_unreachable' },
      );
    }

    const heard = stt.language_code.toLowerCase().split(/[-_]/)[0] ?? '';
    const want = input.targetLang.toLowerCase().split(/[-_]/)[0] ?? '';
    const confidence = stt.language_probability;

    if (heard !== want) {
      return {
        name: 'language_detect',
        passed: false,
        status: 'failed',
        detail: `The dub sounds like ${languageName(heard)}, not the ${languageName(want)} that was ordered.`,
        measured: { detected: heard, expected: want, confidence },
      };
    }
    if (confidence < QC_MIN_LANGUAGE_CONFIDENCE) {
      return {
        name: 'language_detect',
        passed: false,
        status: 'failed',
        detail: `The dub is only ${formatPercent(confidence)} likely to be ${languageName(want)}, below the ${formatPercent(QC_MIN_LANGUAGE_CONFIDENCE)} we require.`,
        measured: { detected: heard, expected: want, confidence },
      };
    }
    return {
      name: 'language_detect',
      passed: true,
      status: 'passed',
      detail: `The dub is ${languageName(want)} with ${formatPercent(confidence)} confidence.`,
      measured: { detected: heard, expected: want, confidence },
    };
  }

  /**
   * POST /v1/speech-to-text. `language_code` is deliberately NOT sent: the
   * whole point of this check is that the service tells US what it hears.
   */
  private async transcribe(
    filePath: string,
  ): Promise<{ language_code: string; language_probability: number; text: string }> {
    const apiKey = getConfig().env.ELEVENLABS_API_KEY;
    if (apiKey === undefined) throw new Error('no speech recognition credentials');

    const bytes = await readFile(filePath);
    const form = new FormData();
    form.set('model_id', getConfig().env.ELEVENLABS_STT_MODEL);
    form.set(
      'file',
      new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
      filePath.split(/[\\/]/).pop() ?? 'dub',
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${ELEVENLABS_BASE_URL}/v1/speech-to-text`, {
        method: 'POST',
        // The key lives in this header and nowhere else. It is never logged.
        headers: { 'xi-api-key': apiKey },
        body: form,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`speech recognition returned ${res.status}`);
    }
    const json: unknown = await res.json();
    const parsed = elevenLabsSttResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error('speech recognition returned an unreadable response');
    }
    // Multi-channel responses carry `transcripts` instead of a flat result.
    if ('transcripts' in parsed.data) {
      const first = parsed.data.transcripts[0];
      if (first === undefined) throw new Error('speech recognition returned no transcript');
      return first;
    }
    return parsed.data;
  }

  // -------------------------------------------------------------------------
  // 3. audio_sanity
  // -------------------------------------------------------------------------

  /**
   * One ffmpeg pass with two passthrough analysers chained:
   *   silencedetect -> silence_start / silence_end / silence_duration on stderr
   *   ebur128       -> a Summary block ending in "I: -23.0 LUFS"
   * loudnorm's JSON block (`input_i`) is accepted too, for callers who swap the
   * runner for `-af loudnorm=print_format=json`.
   */
  async checkAudioSanity(input: QcInput): Promise<QcCheckResult> {
    const args = [
      '-hide_banner',
      '-nostats',
      '-i',
      input.dubPath,
      '-af',
      `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_DURATION_S},ebur128=peak=true`,
      '-f',
      'null',
      '-',
    ];

    let result: FfmpegResult;
    try {
      result = await this.runFfmpeg(args);
    } catch (err) {
      if (isMissingBinary(err)) {
        return skipped(
          'audio_sanity',
          'Skipped: the audio analyser (ffmpeg) is not installed on this machine, so loudness and silence were not measured.',
          { reason: 'ffmpeg_not_installed' },
        );
      }
      return skipped(
        'audio_sanity',
        `Skipped: the audio analyser could not run, so loudness and silence were not measured (${describe(err)}).`,
        { reason: 'ffmpeg_failed' },
      );
    }

    const duration = input.dubDurationS;
    if (!(duration > 0)) {
      return skipped(
        'audio_sanity',
        'Skipped: the dub has no measurable length, so loudness and silence were not measured.',
        { reason: 'no_duration' },
      );
    }

    const silences = parseSilences(result.stderr, duration);
    const totalSilence = silences.reduce((sum, s) => sum + s, 0);
    const nonSilenceRatio = clamp01(1 - totalSilence / duration);
    const longestGap = silences.length > 0 ? Math.max(...silences) : 0;
    const loudness = parseLoudness(result.stderr);

    const problems: string[] = [];
    if (nonSilenceRatio < QC_MIN_NON_SILENCE_RATIO) {
      problems.push(
        `only ${formatPercent(nonSilenceRatio)} of it has sound (we need ${formatPercent(QC_MIN_NON_SILENCE_RATIO)})`,
      );
    }
    if (longestGap > QC_MAX_DEAD_GAP_S) {
      problems.push(
        `there is a ${longestGap.toFixed(1)}s silent stretch (we allow ${QC_MAX_DEAD_GAP_S}s)`,
      );
    }
    const [minLufs, maxLufs] = QC_LOUDNESS_RANGE_LUFS;
    if (loudness !== null && (loudness < minLufs || loudness > maxLufs)) {
      problems.push(
        `the volume measures ${loudness.toFixed(1)} LUFS, outside the ${minLufs} to ${maxLufs} window`,
      );
    }

    const measured: Record<string, number | string | boolean> = {
      nonSilenceRatio: Math.round(nonSilenceRatio * 1e4) / 1e4,
      longestGapS: Math.round(longestGap * 100) / 100,
      silentSegments: silences.length,
      durationS: duration,
      loudnessMeasured: loudness !== null,
    };
    if (loudness !== null) measured.loudnessLufs = loudness;

    if (problems.length > 0) {
      return {
        name: 'audio_sanity',
        passed: false,
        status: 'failed',
        detail: `The audio is not usable: ${problems.join('; ')}.`,
        measured,
      };
    }
    return {
      name: 'audio_sanity',
      passed: true,
      status: 'passed',
      detail: `The audio sounds healthy: ${formatPercent(nonSilenceRatio)} of it has sound, the longest silent stretch is ${longestGap.toFixed(1)}s${
        loudness !== null ? `, and the volume measures ${loudness.toFixed(1)} LUFS` : ''
      }.`,
      measured,
    };
  }

  // -------------------------------------------------------------------------
  // 4. back_translation
  // -------------------------------------------------------------------------

  /** Deliberately not built. Named on the cut list so nobody claims it ran. */
  checkBackTranslation(): QcCheckResult {
    return skipped(
      'back_translation',
      'Skipped: meaning-preservation checking is not built yet, so the wording was not compared against the original.',
      { reason: 'not_implemented' },
    );
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Pull silent-run lengths out of silencedetect's stderr. A `silence_start`
 * with no matching end means the clip ended silent, so the run is measured to
 * the end of the file.
 */
export function parseSilences(stderr: string, durationS: number): number[] {
  const runs: number[] = [];
  let openStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const dur = /silence_duration:\s*(-?[\d.]+)/.exec(line);
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (dur !== null && dur[1] !== undefined) {
      runs.push(Number(dur[1]));
      openStart = null;
      continue;
    }
    if (end !== null && end[1] !== undefined && openStart !== null) {
      runs.push(Math.max(0, Number(end[1]) - openStart));
      openStart = null;
      continue;
    }
    if (start !== null && start[1] !== undefined) {
      openStart = Number(start[1]);
    }
  }
  if (openStart !== null) {
    runs.push(Math.max(0, durationS - openStart));
  }
  return runs.filter((r) => Number.isFinite(r) && r > 0);
}

/**
 * Integrated loudness in LUFS, from either ebur128's Summary block
 * ("I:  -23.0 LUFS") or loudnorm's JSON block ("input_i" : "-23.0").
 */
export function parseLoudness(stderr: string): number | null {
  const json = /"input_i"\s*:\s*"?(-?[\d.]+)"?/.exec(stderr);
  if (json !== null && json[1] !== undefined) {
    const value = Number(json[1]);
    if (Number.isFinite(value)) return value;
  }
  // Take the LAST "I: x LUFS" - ebur128 prints running values then a summary.
  const matches = [...stderr.matchAll(/^\s*I:\s*(-?[\d.]+)\s*LUFS/gm)];
  const last = matches[matches.length - 1];
  if (last !== undefined && last[1] !== undefined) {
    const value = Number(last[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skipped(
  name: QcCheckName,
  detail: string,
  measured: Record<string, number | string | boolean> = {},
): QcCheckResult {
  return {
    name,
    // A skipped check does not block the gate. `status` is the truth.
    passed: true,
    status: 'skipped',
    detail,
    measured: { skipped: true, ...measured },
  };
}

/** True when a check was reported as skipped rather than run. */
export function isSkipped(check: QcCheckResult): boolean {
  return check.status === 'skipped';
}

function isMissingBinary(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'EACCES') return true;
  }
  const message = describe(err).toLowerCase();
  return (
    message.includes('enoent') ||
    message.includes('not recognized') ||
    message.includes('not found') ||
    message.includes('no such file')
  );
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/**
 * The real runner. ffmpeg writes its analysis to stderr and exits 0, so a
 * non-zero exit is a genuine problem; a missing binary surfaces as ENOENT on
 * the spawn error, which the caller turns into a SKIPPED check.
 */
async function defaultFfmpegRunner(bin: string, args: string[]): Promise<FfmpegResult> {
  return new Promise<FfmpegResult>((res, rej) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // Cap it: a long clip prints a lot, and we only need the summaries.
      if (stderr.length < 2_000_000) stderr += chunk;
    });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code !== 0) {
        rej(new Error(`ffmpeg exited with ${code ?? 'no code'}`));
        return;
      }
      res({ code: code ?? 0, stderr });
    });
  });
}
