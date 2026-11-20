import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // @parrot/shared ships raw TypeScript from src/, so Next must compile it.
  transpilePackages: ['@parrot/shared'],
  eslint: { ignoreDuringBuilds: true },
  // The bot's replies link to the short form /w/{id} (bot-service.ts
  // watchLink); the page lives at /dub/{id}. Without this every link Parrot
  // posts is a 404.
  async redirects() {
    return [{ source: '/w/:id', destination: '/dub/:id', permanent: false }];
  },
  // The browser talks to the backend THROUGH this site, so the session cookie is
  // first-party. Cross-site cookies are blocked by Safari and Brave, and Fly's
  // *.fly.dev domains count as different sites. Set BACKEND_ORIGIN to the real
  // backend (server-side) and point NEXT_PUBLIC_BACKEND_URL at this site's own
  // address. When BACKEND_ORIGIN is unset, nothing is proxied (local dev talks
  // to the backend directly).
  async rewrites() {
    const backend = process.env.BACKEND_ORIGIN?.trim().replace(/\/$/, '');
    if (!backend) return [];
    return [
      { source: '/api/:path*', destination: `${backend}/api/:path*` },
      { source: '/media/:path*', destination: `${backend}/media/:path*` },
    ];
  },
  webpack(config) {
    // @parrot/shared is authored for NodeNext and imports siblings as "./x.js".
    // Point those specifiers back at the TypeScript sources.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default config;
