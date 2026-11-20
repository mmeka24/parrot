import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_DURATION_S } from '@parrot/shared';
import {
  MediaFetchError,
  MediaFetcher,
  X_STATUS_URL,
  type RunResult,
} from '../src/services/media-fetcher';

const URL_OK = 'https://x.com/maria/status/1234567890123456789';

function make(opts: {
  run?: (args: string[]) => Promise<RunResult>;
  sizes?: Array<number | null>;
}) {
  const calls: string[][] = [];
  const sizes = [...(opts.sizes ?? [null, 1000])];
  const fetcher = new MediaFetcher({
    ytDlpPath: 'yt-dlp',
    mediaDir: '/tmp/parrot-test-media',
    run: async (args) => {
      calls.push(args);
      return (opts.run ?? (async () => ({ code: 0, stderr: '' })))(args);
    },
    sizeOf: async () => (sizes.length > 1 ? (sizes.shift() as number | null) : (sizes[0] ?? null)),
  });
  return { fetcher, calls };
}

describe('X_STATUS_URL', () => {
  it.each([
    'https://x.com/maria/status/123',
    'https://twitter.com/Maria_1/status/99999',
  ])('accepts %s', (u) => expect(X_STATUS_URL.test(u)).toBe(true));

  it.each([
    'http://x.com/maria/status/123',
    'https://x.com.evil.test/maria/status/123',
    'https://evil.test/x.com/maria/status/123',
    'https://x.com/maria/status/123?s=20',
    'https://x.com/maria/status/123 --exec rm',
    'https://x.com/maria/status/abc',
    'file:///etc/passwd',
    '-o /tmp/x',
  ])('rejects %s', (u) => expect(X_STATUS_URL.test(u)).toBe(false));
});

describe('MediaFetcher', () => {
  it('refuses a non-x.com link without running anything', async () => {
    const { fetcher, calls } = make({});
    await expect(fetcher.fetch('https://example.com/v.mp4')).rejects.toBeInstanceOf(MediaFetchError);
    expect(calls).toHaveLength(0);
  });

  it('downloads to xsrc_<postId>.mp4, enforcing length and size caps, with no shell', async () => {
    const { fetcher, calls } = make({ sizes: [null, 5_000] });
    const path = await fetcher.fetch(URL_OK);
    expect(path).toBe('/tmp/parrot-test-media/xsrc_1234567890123456789.mp4');
    const args = calls[0] as string[];
    expect(args).toContain('--no-playlist');
    expect(args[args.indexOf('--match-filter') + 1]).toBe(`duration<=${MAX_SOURCE_DURATION_S}`);
    expect(args[args.indexOf('--max-filesize') + 1]).toBe('100M');
    // The URL is the last argv entry, passed as data and never through a shell.
    expect(args[args.length - 1]).toBe(URL_OK);
  });

  it('does not download again when the file is already there', async () => {
    const { fetcher, calls } = make({ sizes: [5_000] });
    await fetcher.fetch(URL_OK);
    expect(calls).toHaveLength(0);
  });

  it('returns null when yt-dlp is not installed', async () => {
    const { fetcher } = make({
      run: async () => {
        throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(await fetcher.fetch(URL_OK)).toBeNull();
  });

  it('throws when the download fails', async () => {
    const { fetcher } = make({ run: async () => ({ code: 1, stderr: 'ERROR: no video\nmore' }) });
    await expect(fetcher.fetch(URL_OK)).rejects.toThrow(/no video/);
  });

  it('throws when yt-dlp skips an over-long clip (exit 0, no file)', async () => {
    const { fetcher } = make({ sizes: [null, null] });
    await expect(fetcher.fetch(URL_OK)).rejects.toThrow(/longer than 180 seconds/);
  });
});
