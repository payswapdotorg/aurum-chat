// AI preferences (W091) — the user-language vocabulary of the
// outcome-oriented preferences surface.
//
// JARGON DISCIPLINE (the acceptance's first clause): every string the
// ORDINARY surface renders is outcome/task language — the word
// "provider" itself is avoided on the ordinary surface (it says "AI
// option"); provider NAMES never appear there (the module's ordinary
// projection already strips them, and these labels keep the chrome
// honest too). The ADVANCED surface (advanced/) is the one place
// technical identity appears, and it says so out loud.
//
// CLIENT-SAFETY: like the /ai surface's labels.ts, this module is
// imported by client components (the controls) — pure data only, no
// server imports; the vocabulary copies are locked to the module
// contract by the unit tests (no drift).

import type {
  PreferenceSource,
  ProviderPreferenceOutcome,
  SelectionDecision,
} from '@/modules/provider-preferences/contract';
import { PROVIDER_PREFERENCE_OUTCOMES } from '@/modules/provider-preferences/contract';

/** The client-safe outcome vocabulary copy (locked to the contract — see the unit tests). */
export const PREFERENCE_OUTCOMES: readonly ProviderPreferenceOutcome[] = [
  ...PROVIDER_PREFERENCE_OUTCOMES,
];

/** What each outcome MEANS, in one plain sentence (the form's help text). */
export const OUTCOME_EXPLANATIONS: Record<ProviderPreferenceOutcome, string> = {
  cost: 'Prefer the option that costs the company less when several can do the job.',
  privacy:
    'Prefer the option that handles your information most protectively (data handling first).',
  quality: 'Prefer the option that does the work best, even if it takes a moment longer.',
  speed: 'Prefer the option that answers fastest, even if the answer is a little simpler.',
};

/** The short label of one outcome (chips, form options). */
export function outcomeLabel(outcome: ProviderPreferenceOutcome): string {
  switch (outcome) {
    case 'cost':
      return 'Lowest cost';
    case 'privacy':
      return 'Strongest data protection';
    case 'quality':
      return 'Highest quality';
    case 'speed':
      return 'Fastest response';
  }
}

/** The ordinal label of one priority position (First priority, Second priority…). */
export function priorityPositionLabel(position: number): string {
  switch (position) {
    case 1:
      return 'First priority — what matters most';
    case 2:
      return 'Second priority';
    case 3:
      return 'Third priority';
    default:
      return 'Fourth priority';
  }
}

/** Whose priority is in effect, in plain words (the resolved-profile attribution). */
export function preferenceSourceLabel(source: PreferenceSource): string {
  switch (source) {
    case 'personal-preference':
      return 'You chose this';
    case 'tenant-priority':
      return 'Your company chose this';
    case 'organizational-policy':
      return 'Company policy decides this';
    case 'default':
      return 'The balanced default (nothing is set yet)';
  }
}

/** One line about what a policy-first posture means for the member. */
export function policyFirstNote(policyFirst: boolean): string {
  return policyFirst
    ? 'Company policy decides how AI options are chosen. Your own priority below is recorded, and it will apply again if policy stops deciding.'
    : 'Your own priority applies to your interactions; the company priority below is what anyone without their own choice uses.';
}

/** What actually determined a choice, in plain words (the explanation pill). */
export function decisionLabel(decision: SelectionDecision): string {
  switch (decision) {
    case 'preference':
      return 'Chosen by priorities';
    case 'single-choice':
      return 'The only option available';
    case 'no-choice':
      return 'Nothing was available';
    case 'technical-override':
      return 'Chosen by an authorized override';
  }
}

/** The tone of the decision pill. */
export function decisionTone(
  decision: SelectionDecision,
): 'positive' | 'info' | 'warning' | 'error' {
  switch (decision) {
    case 'preference':
      return 'positive';
    case 'single-choice':
      return 'info';
    case 'technical-override':
      return 'info';
    case 'no-choice':
      return 'warning';
  }
}

/** The capability label in user language (the route a choice was made for). */
export function capabilityLabel(capability: string): string {
  switch (capability) {
    case 'text-generation':
      return 'Writing and analysis';
    case 'embedding':
      return 'Meaning and search';
    default:
      return capability;
  }
}

/** A relative age label without locale data (the ai surface's discipline). */
export function ageLabel(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const current = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(current)) return 'some time ago';
  const seconds = Math.max(0, Math.round((current - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/** The standing note of the ordinary surface: outcomes, never jargon. */
export const ORDINARY_NOTE =
  'You steer what matters — cost, data protection, quality or speed. You never need to know which AI option is behind it, and you can change your mind at any time.';

/** The honest note about who can see technical detail. */
export const ADVANCED_GATE_NOTE =
  'Technical detail (which specific AI option is used) is shown only in the advanced settings, and only to authorized administrators.';
