// W000 scaffolded this page as the minimal shell with a note that "the
// Control Tower UI is a later work item" — W033 is that item. The tower
// lives in the (tower) route group; the root now forwards to its Today
// surface so the management UI is reachable at the application root.

import { redirect } from 'next/navigation';

export default function HomePage() {
  redirect('/today');
}
