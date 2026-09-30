import type { MetadataRoute } from 'next';

// Standard SaaS robots policy (W123 / B-TL-03): allow all crawlers on all
// routes. Sign-in surfaces are harmless to index; no private data is
// reachable without a session.

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
    },
  };
}
