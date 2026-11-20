import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  qcReportSchema,
  QC_DURATION_TOLERANCE,
  QC_MIN_LANGUAGE_CONFIDENCE,
  FORBIDDEN_WORDS,
} from '@parrot/shared';
import {
  QcService,
  parseSilences,
  parseLoudness,
  isSkipped,
  type QcCheckResult,
  type QcServiceReport,
} from '../src/services/qc-service.js';
import { resetConfig } from '../src/config.js';

const API_KEY = 'xi-secret-key-that-must-never-be-logged';
const FIXTURES = resolve(fileURLToPath(new URL('.', import.meta.url)), '../fixtures');

const GOOD_DUB = resolve(FIXTURES, 'good-dub.wav');
const SILENT_DUB = resolve(FIXTURES, 'silent-dub.wav');
const TRUNCATED_DUB = resolve(FIXTURES, 'truncated-dub.wav');
const WRONG_LANGUAGE_DUB = resolve(FIXTURES, 'wrong-language-dub.wav');

function sttEnv(enabled: boolean): void {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  if (enabled) {
    process.env.ELEVENLABS_API_KEY = API_KEY;
  } else {
    delete process.env.ELEVENLABS_API_KEY;
  }
  resetConfig();
}

/** An STT stand-in. Never a real request. */
function sttFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

/** ffmpeg stand-in: hands back canned stderr. */
function ffmpegStderr(stderr: string) {
  return async () => ({ code: 0, stderr });
}

/** ffmpeg stand-in for a machine with no ffmpeg installed. */
const ffmpegMissing = async (): Promise<never> => {
  const err = new Error('spawn ffmpeg ENOENT') as Error & { code: string };
  err.code = 'ENOENT';
  throw err;
};

const GOOD_FFMPEG_STDERR = [
  '[silencedetect @ 0x1] silence_start: 2.0',
  '[silencedetect @ 0x1] silence_end: 3.2 | silence_duration: 1.2',
  '[Parsed_ebur128_1 @ 0x2] Summary:',
  '',
  '  Integrated loudness:',
  '    I:         -18.4 LUFS',
  '    Threshold: -28.6 LUFS',
].join('\n');

function find(report: QcServiceReport, name: QcCheckResult['name']): QcCheckResult {
  const check = report.checks.find((c) => c.name === name);
  if (check === undefined) throw new Error(`no ${name} check in the report`);
  return check;
}

afterEach(() => {
  delete process.env.ELEVENLABS_API_KEY;
  resetConfig();
});

// ---------------------------------------------------------------------------

describe('QcService - duration_match', () => {
  beforeEach(() => sttEnv(false));

  const svc = () => new QcService({ runFfmpeg: ffmpegMissing });

  it('passes a dub at exactly the tolerance boundary', () => {
    expect(QC_DURATION_TOLERANCE).toBe(0.1);
    const check = svc().checkDuration({
      dubPath: GOOD_DUB,
      sourceDurationS: 100,
      dubDurationS: 110, // exactly +10%
      targetLang: 'es',
    });
    expect(check.status).toBe('passed');
    expect(check.measured?.driftRatio).toBe(0.1);
  });

  it('passes at exactly the tolerance boundary on the short side', () => {
    const check = svc().checkDuration({
      dubPath: TRUNCATED_DUB,
      sourceDurationS: 100,
      dubDurationS: 90,
      targetLang: 'es',
    });
    expect(check.status).toBe('passed');
  });

  it('fails just past the boundary', () => {
    const check = svc().checkDuration({
      dubPath: GOOD_DUB,
      sourceDurationS: 100,
      dubDurationS: 110.1,
      targetLang: 'es',
    });
    expect(check.status).toBe('failed');
    expect(check.passed).toBe(false);
  });

  it('fails a truncated dub', () => {
    const check = svc().checkDuration({
      dubPath: TRUNCATED_DUB,
      sourceDurationS: 100,
      dubDurationS: 40,
      targetLang: 'es',
    });
    expect(check.status).toBe('failed');
    expect(check.detail).toContain('40.0s');
  });
});

// ---------------------------------------------------------------------------

