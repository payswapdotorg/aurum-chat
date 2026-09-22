'use client';

// Chat-based learning requests (W073) — the composer's answer mode (the
// WhatsApp reply pattern, learning lane).
//
// When the employee taps "Answer here" on a knowledge-request card, the
// composer enters answer mode: this banner renders above the input,
// quoting the question being answered and carrying the honest confidence
// selector (the same three strengths the Learning answer form offers —
// lib/form.ts's single client-safe definition), with a cancel affordance.
// The next send is captured as the ANSWER through the same domain
// workflow the Learning surface drives — the employee never leaves the
// conversation, and never needs the Learning route first.

import type { ReactNode } from 'react';
// CLIENT-SAFE import only (the shell's rule): the learning form module
// imports nothing, so the strength vocabulary has exactly one definition.
import { ANSWER_CONFIDENCE_OPTIONS } from '../../../learning/lib/form';
import type { AnswerStrength } from '../../../learning/lib/form';
import { Glyph, CANCEL_GLYPH_D } from '../message-parts';

export interface AnswerBannerProps {
  /** The knowledge request being answered (the quoted question). */
  question: string;
  /** The currently selected confidence strength. */
  confidence: AnswerStrength;
  /** Change the confidence strength. */
  onConfidenceChange: (confidence: AnswerStrength) => void;
  /** Leave answer mode (back to normal sends). */
  onCancel: () => void;
}

export function AnswerBanner({
  question,
  confidence,
  onConfidenceChange,
  onCancel,
}: AnswerBannerProps): ReactNode {
  return (
    <div className="aurum-learn-answer-banner" role="region" aria-label="Answering a knowledge request">
      <div className="aurum-learn-answer-quote">
        <span className="aurum-learn-answer-label">Answering a knowledge request</span>
        <span className="aurum-learn-answer-question" title={question}>
          {question}
        </span>
      </div>
      <div className="aurum-learn-answer-controls">
        <label className="aurum-learn-answer-field">
          <span className="aurum-sr-only">How certain you are</span>
          <select
            className="aurum-learn-input aurum-learn-answer-select"
            value={confidence}
            onChange={(event) => onConfidenceChange(event.target.value as AnswerStrength)}
          >
            {ANSWER_CONFIDENCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="aurum-learn-answer-cancel"
          onClick={onCancel}
          aria-label="Cancel the answer and return to normal messages"
        >
          <Glyph d={CANCEL_GLYPH_D} size={14} label="cancel" />
          Cancel
        </button>
      </div>
      <span className="aurum-learn-answer-hint">
        Your next send is recorded as your answer — evidence for the mission, acknowledged
        as a contribution.
      </span>
    </div>
  );
}
