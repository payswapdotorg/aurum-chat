// Typed errors of the company-query module. Consumers catch
// `CompanyQueryError` and branch on `code`; messages are for humans/logs,
// never for control flow — the same discipline every module applies.
//
// Error vocabulary:
//   invalid_context     — a caller forgot the explicit TenantContext (the
//                         ten-step pipeline's step 1 refuses ambient scope);
//   invalid_query       — malformed input (question/surfaces), reported by
//                         validation.ts;
//   retrieval_failed    — a composed module contract read failed in a way
//                         the query plane cannot answer through (mapped
//                         honestly, never swallowed into a fake answer);
//   audit_failed        — the append-only query-audit append failed (the
//                         answer is NOT served from unaudited silence: the
//                         failure is explicit).
//
// LLM availability is deliberately NOT an error: when no tenant AI account
// or transport is wired, the answer is still served — fully structured and
// deterministic, with `answer.llm.used === false` (the LLM is presentation
// only; lock 10).

export type CompanyQueryErrorCode =
  | 'invalid_context'
  | 'invalid_query'
  | 'retrieval_failed'
  | 'audit_failed';

export class CompanyQueryError extends Error {
  constructor(
    public readonly code: CompanyQueryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CompanyQueryError';
  }
}
