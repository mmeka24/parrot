import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qcReportSchema, QC_DURATION_TOLERANCE, FORBIDDEN_WORDS } from '@parrot/shared';
import {
  QcService,
  parseSilences,
  parseLoudness,
  isSkipped,
  type QcCheckResult,
  type QcServiceReport,
  type QcInput,
} from '../src/services/qc-service.js';
import { resetConfig } from '../src/config.js';

const XAI_KEY = 'xai-secret-key-that-must-never-be-logged';
const FIXTURES = resolve(fileURLToPath(new URL('.', import.meta.url)), '../fixtures');
const DUB = resolve(FIXTURES, 'good-dub.wav');
const ORIGINAL = resolve(FIXTURES, 'mock-dub.wav');

function env(withChecker: boolean): void {
  process.env.DATABASE_URL = 'postgres://localhost/parrot_test';
  if (withChecker) process.env.XAI_API_KEY = XAI_KEY;
  else delete process.env.XAI_API_KEY;
  resetConfig();
}

beforeEach(() => env(true));
afterEach(() => {
  delete process.env.XAI_API_KEY;
  resetConfig();
});

/**
 * A stand-in for the INDEPENDENT checker (xAI): speech-to-text answers, then
 * the meaning judge. Records every URL so tests can prove which companies
 * were asked. Never a real request.
 */
function checker(opts: {
  dub?: { text: string; language: string };
  original?: { text: string; language: string };
  meaningScore?: number;
  sttStatus?: number;
}) {
  const urls: string[] = [];
  let stt = 0;
  const impl = async (url: string): Promise<Response> => {
    urls.push(url);
    if (url.endsWith('/stt')) {
      stt++;
      if (opts.sttStatus && opts.sttStatus !== 200) return new Response('{}', { status: opts.sttStatus });
      const body = stt === 1 ? (opts.dub ?? { text: 'Hola a todos', language: 'es-mx' }) : (opts.original ?? { text: 'Hi everyone', language: 'en' });
      return new Response(JSON.stringify({ ...body, duration: 7 }), { status: 200 });
    }
    const verdict = {
      language: 'es',
      backTranslation: 'Hello everyone, today we cook pasta.',
      meaningScore: opts.meaningScore ?? 94,
      reason: 'Same message.',
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }), { status: 200 });
  };
  return { impl, urls };
}

/** Healthy ffmpeg analysis output. */
const HEALTHY_AUDIO = [
  '[silencedetect @ 0x1] silence_start: 2.0',
  '[silencedetect @ 0x1] silence_end: 3.2 | silence_duration: 1.2',
  '[Parsed_ebur128_1 @ 0x2] Summary:',
  '    I:         -18.4 LUFS',
].join('\n');
const ffmpegOk = (stderr = HEALTHY_AUDIO) => async () => ({ code: 0, stderr });
const ffmpegMissing = async (): Promise<never> => {
  const err = new Error('spawn ffmpeg ENOENT') as Error & { code: string };
  err.code = 'ENOENT';
  throw err;
};

/** ffprobe stand-in: real lengths per file. */
const lengths = (dub: number, original?: number) => async (target: string) => {
  if (target === DUB) return dub;
  if (original !== undefined && target === ORIGINAL) return original;
  throw new Error('cannot measure');
};

function svc(over: {
  fetchImpl?: ReturnType<typeof checker>['impl'];
  probe?: (t: string) => Promise<number>;
  ffmpeg?: () => Promise<{ code: number; stderr: string }>;
} = {}) {
  return new QcService({
    fetchImpl: over.fetchImpl ?? checker({}).impl,
    probeDuration: over.probe ?? lengths(30, 30),
    runFfmpeg: over.ffmpeg ?? ffmpegOk(),
  });
}

const REAL: QcInput = {
  dubPath: DUB,
  sourceDurationS: 30,
  targetLang: 'es',
  sourcePath: ORIGINAL,
  dubProvider: 'ElevenLabs',
};

function find(report: QcServiceReport, name: QcCheckResult['name']): QcCheckResult {
  const check = report.checks.find((c) => c.name === name);
  if (check === undefined) throw new Error(`no ${name} check in the report`);
  return check;
}

// ---------------------------------------------------------------------------

