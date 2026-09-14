// UUID v4 helper wrapping crypto — the only way Aurum mints identifiers in code.

import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}
