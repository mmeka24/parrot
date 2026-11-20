import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PREVIEW_SECONDS, makePreview, previewPathFor } from '../src/services/preview';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parrot-preview-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('previewPathFor', () => {
  it('is a different file next to the original', () => {
    expect(previewPathFor('/m/abc.es.mp4')).toBe('/m/abc.es.preview.mp4');
    expect(previewPathFor('/m/sim.wav')).toBe('/m/sim.preview.wav');
  });
  it('declines formats it does not cut', () => {
    expect(previewPathFor('/m/x.mov')).toBeNull();
    expect(previewPathFor('/m/x')).toBeNull();
  });
});

describe('makePreview (fake ffmpeg)', () => {
  const full = () => {
    const p = join(dir, 'a.es.mp4');
    writeFileSync(p, 'x'.repeat(100));
    return p;
  };

  it('asks for exactly the first seconds, writing to a different file', async () => {
    const p = full();
    let args: string[] = [];
    const out = await makePreview(p, async (a) => {
      args = a;
      writeFileSync(a[a.length - 1]!, 'short');
      return { code: 0 };
    });
    expect(out).toBe(join(dir, 'a.es.preview.mp4'));
    expect(args[args.indexOf('-t') + 1]).toBe(String(PREVIEW_SECONDS));
    expect(args[args.indexOf('-i') + 1]).toBe(p);
    expect(args[args.length - 1]).not.toBe(p);
  });

  it('returns null, never the full file, when ffmpeg fails', async () => {
    expect(await makePreview(full(), async () => ({ code: 1 }))).toBeNull();
  });

  it('returns null when ffmpeg is not installed', async () => {
    const out = await makePreview(full(), async () => {
      throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    });
    expect(out).toBeNull();
  });

  it('returns null when ffmpeg claims success but wrote nothing', async () => {
    expect(await makePreview(full(), async () => ({ code: 0 }))).toBeNull();
  });

  it('returns null for a file that does not exist, without running ffmpeg', async () => {
    let ran = false;
    expect(await makePreview(join(dir, 'missing.mp4'), async () => ((ran = true), { code: 0 }))).toBeNull();
    expect(ran).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)('makePreview (real ffmpeg)', () => {
  const duration = (p: string) =>
    Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString());

  it('cuts a 30 second video down to the preview length, as a smaller separate file', async () => {
    const full = join(dir, 'long.es.mp4');
    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24:duration=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', full,
    ]);
    expect(duration(full)).toBeGreaterThan(29);

    const preview = await makePreview(full);
    expect(preview).toBe(join(dir, 'long.es.preview.mp4'));
    expect(existsSync(preview!)).toBe(true);
    expect(preview).not.toBe(full);
    expect(duration(preview!)).toBeLessThanOrEqual(PREVIEW_SECONDS + 0.5);
    expect(duration(preview!)).toBeGreaterThan(PREVIEW_SECONDS - 1);
    expect(statSync(preview!).size).toBeLessThan(statSync(full).size);
    expect(duration(full)).toBeGreaterThan(29); // the original is untouched
  });

  it('cuts audio-only dubs too', async () => {
    const full = join(dir, 'tone.wav');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20', full]);
    const preview = await makePreview(full);
    expect(preview).toBe(join(dir, 'tone.preview.wav'));
    expect(duration(preview!)).toBeLessThanOrEqual(PREVIEW_SECONDS + 0.5);
  });
});
