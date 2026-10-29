import type { DecisionCategory, EscalationType } from '@lw/contracts';

/** What a card says, enough to tell what it asks about. */
export interface CardText {
  type: EscalationType;
  title: string;
  context: string;
  gate?: unknown;
}

/**
 * The first rule that matches decides, so the order matters: a refused media download is media,
 * not access; a sandbox that answers 409 is a tool problem before anything else it mentions.
 * Tuned on Ansco's 353 cards (2026-10-29).
 */
const RULES: [DecisionCategory, (c: CardText, text: string) => boolean][] = [
  [
    'release',
    (c, t) =>
      c.type === 'gate' || c.type === 'budget' || Boolean(c.gate) || /^approve release/.test(t),
  ],
  ['retry', (_, t) => /rejected (\d+|two|three) times|retry or accept|sent back \d+ times/.test(t)],
  [
    'media',
    (_, t) =>
      /^access denied: upload|source url|\.(png|jpe?g|webp|svg|gif)\b|image be sourced|media (file|upload|asset)|refused (the )?download/.test(
        t,
      ),
  ],
  [
    'tool',
    (_, t) =>
      /not connected|sandbox|\b409\b|\b5\d\d\b|deploy api|is stuck|type-checks|tool (error|failure)|returns? \d{3}|still \d{3}|updates return|on any write|can.t be opened|timed out|already exists/.test(
        t,
      ),
  ],
  [
    'access',
    (c, t) =>
      c.type === 'access' ||
      /access denied|denied|permission|read scope|scope widening|widen|allow .*host|outside what m|not allowed|forbidden|credential|secret/.test(
        t,
      ),
  ],
  [
    'scope',
    (_, t) =>
      /out of scope|drop (the |it|this)|skip (it|the page|this page)|add (a |the )?page|no task builds|port tasks are missing|remove(d)? .* from (the )?integration|has no blueprint rendering/.test(
        t,
      ),
  ],
  [
    'ownership',
    (_, t) =>
      /rendering ids?\b|which id|who (creates|fixes|owns|builds|should)|what it needs is missing|still missing|is missing|depends on unbuilt|prerequisites|missing from|exist but are empty|re-run .* once/.test(
        t,
      ),
  ],
  [
    'naming',
    (_, t) =>
      /renam|template name|insert option|available renderings|standard values|variant|partial design|where (should|does) .* go|structure|__masters/.test(
        t,
      ),
  ],
  ['content', (_, t) => /copy|wording|which variant|matches the source|content/.test(t)],
];

/** What a card asks about, from its type and words. */
export function categoryOf(card: CardText): DecisionCategory {
  const text = `${card.title}\n${card.context}`.toLowerCase();
  return RULES.find(([, matches]) => matches(card, text))?.[0] ?? 'other';
}
