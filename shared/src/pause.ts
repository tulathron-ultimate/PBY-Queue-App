/**
 * Pause the line (E6). While paused, Call next is off, "Not here" calls nobody else, and no
 * Up next texts go out: parties still move into the `up_next` state so guest pages stay right,
 * but their text is held back and sent on Resume (see `recomputeUpNext`).
 */
import { orderActive, type QueueResult, type SmsEffect } from './queue.js';
import type { QueueParty } from './types.js';

/** Longest pause message, e.g. "Back in 10 minutes - lunch break". */
export const PAUSE_MESSAGE_MAX = 120;

// C0/C1 control characters, and bidi embeddings, overrides and isolates (Trojan Source).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/**
 * Cleans the host's optional pause message: text only, control and bidi characters removed,
 * whitespace collapsed, at most `PAUSE_MESSAGE_MAX` characters. Empty becomes null.
 */
export function cleanPauseMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, PAUSE_MESSAGE_MAX).join('').trim() || null;
}

/**
 * Applies the pause rule to a queue result: drops the Up next texts it would send and leaves
 * those parties' "Up next sent" flag unset, so the text goes out when the line resumes.
 */
export function holdUpNextTexts<T extends QueueParty>(r: QueueResult<T>): QueueResult<T> {
  const held = new Set(r.effects.filter((e) => e.template === 'up_next').map((e) => e.partyId));
  if (!held.size) return r;
  return {
    ...r,
    parties: r.parties.map((p) => (held.has(p.id) ? { ...p, upNextSent: false } : p)),
    effects: r.effects.filter((e) => !(e.template === 'up_next' && held.has(e.partyId))),
  };
}

/** The optional "we're paused" text: one per party waiting in line (arrived or not). */
export function pausedTextEffects(parties: readonly QueueParty[]): SmsEffect[] {
  return orderActive(parties).map((p) => ({ partyId: p.id, template: 'paused' as const }));
}
