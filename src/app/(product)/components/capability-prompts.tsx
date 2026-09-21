// Product shell (W075) — the contextual capability prompts (shared,
// presentational).
//
// The plan's §3 journey improvements are all one shape: when something
// BLOCKS the user (a missing connection, no suitable model, a capability
// that is not installed, "I want Aurum in my own tools"), the path that
// unblocks it must be one entry point away. These components render those
// entry points from the capability-hub registry — plain links that
// NAVIGATE, styled like the hub cards (ShareNet-dominant: quiet surface,
// hairline, restrained hover).
//
// They are deliberately hook-free and 'use client'-free so BOTH server
// surfaces (the More hub's "when something is missing" section) and
// client surfaces (the shell's context drawer — the chat experience's
// shared secondary panel) render the same components from the same
// registry. The chat surface itself (Worker A, W071) can consume them the
// same way without any chat-chrome restructuring.
//
// A11y: every card is a link with a real accessible name (label + when,
// never icon-only); the list is a <ul> of single-link items.

import type { ReactNode } from 'react';
import Link from 'next/link';
import { ShellGlyph } from './icons';
import type { CapabilityPrompt } from '../lib/capability-hub';

const PROMPT_ICONS: Record<string, 'connections' | 'spark' | 'marketplace' | 'developer'> = {
  connections: 'connections',
  'ai-provider': 'spark',
  marketplace: 'marketplace',
  developer: 'developer',
};

/** One contextual prompt as a quiet link card (when → action). */
export function CapabilityPromptCard({
  prompt,
}: {
  prompt: CapabilityPrompt;
}): ReactNode {
  const icon = PROMPT_ICONS[prompt.id] ?? 'spark';
  return (
    <Link className="aurum-prompt-card" href={prompt.href}>
      <span className="aurum-prompt-when">{prompt.when}</span>
      <span className="aurum-prompt-action">
        <ShellGlyph name={icon} size={16} />
        {prompt.label}
      </span>
      <span className="aurum-prompt-summary">{prompt.summary}</span>
    </Link>
  );
}

/** The prompt list — the "when something is missing" block. */
export function CapabilityPromptList({
  prompts,
  compact = false,
}: {
  prompts: readonly CapabilityPrompt[];
  compact?: boolean;
}): ReactNode {
  if (prompts.length === 0) return null;
  return (
    <ul className={compact ? 'aurum-prompt-list aurum-prompt-list-compact' : 'aurum-prompt-list'}>
      {prompts.map((prompt) => (
        <li key={prompt.id}>
          <CapabilityPromptCard prompt={prompt} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The context drawer's "Where to go next" block: the compact prompt list
 * rendered inside the drawer (the shared secondary panel of the chat
 * experience). Data comes from the registry — the drawer adds no
 * destinations of its own.
 */
export function ContextDrawerNextSteps({
  prompts,
}: {
  prompts: readonly CapabilityPrompt[];
}): ReactNode {
  return (
    <section className="aurum-ctx-next">
      <h3 className="aurum-ctx-heading">Where to go next</h3>
      <p className="aurum-ctx-line">
        If something is missing, these are the paths that fix it:
      </p>
      <ul className="aurum-ctx-next-list">
        {prompts.map((prompt) => (
          <li key={prompt.id}>
            <Link href={prompt.href}>
              {prompt.label}
              <span className="aurum-ctx-next-when">{prompt.when.toLowerCase()}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