describe('QcService - language_detect', () => {
  const input = {
    dubPath: GOOD_DUB,
    sourceDurationS: 1,
    dubDurationS: 1,
    targetLang: 'es',
  };

  it('passes when the right language is heard confidently', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({
      language_code: 'es',
      language_probability: 0.97,
      text: 'hola, buenos dias',
    });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });
    const check = await svc.checkLanguage(input);

    expect(check.status).toBe('passed');
    expect(check.measured?.confidence).toBe(0.97);
    expect(fetchImpl.calls[0]?.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    const body = fetchImpl.calls[0]?.init?.body as FormData;
    expect(body.get('model_id')).toBe('scribe_v3');
    // language_code must NOT be sent - auto-detect is the entire point.
    expect(body.get('language_code')).toBeNull();
    expect((fetchImpl.calls[0]?.init?.headers as Record<string, string>)['xi-api-key']).toBe(
      API_KEY,
    );
  });

  it('passes on the three-letter code the real service sends ("spa", not "es")', async () => {
    // Exactly what ElevenLabs returned for a real Spanish dub on 2026-11-19.
    // The earlier tests faked "es", which is why a correct dub once failed QC.
    sttEnv(true);
    const fetchImpl = sttFetch({
      language_code: 'spa',
      language_probability: 0.9858934879302979,
      text: 'esto es lo que nadie te dice sobre cocinar con poco dinero',
    });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });
    const check = await svc.checkLanguage(input);

    expect(check.status).toBe('passed');
    expect(check.measured).toMatchObject({ detected: 'es', expected: 'es' });
  });

  it('still fails a wrong language reported as a three-letter code', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({ language_code: 'fra', language_probability: 0.99, text: 'bonjour' });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });
    const check = await svc.checkLanguage(input);

    expect(check.status).toBe('failed');
    expect(check.detail).toContain('French');
  });

  it('fails when the dub is in the wrong language', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({
      language_code: 'fr',
      language_probability: 0.99,
      text: 'bonjour tout le monde',
    });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });
    const check = await svc.checkLanguage({ ...input, dubPath: WRONG_LANGUAGE_DUB });

    expect(check.status).toBe('failed');
    expect(check.passed).toBe(false);
    expect(check.detail).toContain('French');
    expect(check.detail).toContain('Spanish');
  });

  it('fails when confidence is below the floor', async () => {
    sttEnv(true);
    expect(QC_MIN_LANGUAGE_CONFIDENCE).toBe(0.6);
    const fetchImpl = sttFetch({
      language_code: 'es',
      language_probability: 0.42,
      text: '...',
    });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });
    const check = await svc.checkLanguage(input);

    expect(check.status).toBe('failed');
    expect(check.detail).toContain('42%');
  });

  it('passes at exactly the confidence floor', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({ language_code: 'es', language_probability: 0.6, text: 'hola' });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });
    expect((await svc.checkLanguage(input)).status).toBe('passed');
  });

  it('accepts the ISO 639-3 code Scribe actually returns ("spa" for "es")', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({ language_code: 'spa', language_probability: 0.93, text: 'hola' });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });
    const check = await svc.checkLanguage(input);
    expect(check.status).toBe('passed');
    expect(check.measured?.detected).toBe('es');
  });

  it('reads the multi-channel transcripts shape', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({
      transcripts: [{ language_code: 'es', language_probability: 0.91, text: 'hola' }],
    });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });
    const check = await svc.checkLanguage(input);
    expect(check.status).toBe('passed');
    expect(check.measured?.confidence).toBe(0.91);
  });

  it('is SKIPPED, not passed, when no credentials are configured', async () => {
    sttEnv(false);
    const svc = new QcService({ runFfmpeg: ffmpegMissing });
    const check = await svc.checkLanguage(input);
    expect(check.status).toBe('skipped');
    expect(isSkipped(check)).toBe(true);
    expect(check.measured?.skipped).toBe(true);
    expect(check.detail).toMatch(/^Skipped:/);
  });

  it('is SKIPPED when the provider errors, and never leaks the key', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({ detail: 'nope' }, 503);
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });
    const check = await svc.checkLanguage(input);
    expect(check.status).toBe('skipped');
    expect(check.detail).toContain('503');
    expect(check.detail).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------

