# Parrot backend, for Fly.io. Build context is the repo root.
#   fly deploy
FROM node:22-slim

# ffmpeg: QC audio checks. curl/ca-certificates: fetch yt-dlp, a standalone
# binary the x.com route uses to download a post's video.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Install only what the backend needs (not the Next.js apps), cache-friendly.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/backend/package.json apps/backend/package.json
RUN npm ci --include-workspace-root -w @parrot/shared -w @parrot/backend

COPY packages/shared packages/shared
COPY apps/backend apps/backend

ENV NODE_ENV=production \
    BACKEND_PORT=8080 \
    MEDIA_STORAGE_DIR=/data/media

WORKDIR /app/apps/backend
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
