/**
 * QcService - the gate a dub must pass before anyone is asked to pay for it.
 *
 * Four checks, every one MEASURED from the actual files:
 *
 *   1. duration_match   ffprobe measures the dub (and the original, when the
 *                       file is available) - within QC_DURATION_TOLERANCE
 *   2. language_detect  the dub is transcribed and its spoken language
 *                       detected; it must be the language that was ordered
 *   3. audio_sanity     ffmpeg: enough sound, no long dead gap, sane loudness
 *   4. back_translation the original is transcribed too; the dub is translated
 *                       back to English and scored 0-100 on whether it says the
 *                       same thing (QC_MIN_MEANING_SCORE to pass)
 *
 * NO COMPANY CHECKS ITS OWN WORK. Dubs are made by ElevenLabs (or an agent's
 * own dubber). Everything that CHECKS a dub is someone else: ffmpeg measures,
 * xAI transcribes (speech-to-text) and judges meaning. No ElevenLabs product is
 * used here. If a dub was made with xAI, the checker would be grading itself,
 * so the language and meaning checks refuse and the dub is not published.
 *
 * FAIL CLOSED. A real dub is published only if every check actually ran and
 * passed. A check that could not run (no key, no ffmpeg, an unreachable
 * service) is reported honestly as "not verified" - and that blocks
 * publishing. Only the simulated stand-in dub, which has no real speech, may
 * pass with skipped checks; it is labelled simulated everywhere.
 *
 * The returned report validates against qcReportSchema in @parrot/shared. The
 * extra `status` field on each check is additive - zod strips it on parse.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  QC_DURATION_TOLERANCE,
  QC_MIN_MEANING_SCORE,
  QC_MIN_NON_SILENCE_RATIO,
  QC_MAX_DEAD_GAP_S,
  QC_LOUDNESS_RANGE_LUFS,
  languageName,
  normalizeLanguageCode,
  type QcReport,
} from '@parrot/shared';
import { getConfig } from '../config.js';
import { JUDGE_NAME, judgeDub } from './qc-judge.js';

/** Who checks dubs. Must never be the company that made the dub. */
export const CHECKER_VENDOR = 'xAI';
const CHECKER_VENDOR_PATTERN = /\b(xai|grok)\b/i;

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
  /** False when the check failed - or, for a real dub, could not be verified. */
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
  /** Local path to the dub. */
  readonly dubPath: string;
  /**
   * The original's length from the post's own metadata. Used only when the
   * original file itself is not available to measure.
   */
  readonly sourceDurationS: number;
  /** The language the dub is supposed to be in. */
  readonly targetLang: string;
  /**
   * True when the "dub" is the stand-in fixture rather than a real render. It
   * has no real speech, so the speech checks are skipped and it is labelled
   * simulated everywhere.
   */
  readonly simulated?: boolean;
  /** The original clip: a local path or an https URL. */
  readonly sourcePath?: string;
  /** Who made the dub, e.g. "ElevenLabs". */
  readonly dubProvider?: string;
  /** Length of the simulated stand-in only; real dubs are always measured. */
  readonly dubDurationS?: number;
}

interface Transcript {
  readonly text: string;
  /** As reported by the speech service, e.g. "es-mx". */
  readonly language: string;
}

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface FfmpegResult {
  readonly code: number;
  readonly stderr: string;
}

/** Throw with `.code === 'ENOENT'` (or any error) when ffmpeg is absent. */
export type FfmpegRunner = (args: string[]) => Promise<FfmpegResult>;
/** Length of a media file in seconds. Throws when it cannot be measured. */
export type DurationProbe = (pathOrUrl: string) => Promise<number>;

export interface QcServiceDeps {
  readonly fetchImpl?: FetchImpl;
  readonly now?: () => Date;
  readonly runFfmpeg?: FfmpegRunner;
  readonly probeDuration?: DurationProbe;
  readonly ffmpegPath?: string;
  readonly requestTimeoutMs?: number;
}

export class QcService {
  private readonly fetchImpl: FetchImpl;
  private readonly now: () => Date;
  private readonly runFfmpeg: FfmpegRunner;
  private readonly probeDuration: DurationProbe;
  private readonly requestTimeoutMs: number;

