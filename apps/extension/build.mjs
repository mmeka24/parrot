/**
 * Builds the unpacked extension into dist/.
 *
 *   npm run build -w @parrot/extension
 *   chrome://extensions -> Developer mode -> Load unpacked -> apps/extension/dist
 *
 * Each entry is bundled to one classic script: content scripts cannot be ES
 * modules, and bundling also inlines the two @parrot/shared files they use
 * (copy and the DOM contract), which import nothing themselves.
 */

import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const file of ['manifest.json', 'popup.html', 'icons']) {
  await cp(join(root, 'static', file), join(dist, file), { recursive: true });
}

const options = {
  entryPoints: {
    background: join(root, 'src/background.ts'),
    content: join(root, 'src/content.ts'),
    popup: join(root, 'src/popup.ts'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'info',
  legalComments: 'none',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