describe('QcService - audio_sanity', () => {
  beforeEach(() => sttEnv(false));

  it('is SKIPPED with a reason when ffmpeg is not installed', async () => {
    const svc = new QcService({ runFfmpeg: ffmpegMissing });
    const check = await svc.checkAudioSanity({
      dubPath: GOOD_DUB,
      sourceDurationS: 10,
      dubDurationS: 10,
      targetLang: 'es',
    });

    expect(check.status).toBe('skipped');
    expect(check.status).not.toBe('passed');
    expect(check.measured?.reason).toBe('ffmpeg_not_installed');
    expect(check.detail).toContain('ffmpeg');
    expect(check.detail).toMatch(/^Skipped:/);
  });

  it('passes healthy audio', async () => {
    const svc = new QcService({ runFfmpeg: ffmpegStderr(GOOD_FFMPEG_STDERR) });
    const check = await svc.checkAudioSanity({
      dubPath: GOOD_DUB,
      sourceDurationS: 30,
      dubDurationS: 30,
      targetLang: 'es',
    });
    expect(check.status).toBe('passed');
    expect(check.measured?.loudnessLufs).toBe(-18.4);
    expect(check.measured?.nonSilenceRatio).toBeCloseTo(0.96, 2);
  });

  it('fails a silent dub', async () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 0',
      '[silencedetect @ 0x1] silence_end: 9.5 | silence_duration: 9.5',
      '    I:         -70.0 LUFS',
    ].join('\n');
    const svc = new QcService({ runFfmpeg: ffmpegStderr(stderr) });
    const check = await svc.checkAudioSanity({
      dubPath: SILENT_DUB,
      sourceDurationS: 10,
      dubDurationS: 10,
      targetLang: 'es',
    });
    expect(check.status).toBe('failed');
    expect(check.detail).toContain('5%');
    expect(check.measured?.nonSilenceRatio).toBeCloseTo(0.05, 3);
  });

  it('fails on a dead gap longer than the limit', async () => {
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 5.0',
      '[silencedetect @ 0x1] silence_end: 12.0 | silence_duration: 7.0',
      '    I:         -16.0 LUFS',
    ].join('\n');
    const svc = new QcService({ runFfmpeg: ffmpegStderr(stderr) });
    const check = await svc.checkAudioSanity({
      dubPath: GOOD_DUB,
      sourceDurationS: 60,
      dubDurationS: 60,
      targetLang: 'es',
    });
    expect(check.status).toBe('failed');
    expect(check.detail).toContain('7.0s silent stretch');
  });

  it('fails when loudness falls outside the window', async () => {
    const stderr = '    I:         -3.2 LUFS';
    const svc = new QcService({ runFfmpeg: ffmpegStderr(stderr) });
    const check = await svc.checkAudioSanity({
      dubPath: GOOD_DUB,
      sourceDurationS: 20,
      dubDurationS: 20,
      targetLang: 'es',
    });
    expect(check.status).toBe('failed');
    expect(check.detail).toContain('-3.2 LUFS');
  });

  it('reads loudnorm JSON output too', () => {
    expect(parseLoudness('  "input_i" : "-23.7",\n  "input_tp" : "-2.0"')).toBe(-23.7);
    expect(parseLoudness('nothing useful here')).toBeNull();
  });

  it('counts a silence that runs to the end of the file', () => {
    expect(parseSilences('[silencedetect] silence_start: 4.0', 10)).toEqual([6]);
    expect(parseSilences('no silence here', 10)).toEqual([]);
  });

  it('is SKIPPED when ffmpeg runs but fails for another reason', async () => {
    const svc = new QcService({
      runFfmpeg: async () => {
        throw new Error('ffmpeg exited with 1');
      },
    });
    const check = await svc.checkAudioSanity({
      dubPath: GOOD_DUB,
      sourceDurationS: 10,
      dubDurationS: 10,
      targetLang: 'es',
    });
    expect(check.status).toBe('skipped');
    expect(check.measured?.reason).toBe('ffmpeg_failed');
  });
});

