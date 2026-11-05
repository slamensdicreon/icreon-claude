import { z } from 'zod';
import { Workstream } from './enums';

/*
 * Cypher's words (design system §4, PLAN.md › Backend and contract changes). The backend writes
 * every sentence Cypher says; the Chief of Staff role writes them where a model is configured, and
 * templates written in Cypher's voice stand in everywhere else, so a screen never shows an empty
 * sentence. The web app renders these strings and never composes them.
 */

/** The sentence at the top of a Bliss screen. */
export const Voice = z.object({
  /** The whole sentence or two, in Cypher's voice. */
  text: z.string(),
  /** The clause inside `text` that is the Director's, set in voice-emphasis; null when none is. */
  emphasis: z.string().nullable(),
  /** The quiet line under it or at the end of the page ("Everyone else is fine. I'll say nothing until five."). */
  closing: z.string().nullable(),
});
export type Voice = z.infer<typeof Voice>;

/** Cypher's verdict inside a card that is the Director's. */
export const Recommendation = z.object({
  /** One line that starts with "I'd" or is the action itself ("I'd choose one.", "Rotate it."). */
  verdict: z.string(),
  /** Why, in one line. */
  why: z.string(),
  /** The option Cypher would pick (an option id), or null when the card's action isn't an option. */
  pick: z.string().nullable(),
});
export type Recommendation = z.infer<typeof Recommendation>;

/** A person on the team as the UI shows them: a face in their team's hue. */
export const Face = z.object({
  agentId: z.string(),
  /** "Emily Chen". */
  name: z.string(),
  /** "Emily". */
  firstName: z.string(),
  /** "EC". */
  initials: z.string(),
  workstream: Workstream.nullable(),
  /** Working now; faces not working are shown quieter. */
  working: z.boolean(),
});
export type Face = z.infer<typeof Face>;

/** Something settled without the Director, in one sentence. */
export const HandledItem = z.object({
  text: z.string(),
  /** When it happened; null for a line that sums up a stretch of time. */
  at: z.iso.datetime().nullable(),
  /** Shown instead of a time when `at` is null ("since 8"). */
  when: z.string().nullable(),
});
export type HandledItem = z.infer<typeof HandledItem>;

/** How a read or a line is set: yours (coral), blocked (coral), normal, or quiet (resting). */
export const ReadTone = z.enum(['yours', 'blocked', 'normal', 'quiet']);
export type ReadTone = z.infer<typeof ReadTone>;
