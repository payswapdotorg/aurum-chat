import type { NextConfig } from 'next';

// The Next.js shell. Domain modules never import next/* (enforced by
// scripts/check-architecture.ts); the infra server drivers stay external
// to the bundler.
const nextConfig: NextConfig = {
  serverExternalPackages: ['@electric-sql/pglite', 'pg', 'ioredis'],
};

export default nextConfig;