describe('QC - a good real dub', () => {
  it('passes only when all four checks actually ran and passed', async () => {
    const report = await svc().run(REAL);
    expect(report.passed).toBe(true);
    expect(report.checks.map((c) => c.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(qcReportSchema.safeParse(report).success).toBe(true);
  });

  it('never asks ElevenLabs (the dubber) to check its own dub', async () => {
    const c = checker({});
    await svc({ fetchImpl: c.impl }).run(REAL);
    expect(c.urls.length).toBeGreaterThan(0);
    expect(c.urls.every((u) => u.startsWith('https://api.x.ai/'))).toBe(true);
    expect(c.urls.some((u) => u.includes('elevenlabs'))).toBe(false);
  });
});

describe('QC - length is measured, not assumed', () => {
  it('measures both files and fails a dub that is too short', async () => {
    const report = await svc({ probe: lengths(20, 30) }).run(REAL);
    const check = find(report, 'duration_match');
    expect(check.status).toBe('failed');
    expect(check.measured?.dubDurationS).toBe(20);
    expect(check.measured?.sourceFrom).toBe('file');
    expect(report.passed).toBe(false);
  });

  it('passes at exactly the tolerance boundary', async () => {
    const report = await svc({ probe: lengths(30 * (1 + QC_DURATION_TOLERANCE), 30) }).run(REAL);
    expect(find(report, 'duration_match').status).toBe('passed');
  });

  it('uses the post metadata only when the original file cannot be measured', async () => {
    const report = await svc({ probe: lengths(30) }).run(REAL);
    expect(find(report, 'duration_match').measured?.sourceFrom).toBe('post metadata');
  });

  it('a dub that cannot be measured is NOT published', async () => {
    const report = await svc({ probe: async () => { throw new Error('no ffprobe'); } }).run(REAL);
    const check = find(report, 'duration_match');
    expect(check.status).toBe('skipped');
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/^Not verified, so not published/);
    expect(report.passed).toBe(false);
  });
});

describe('QC - language, heard by an independent checker', () => {
  it('fails a dub in the wrong language', async () => {
    const c = checker({ dub: { text: 'Bonjour tout le monde', language: 'fr' } });
    const report = await svc({ fetchImpl: c.impl }).run(REAL);
    expect(find(report, 'language_detect').status).toBe('failed');
    expect(find(report, 'language_detect').detail).toContain('French');
    expect(report.passed).toBe(false);
  });

  it('fails a dub with no speech in it', async () => {
    const c = checker({ dub: { text: '  ', language: 'es' } });
    const report = await svc({ fetchImpl: c.impl }).run(REAL);
    expect(find(report, 'language_detect').status).toBe('failed');
  });

  it('a dub made with xAI is refused: the checker would be grading itself', async () => {
    const c = checker({});
    const report = await svc({ fetchImpl: c.impl }).run({ ...REAL, dubProvider: 'Grok TTS' });
    expect(find(report, 'language_detect').status).toBe('failed');
    expect(find(report, 'back_translation').status).toBe('failed');
    expect(find(report, 'back_translation').detail).toMatch(/grading its own work/);
    expect(report.passed).toBe(false);
    expect(c.urls.some((u) => u.endsWith('/stt'))).toBe(false); // not even asked
  });

  it('with no checker configured, a real dub is not published', async () => {
    env(false);
    const report = await svc().run(REAL);
    expect(find(report, 'language_detect').status).toBe('skipped');
    expect(report.passed).toBe(false);
  });

  it('an unreachable checker blocks publishing, and never leaks the key', async () => {
    const c = checker({ sttStatus: 503 });
    const report = await svc({ fetchImpl: c.impl }).run(REAL);
    expect(report.passed).toBe(false);
    expect(JSON.stringify(report)).not.toContain(XAI_KEY);
  });
});

describe('QC - meaning (back-translation)', () => {
  it('fails a dub in the right language that says something else', async () => {
    const report = await svc({ fetchImpl: checker({ meaningScore: 12 }).impl }).run(REAL);
    expect(find(report, 'language_detect').status).toBe('passed');
    expect(find(report, 'back_translation').status).toBe('failed');
    expect(find(report, 'back_translation').measured?.meaningScore).toBe(12);
    expect(report.passed).toBe(false);
  });

  it('without the original clip the meaning is unverified, so not published', async () => {
    const report = await svc().run({ ...REAL, sourcePath: undefined });
    expect(find(report, 'back_translation').status).toBe('skipped');
    expect(report.passed).toBe(false);
  });
});

describe('QC - audio sanity (ffmpeg)', () => {
  it('fails a mostly silent dub', async () => {
    const stderr = '[silencedetect] silence_start: 0\n[silencedetect] silence_end: 28.5 | silence_duration: 28.5\n    I: -70.0 LUFS';
    const report = await svc({ ffmpeg: ffmpegOk(stderr) }).run(REAL);
    expect(find(report, 'audio_sanity').status).toBe('failed');
  });

  it('fails on a dead gap longer than the limit', async () => {
    const stderr = '[silencedetect] silence_start: 5.0\n[silencedetect] silence_end: 12.0 | silence_duration: 7.0\n    I: -16.0 LUFS';
    const report = await svc({ ffmpeg: ffmpegOk(stderr) }).run(REAL);
    expect(find(report, 'audio_sanity').detail).toContain('7.0s silent stretch');
  });

  it('fails when loudness is outside the window', async () => {
    const report = await svc({ ffmpeg: ffmpegOk('    I:         -3.2 LUFS') }).run(REAL);
    expect(find(report, 'audio_sanity').status).toBe('failed');
  });

  it('without ffmpeg a real dub is not published', async () => {
    const report = await svc({ ffmpeg: ffmpegMissing }).run(REAL);
    expect(find(report, 'audio_sanity').measured?.reason).toBe('ffmpeg_not_installed');
    expect(report.passed).toBe(false);
  });

  it('parses ffmpeg output', () => {
    expect(parseLoudness('  "input_i" : "-23.7",')).toBe(-23.7);
    expect(parseLoudness('nothing useful here')).toBeNull();
    expect(parseSilences('[silencedetect] silence_start: 4.0', 10)).toEqual([6]);
    expect(parseSilences('no silence here', 10)).toEqual([]);
  });
});

describe('QC - the simulated stand-in', () => {
  it('passes with every check honestly skipped, and asks nobody', async () => {
    const c = checker({});
    const report = await svc({ fetchImpl: c.impl }).run({ ...REAL, simulated: true, dubDurationS: 30 });
    expect(report.passed).toBe(true);
    expect(report.checks.every(isSkipped)).toBe(true);
    expect(c.urls).toHaveLength(0);
  });
});

describe('QC - dashboard text', () => {
  it('uses plain words a viewer can read', async () => {
    const report = await svc().run(REAL);
    for (const check of report.checks) {
      for (const word of FORBIDDEN_WORDS) {
        expect(check.detail.toLowerCase()).not.toContain(word);
      }
    }
  });
});
