// Aurum chat (W060) — the chat surface's layout.
//
// The one job: scope the surface's stylesheet (the connections-hub
// precedent — the product shell's root layout stays untouched, and the
// chat styles live with the chat surface).

import type { ReactNode } from 'react';
import './chat.css';

export default function ChatLayout({ children }: { children: ReactNode }) {
  return children;
}
