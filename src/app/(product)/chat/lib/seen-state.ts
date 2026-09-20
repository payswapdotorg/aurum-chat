// Aurum chat (W060) — the client's last-seen store (unread/new activity).
//
// WHY CLIENT-SIDE: the conversations domain (W029) is deliberately
// append-only — its contract exposes NO update operation, so there is no
// domain read-state to write, and adding one would be a frozen-architecture
// change (GOVERNANCE: no silent redesign). Read state is a per-VIEWER
// presentation concern: this module keeps one localStorage map, keyed by
// tenant and conversation, holding the viewer's last-look timestamp.
//
// PURE-ish and testable: every function takes an explicit `storage`
// (defaults to the browser's localStorage when present, an in-memory Map
// otherwise — the tests inject the Map).

const STORAGE_KEY = 'aurum.chat.seen.v1';

export interface SeenMap {
  [tenantConversationKey: string]: string;
}

export interface SeenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The default storage — the browser's localStorage, or memory in SSR. */
export function defaultStorage(): SeenStorage {
  if (typeof window === 'undefined') {
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    };
  }
  try {
    return window.localStorage;
  } catch {
    // Private-browsing modes can throw on access — degrade to memory.
    const memory = new Map<string, string>();
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value);
      },
    };
  }
}

export function seenKey(tenantId: string, conversationId: string): string {
  return `${tenantId}/${conversationId}`;
}

/** Load the viewer's seen map (malformed entries are dropped, never thrown). */
export function loadSeenMap(storage: SeenStorage = defaultStorage()): SeenMap {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: SeenMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** The viewer's last-look timestamp for one conversation (null = never). */
export function seenFor(
  map: SeenMap,
  tenantId: string,
  conversationId: string,
): string | null {
  return map[seenKey(tenantId, conversationId)] ?? null;
}

/** Record a look at one conversation (monotonic — never moves backwards). */
export function markSeen(
  map: SeenMap,
  storage: SeenStorage,
  tenantId: string,
  conversationId: string,
  atIso: string,
): SeenMap {
  const key = seenKey(tenantId, conversationId);
  const existing = map[key];
  if (existing !== undefined && existing >= atIso) return map;
  const next: SeenMap = { ...map, [key]: atIso };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked — the in-memory map still serves this session.
  }
  return next;
}
