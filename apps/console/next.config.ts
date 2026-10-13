import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // A self-contained server with only the files it needs, for the container image (Dockerfile).
  // Tracing starts at the repo root, which Next finds by the lockfile.
  output: 'standalone',
};

export default config;
