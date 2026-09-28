import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// W113 (UX harmonization): the old marketing site's typography — display
// serif Fraunces (headings/brand), Geist Sans body, Geist Mono. Loaded via
// a Google Fonts stylesheet link (React 19 hoists these into <head>); the
// font-family stacks live in each surface's token block WITH graceful
// fallbacks (Georgia / system sans / system mono), so every page renders
// correctly even when the stylesheet is unreachable. next/font/google is
// deliberately NOT used: its exports are compile-time transforms that are
// not callable outside the Next build, which breaks the repo's e2e render
// harness (tests/e2e/journeys/harness.ts renders the real layout chain
// through React's renderToReadableStream). This stays font wiring only —
// no routes, logic, or data flow change.
export const metadata: Metadata = {
  title: 'Aurum',
  description: 'Aurum — organizational intelligence employee',
};

const FONT_STYLESHEET_HREF =
  'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&display=swap';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONT_STYLESHEET_HREF} precedence="font" />
        {children}
      </body>
    </html>
  );
}
