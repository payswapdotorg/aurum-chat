// Product shell (W057) — the application root.
//
// W000 scaffolded this page; W033 forwarded it to the tower's Today
// surface; the product-surface plan makes the EMPLOYEE MODE the primary
// experience ("Aurum Chat — primary product", conversation-first), so the
// root now forwards to the conversation entry point. The Control Tower
// remains one click away (rail "Today", Intelligence hub, More, ⌘K).

import { redirect } from 'next/navigation';

export default function ProductRootPage() {
  redirect('/chat');
}
