// W068 — the demo harness's error surface.
//
// Codes:
//   * production_backdoor — the seed was asked to run against something
//     other than the embedded, explicitly-opted-in demo database. The
//     demo harness must never create tenants, principals or journey data
//     in a real (server) deployment (W068 acceptance: "no production
//     backdoor").
//   * invalid_input       — the caller passed something malformed.
//   * seed_conflict       — the demo dataset collides with pre-existing
//     state it cannot reconcile (for example a demo email already
//     registered under a different password). The harness refuses loudly
//     instead of duplicating or overwriting.

export type DemoErrorCode = 'production_backdoor' | 'invalid_input' | 'seed_conflict';

export class DemoError extends Error {
  readonly code: DemoErrorCode;

  constructor(code: DemoErrorCode, message: string) {
    super(message);
    this.name = 'DemoError';
    this.code = code;
  }
}
