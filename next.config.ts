import type { NextConfig } from 'next';

// The Next.js shell. Domain modules never import next/* (enforced by
// scripts/check-architecture.ts); the infra server drivers stay external
// to the bundler.
const nextConfig: NextConfig = {
  serverExternalPackages: ['@electric-sql/pglite', 'pg', 'ioredis'],
  // Dev-origin gate (Next 16): the sandbox serves this app behind a
  // platform gateway that preserves the browser's external Host header,
  // and local verification hits 127.0.0.1 directly. Turbopack's HMR
  // socket carries the client module graph — a blocked origin kills
  // hydration entirely (forms fall through to native GET). Wildcard
  // depth patterns cover every realistic preview hostname; this is a
  // private dev sandbox with a single gateway ingress.
  allowedDevOrigins: ['127.0.0.1', 'localhost', '*.*', '*.*.*', '*.*.*.*'],
};

export default nextConfig;
