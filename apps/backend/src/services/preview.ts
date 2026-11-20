/**
 * The free preview of a dub: its first few seconds, as a separate small file.
 *
 * The preview used to be the full dub with a client-side time limit, which is
 * no paywall at all: anyone with the URL got the whole video. A preview must be
 * a different file. And if one cannot be made (no ffmpeg, an odd format), the
 * answer is NO preview, never the full file.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

export const PREVIEW_SECONDS = 8;

export type FfmpegRun = (args: string[]) => Promise<{ code: number | null }>;

const defaultRun: FfmpegRun = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });

/** Where the preview for `fullPath` lives, or null for a format we do not cut. */
export function previewPathFor(fullPath: string): string | null {
  const ext = extname(fullPath).toLowerCase();
  if (ext !== '.mp4' && ext !== '.wav') return null;
  const stem = basename(fullPath, extname(fullPath));
  return join(dirname(fullPath), `${stem}.preview${ext}`);
}

/**
 * Cut the preview. Resolves with its path, or null if it could not be made.
 * Never throws and never returns `fullPath`.
 */
export async function makePreview(fullPath: string, run: FfmpegRun = defaultRun): Promise<string | null> {
  const out = previewPathFor(fullPath);
  if (!out || out === fullPath) return null;
  try {
    await stat(fullPath);
  } catch {
    return null;
  }

  const common = ['-y', '-v', 'error', '-i', fullPath, '-t', String(PREVIEW_SECONDS)];
  const args =
    extname(out) === '.wav'
      ? [...common, '-c', 'copy', out]
      : [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', out];
  try {
    const { code } = await run(args);
    if (code !== 0) return null;
    return (await stat(out)).size > 0 ? out : null;
  } catch {
    return null; // ffmpeg missing or failed
  }
}