  constructor(deps: QcServiceDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => new Date());
    const ffmpegPath = deps.ffmpegPath ?? 'ffmpeg';
    this.runFfmpeg = deps.runFfmpeg ?? ((args) => runBinary(ffmpegPath, args));
    this.probeDuration = deps.probeDuration ?? ((target) => defaultProbe(ffprobeFor(ffmpegPath), target));
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 60_000;
  }

  /** Run the whole gate. Never throws for a failing dub - it reports. */
  async run(input: QcInput): Promise<QcServiceReport> {
    const conflict = this.conflict(input);
    const dubLength = await this.measure(input.dubPath, input);

    const duration = await this.checkDuration(input, dubLength);
    const heard = await this.languageAndTranscript(input, conflict);
    const audio = await this.checkAudioSanity(input, dubLength);
    const meaning = await this.checkMeaning(input, heard.transcript, conflict);

    let checks: QcCheckResult[] = [duration, heard.check, audio, meaning];
    if (input.simulated !== true) {
      // Fail closed: for a real dub, "could not check" is not a pass.
      checks = checks.map((c) =>
        c.status === 'skipped'
          ? { ...c, passed: false, detail: `Not verified, so not published. ${c.detail}` }
          : c,
      );
    }
    const passed = checks.every((c) => c.passed);
    return { passed, checks, ranAt: this.now() };
  }

  /** A dub made by the checker's own company cannot be judged by it. */
  private conflict(input: QcInput): string | null {
    if (input.dubProvider && CHECKER_VENDOR_PATTERN.test(input.dubProvider)) {
      return `this dub was made with ${input.dubProvider}, and ${CHECKER_VENDOR} is also our checker, so it would be grading its own work`;
    }
    return null;
  }

  /** The real length of a file, or null if it cannot be measured. */
  private async measure(target: string, input: QcInput): Promise<number | null> {
    if (input.simulated === true) {
      return input.dubDurationS && input.dubDurationS > 0 ? input.dubDurationS : null;
    }
    try {
      const seconds = await this.probeDuration(target);
      return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 1. duration_match
  // -------------------------------------------------------------------------

  async checkDuration(input: QcInput, dubLength: number | null): Promise<QcCheckResult> {
    if (input.simulated === true) {
      return skipped(
        'duration_match',
        'Skipped: this dub is a simulated stand-in, so its length says nothing about a real dub.',
        { reason: 'simulated_dub' },
      );
    }
    if (dubLength === null) {
      return skipped(
        'duration_match',
        'Skipped: the dub file could not be measured (is ffmpeg installed?).',
        { reason: 'dub_unmeasurable' },
      );
    }
    // Prefer measuring the original file; fall back to the post's own metadata.
    const measuredSource = input.sourcePath ? await this.measure(input.sourcePath, input) : null;
    const sourceLength = measuredSource ?? (input.sourceDurationS > 0 ? input.sourceDurationS : null);
    const sourceFrom = measuredSource !== null ? 'file' : 'post metadata';
    if (sourceLength === null) {
      return skipped(
        'duration_match',
        'Skipped: the original has no measurable length to compare against.',
        { reason: 'source_unmeasurable' },
      );
    }

    const drift = Math.abs(dubLength - sourceLength) / sourceLength;
    // Rounded to 6 places so a boundary case at exactly the tolerance is not
    // tipped over by floating point noise.
    const rounded = Math.round(drift * 1e6) / 1e6;
    const ok = rounded <= QC_DURATION_TOLERANCE;
    return {
      name: 'duration_match',
      passed: ok,
      status: ok ? 'passed' : 'failed',
      detail: `The dub runs ${dubLength.toFixed(1)}s against the original ${sourceLength.toFixed(1)}s, ${formatPercent(rounded)} off - ${
        ok ? 'inside' : 'outside'
      } the ${formatPercent(QC_DURATION_TOLERANCE)} allowance.`,
      measured: {
        sourceDurationS: round2(sourceLength),
        dubDurationS: round2(dubLength),
        sourceFrom,
        driftRatio: rounded,
        tolerance: QC_DURATION_TOLERANCE,
      },
    };
  }

  // -------------------------------------------------------------------------
  // 2. language_detect
  // -------------------------------------------------------------------------

  private async languageAndTranscript(
    input: QcInput,
    conflict: string | null,
  ): Promise<{ check: QcCheckResult; transcript: Transcript | null }> {
    const only = (check: QcCheckResult) => ({ check, transcript: null });
    if (input.simulated === true) {
      return only(
        skipped(
          'language_detect',
          'Skipped: this dub is a simulated stand-in, so there is no real speech to verify.',
          { reason: 'simulated_dub' },
        ),
      );
    }
    if (conflict) {
      return only(failed('language_detect', `No independent checker: ${conflict}.`, { reason: 'checker_conflict' }));
    }
    if (!getConfig().env.XAI_API_KEY) {
      return only(
        skipped(
          'language_detect',
          'Skipped: the independent speech checker is not configured, so the spoken language was not verified.',
          { reason: 'no_credentials' },
        ),
      );
    }

    let transcript: Transcript;
    try {
      transcript = await this.transcribe(input.dubPath);
    } catch (err) {
      return only(
        skipped(
          'language_detect',
          `Skipped: the independent speech checker could not be reached (${describe(err)}).`,
          { reason: 'checker_unreachable' },
        ),
      );
    }

    // "es-mx" and "spa" both become "es".
    const heard = normalizeLanguageCode(transcript.language);
    const want = normalizeLanguageCode(input.targetLang);
    const measured = { detected: heard, expected: want, checker: CHECKER_VENDOR };
    if (transcript.text.trim() === '') {
      return {
        check: failed('language_detect', 'No speech was heard in the dub.', measured),
        transcript,
      };
    }
    const ok = heard === want;
    return {
      check: {
        name: 'language_detect',
        passed: ok,
        status: ok ? 'passed' : 'failed',
        detail: ok
          ? `The dub is ${languageName(want)} (heard by ${CHECKER_VENDOR}, independent of ${input.dubProvider ?? 'the dubber'}).`
          : `The dub sounds like ${languageName(heard)}, not the ${languageName(want)} that was ordered.`,
        measured,
      },
      transcript,
    };
  }

  /**
   * xAI speech-to-text, POST /v1/stt. The language is deliberately NOT sent:
   * the point is that the checker tells US what it hears.
   */
  private async transcribe(pathOrUrl: string): Promise<Transcript> {
    const env = getConfig().env;
    if (!env.XAI_API_KEY) throw new Error('no speech checker credentials');

    const bytes = /^https?:\/\//.test(pathOrUrl) ? await this.download(pathOrUrl) : await readFile(pathOrUrl);
    const form = new FormData();
    form.set('model', env.XAI_STT_MODEL);
    form.set('file', new Blob([new Uint8Array(bytes)]), pathOrUrl.split(/[\\/?]/).filter(Boolean).pop() ?? 'audio');

    const base = (env.XAI_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/$/, '');
    const res = await this.fetchImpl(`${base}/stt`, {
      method: 'POST',
      // The key lives in this header and nowhere else. It is never logged.
      headers: { authorization: `Bearer ${env.XAI_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) throw new Error(`speech checker returned ${res.status}`);
    const json = (await res.json()) as { text?: unknown; language?: unknown };
    if (typeof json.text !== 'string' || typeof json.language !== 'string') {
      throw new Error('speech checker returned an unreadable response');
    }
    return { text: json.text, language: json.language };
  }

  /** Fetch a remote original clip, capped so a huge file cannot stall QC. */
  private async download(url: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.requestTimeoutMs) });
    if (!res.ok) throw new Error(`the original clip returned ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > 100 * 1024 * 1024) throw new Error('the original clip is over 100 MB');
    return buf;
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
  async checkAudioSanity(input: QcInput, dubLength: number | null): Promise<QcCheckResult> {
    if (input.simulated === true) {
      return skipped(
        'audio_sanity',
        'Skipped: this dub is a simulated stand-in, so there is no real audio to analyse.',
        { reason: 'simulated_dub' },
      );
    }
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

    if (dubLength === null) {
      return skipped(
        'audio_sanity',
        'Skipped: the dub has no measurable length, so loudness and silence were not measured.',
        { reason: 'no_duration' },
      );
    }

    const silences = parseSilences(result.stderr, dubLength);
    const totalSilence = silences.reduce((sum, s) => sum + s, 0);
    const nonSilenceRatio = clamp01(1 - totalSilence / dubLength);
    const longestGap = silences.length > 0 ? Math.max(...silences) : 0;
    const loudness = parseLoudness(result.stderr);

    const problems: string[] = [];
    if (nonSilenceRatio < QC_MIN_NON_SILENCE_RATIO) {
      problems.push(
        `only ${formatPercent(nonSilenceRatio)} of it has sound (we need ${formatPercent(QC_MIN_NON_SILENCE_RATIO)})`,
      );
    }
    if (longestGap > QC_MAX_DEAD_GAP_S) {
      problems.push(`there is a ${longestGap.toFixed(1)}s silent stretch (we allow ${QC_MAX_DEAD_GAP_S}s)`);
    }
    const [minLufs, maxLufs] = QC_LOUDNESS_RANGE_LUFS;
    if (loudness !== null && (loudness < minLufs || loudness > maxLufs)) {
      problems.push(`the volume measures ${loudness.toFixed(1)} LUFS, outside the ${minLufs} to ${maxLufs} window`);
    }

    const measured: Record<string, number | string | boolean> = {
      nonSilenceRatio: Math.round(nonSilenceRatio * 1e4) / 1e4,
      longestGapS: Math.round(longestGap * 100) / 100,
      silentSegments: silences.length,
      durationS: round2(dubLength),
      loudnessMeasured: loudness !== null,
    };
    if (loudness !== null) measured.loudnessLufs = loudness;

    if (problems.length > 0) {
      return failed('audio_sanity', `The audio is not usable: ${problems.join('; ')}.`, measured);
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
  // 4. back_translation (the meaning check)
  // -------------------------------------------------------------------------

  async checkMeaning(input: QcInput, dubTranscript: Transcript | null, conflict: string | null): Promise<QcCheckResult> {
    const env = getConfig().env;
    if (input.simulated === true) {
      return skipped(
        'back_translation',
        'Skipped: this dub is a simulated stand-in, so there is no real speech to compare.',
        { reason: 'simulated_dub' },
      );
    }
    if (conflict) {
      return failed('back_translation', `No independent checker: ${conflict}.`, { reason: 'checker_conflict' });
    }
    if (!env.XAI_API_KEY) {
      return skipped('back_translation', 'Skipped: no independent checker is configured, so the meaning was not checked.', {
        reason: 'no_judge',
      });
    }
    if (!dubTranscript || dubTranscript.text.trim() === '') {
      return skipped('back_translation', 'Skipped: the dub could not be transcribed, so its meaning could not be compared.', {
        reason: 'no_dub_transcript',
      });
    }
    if (!input.sourcePath) {
      return skipped('back_translation', 'Skipped: the original clip is not available to compare against.', {
        reason: 'no_source',
      });
    }
    let source: Transcript;
    try {
      source = await this.transcribe(input.sourcePath);
    } catch (err) {
      return skipped('back_translation', `Skipped: the original clip could not be transcribed (${describe(err)}).`, {
        reason: 'source_unreadable',
      });
    }
    const verdict = await judgeDub(
      { sourceText: source.text, dubText: dubTranscript.text, targetLang: input.targetLang },
      { apiKey: env.XAI_API_KEY, baseUrl: env.XAI_BASE_URL, model: env.XAI_MODEL, fetchImpl: this.fetchImpl },
    );
    if (!verdict) {
      return skipped('back_translation', 'Skipped: the independent judge could not be reached.', {
        reason: 'judge_unreachable',
      });
    }
    const ok = verdict.meaningScore >= QC_MIN_MEANING_SCORE;
    return {
      name: 'back_translation',
      passed: ok,
      status: ok ? 'passed' : 'failed',
      detail: `${ok ? 'The dub keeps the meaning' : 'The dub changes the meaning'}: ${verdict.meaningScore}/100 (we require ${QC_MIN_MEANING_SCORE}). ${verdict.reason}`,
      measured: {
        judge: JUDGE_NAME,
        meaningScore: verdict.meaningScore,
        minimum: QC_MIN_MEANING_SCORE,
        originalText: source.text.slice(0, 300),
        backTranslation: verdict.backTranslation.slice(0, 300),
      },
    };
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
  // `passed` is true here only so a SIMULATED dub is not blocked; run() turns
  // every skip on a real dub into a block. `status` is always the truth.
  return { name, passed: true, status: 'skipped', detail, measured: { skipped: true, ...measured } };
}

function failed(
  name: QcCheckName,
  detail: string,
  measured: Record<string, number | string | boolean> = {},
): QcCheckResult {
  return { name, passed: false, status: 'failed', detail, measured };
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  const rounded = Math.round(pct * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}

/** ffprobe lives next to ffmpeg; a bare "ffmpeg" means "on PATH". */
function ffprobeFor(ffmpegPath: string): string {
  if (ffmpegPath === 'ffmpeg') return 'ffprobe';
  return join(dirname(ffmpegPath), ffmpegPath.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe');
}

/** Measure a media file's length with ffprobe. */
async function defaultProbe(ffprobePath: string, target: string): Promise<number> {
  const { stdout } = await runBinary(ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    target,
  ]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('ffprobe found no duration');
  return seconds;
}

/**
 * Run ffmpeg/ffprobe. ffmpeg writes its analysis to stderr and exits 0, so a
 * non-zero exit is a genuine problem; a missing binary surfaces as ENOENT on
 * the spawn error, which the caller turns into an honest "not verified".
 */
async function runBinary(bin: string, args: string[]): Promise<FfmpegResult & { stdout: string }> {
  return new Promise((res, rej) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 100_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      // Cap it: a long clip prints a lot, and we only need the summaries.
      if (stderr.length < 2_000_000) stderr += chunk;
    });
    child.on('error', rej);
    child.on('close', (code) => {
      if (code !== 0) {
        rej(new Error(`${bin} exited with ${code ?? 'no code'}`));
        return;
      }
      res({ code: code ?? 0, stderr, stdout });
    });
  });
}