// ---------------------------------------------------------------------------

describe('QcService - back_translation', () => {
  it('is reported as not implemented, never as a pass', () => {
    const check = new QcService().checkBackTranslation();
    expect(check.status).toBe('skipped');
    expect(check.measured?.reason).toBe('not_implemented');
    expect(check.detail).toMatch(/^Skipped:/);
  });
});

// ---------------------------------------------------------------------------

describe('QcService - the whole gate', () => {
  it('passes a good dub, with the unrunnable checks marked skipped', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({ language_code: 'es', language_probability: 0.95, text: 'hola' });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });

    const report = await svc.run({
      dubPath: GOOD_DUB,
      sourceDurationS: 60,
      dubDurationS: 62,
      targetLang: 'es',
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(4);
    expect(find(report, 'duration_match').status).toBe('passed');
    expect(find(report, 'language_detect').status).toBe('passed');
    // ffmpeg is not installed on this machine: skipped, and we say so.
    expect(find(report, 'audio_sanity').status).toBe('skipped');
    expect(find(report, 'back_translation').status).toBe('skipped');
    expect(qcReportSchema.safeParse(report).success).toBe(true);
  });

  it('fails the whole gate when the language is wrong', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({ language_code: 'fr', language_probability: 0.98, text: 'bonjour' });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });

    const report = await svc.run({
      dubPath: WRONG_LANGUAGE_DUB,
      sourceDurationS: 60,
      dubDurationS: 60,
      targetLang: 'es',
    });

    expect(report.passed).toBe(false);
    expect(find(report, 'language_detect').passed).toBe(false);
    expect(qcReportSchema.safeParse(report).success).toBe(true);
  });

  it('fails the whole gate on a truncated dub', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({ language_code: 'es', language_probability: 0.95, text: 'hola' });
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegMissing });

    const report = await svc.run({
      dubPath: TRUNCATED_DUB,
      sourceDurationS: 60,
      dubDurationS: 24,
      targetLang: 'es',
    });

    expect(report.passed).toBe(false);
    expect(find(report, 'duration_match').passed).toBe(false);
  });

  it('fails the whole gate on silent audio when ffmpeg IS available', async () => {
    sttEnv(true);
    const fetchImpl = sttFetch({ language_code: 'es', language_probability: 0.9, text: '' });
    const stderr = [
      '[silencedetect @ 0x1] silence_start: 0',
      '[silencedetect @ 0x1] silence_end: 29.0 | silence_duration: 29.0',
      '    I:         -70.0 LUFS',
    ].join('\n');
    const svc = new QcService({ fetchImpl: fetchImpl.impl, runFfmpeg: ffmpegStderr(stderr) });

    const report = await svc.run({
      dubPath: SILENT_DUB,
      sourceDurationS: 30,
      dubDurationS: 30,
      targetLang: 'es',
    });

    expect(report.passed).toBe(false);
    expect(find(report, 'audio_sanity').status).toBe('failed');
  });

  it('a skipped check alone never fails the gate', async () => {
    sttEnv(false); // no STT credentials either
    const svc = new QcService({ runFfmpeg: ffmpegMissing });
    const report = await svc.run({
      dubPath: GOOD_DUB,
      sourceDurationS: 10,
      dubDurationS: 10,
      targetLang: 'es',
    });
    expect(report.passed).toBe(true);
    expect(report.checks.filter(isSkipped)).toHaveLength(3);
  });

  it('produces plain detail lines a dashboard can print', async () => {
    sttEnv(false);
    const svc = new QcService({ runFfmpeg: ffmpegMissing });
    const report = await svc.run({
      dubPath: GOOD_DUB,
      sourceDurationS: 10,
      dubDurationS: 10,
      targetLang: 'es',
    });
    for (const check of report.checks) {
      expect(check.detail.length).toBeGreaterThan(10);
      for (const word of FORBIDDEN_WORDS) {
        expect(check.detail.toLowerCase()).not.toMatch(
          new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
        );
      }
    }
  });
});
