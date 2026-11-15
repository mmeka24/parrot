import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // @parrot/shared ships raw TypeScript from src/, so Next must compile it.
  transpilePackages: ['@parrot/shared'],
  eslint: { ignoreDuringBuilds: true },
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
