// Learning missions, contributions & rewards (W062) — the answer form's
// CLIENT-SAFE pure module: constants, types and input validation with
// ZERO imports (no module contracts — they pull the server-only db
// layer into the browser bundle; the shell's client-safety rule, see
// navigation.ts).
//
// The server workflow (lib/answer.ts) imports THIS module so the bounds
// and the strength vocabulary have exactly one definition — the client
// form and the server validation can never drift.

// ---------------------------------------------------------------------------
// The confidence vocabulary (the honest three)
// ---------------------------------------------------------------------------

/** The confidence strengths the answer form accepts. */
export const ANSWER_STRENGTHS = ['high', 'medium', 'low'] as const;
export type AnswerStrength = (typeof ANSWER_STRENGTHS)[number];

/** The form copy for each strength (the honest three). */
export const ANSWER_CONFIDENCE_OPTIONS: readonly { value: AnswerStrength; label: string }[] = [
  { value: 'high', label: 'Certain — I directly know this' },
  { value: 'medium', label: 'Confident — I know this well' },
  { value: 'low', label: 'Partial — I know part of it' },
];

// ---------------------------------------------------------------------------
// Input bounds (the contributions contract's summary/note bounds)
// ---------------------------------------------------------------------------

/** The answer text bounds (the contributions contract's summary bounds). */
export const MAX_ANSWER_SUMMARY_LENGTH = 2000;
export const MAX_ANSWER_NOTE_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Input validation (pure — the unit-test seam)
// ---------------------------------------------------------------------------

export interface ValidatedAnswerInput {
  summary: string;
  note: string | null;
  confidence: AnswerStrength;
}

/** Why an answer INPUT was refused (honest, never silent — maps to 400). */
export class AnswerInputError extends Error {
  readonly code: 'invalid_answer_input';
  constructor(message: string) {
    super(message);
    this.code = 'invalid_answer_input';
  }
}

/** Type guard for an answer confidence strength. */
export function isAnswerStrength(value: string): value is AnswerStrength {
  return (ANSWER_STRENGTHS as readonly string[]).includes(value);
}

/** Validate an answer form payload (throws AnswerInputError). */
export function validateAnswerInput(input: {
  summary: unknown;
  note?: unknown;
  confidence?: unknown;
}): ValidatedAnswerInput {
  if (typeof input.summary !== 'string') {
    throw new AnswerInputError('the answer summary must be a string');
  }
  const summary = input.summary.trim();
  if (summary === '') {
    throw new AnswerInputError('the answer summary must not be empty');
  }
  if (summary.length > MAX_ANSWER_SUMMARY_LENGTH) {
    throw new AnswerInputError(
      `the answer summary must be at most ${MAX_ANSWER_SUMMARY_LENGTH} characters`,
    );
  }
  let note: string | null = null;
  if (input.note !== undefined && input.note !== null && input.note !== '') {
    if (typeof input.note !== 'string') {
      throw new AnswerInputError('the answer note must be a string');
    }
    const trimmed = input.note.trim();
    if (trimmed !== '') {
      if (trimmed.length > MAX_ANSWER_NOTE_LENGTH) {
        throw new AnswerInputError(
          `the answer note must be at most ${MAX_ANSWER_NOTE_LENGTH} characters`,
        );
      }
      note = trimmed;
    }
  }
  const confidence = input.confidence === undefined ? 'medium' : input.confidence;
  if (typeof confidence !== 'string' || !isAnswerStrength(confidence)) {
    throw new AnswerInputError(
      `the answer confidence must be one of ${ANSWER_STRENGTHS.join(', ')}`,
    );
  }
  return { summary, note, confidence };
}
