import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // @parrot/shared ships raw TypeScript from src/, so Next must compile it.
  transpilePackages: ['@parrot/shared'],
  eslint: { ignoreDuringBuilds: true },
};

export default config;
