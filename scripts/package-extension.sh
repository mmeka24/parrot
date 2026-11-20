#!/usr/bin/env bash
# Build the extension for a hosted server and drop the zip on the website.
#
#   PARROT_SERVER=https://parrot-backend.fly.dev \
#   PARROT_EXTRA_SITES=https://parrot-chirp.vercel.app \
#   scripts/package-extension.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PARROT_SERVER:?set PARROT_SERVER to the public backend URL, e.g. https://parrot-backend.fly.dev}"

npm run build:extension
out="apps/web/public/parrot-extension.zip"
rm -f "$out"
# The folder inside the zip is named parrot-extension, which the install page says.
tmp="$(mktemp -d)"
cp -R apps/extension/dist "$tmp/parrot-extension"
(cd "$tmp" && zip -qr parrot-extension.zip parrot-extension)
mv "$tmp/parrot-extension.zip" "$out"
rm -rf "$tmp"
echo "wrote $out ($(du -h "$out" | cut -f1)) for $PARROT_SERVER"
