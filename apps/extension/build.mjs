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
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

// A shared build talks to a hosted server, and Chrome only lets the extension
// reach origins the manifest names. So add what this build was made for:
//   PARROT_SERVER=https://parrot-backend.fly.dev   -> host permission
//   PARROT_EXTRA_SITES=https://parrot-chirp.vercel.app,...  -> also draw on these
{
  const manifestPath = join(dist, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const origin = (value) => {
    try {
      const url = new URL(value.trim());
      return url.protocol === 'https:' || url.hostname === 'localhost' ? `${url.origin}/*` : null;
    } catch {
      return null;
    }
  };
  const server = process.env.PARROT_SERVER ? origin(process.env.PARROT_SERVER) : null;
  const sites = (process.env.PARROT_EXTRA_SITES ?? '')
    .split(',')
    .map(origin)
    .filter((entry) => entry !== null);
  const add = (list, entries) => {
    for (const entry of entries) if (!list.includes(entry)) list.push(entry);
  };
  if (server) add(manifest.host_permissions, [server]);
  add(manifest.host_permissions, sites);
  add(manifest.content_scripts[0].matches, sites);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
  // PARROT_SERVER=https://... bakes in the server a shared build talks to.
  define: { __PARROT_SERVER__: JSON.stringify(process.env.PARROT_SERVER ?? '') },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
