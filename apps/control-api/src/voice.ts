/**
 * Cypher's sentences (design system §4): every string the Bliss screens show in Cypher's voice is
 * written here, from plain inputs, so the rules live in one place and can be tested on their own.
 *
 * The rules: first person, sentences rather than labels; counts under thirteen are words; people
 * by first name; what Cypher would do and why, in one line; never an apology, never a narration
 * of process; a number only where it changes a decision; times as the project's local clock.
 */
import type { EscalationType, HandledItem, ReadTone, Recommendation, Voice } from '@lw/contracts';
import { clockTime, localDate, localParts } from '@lw/domain';

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const SMALL = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** A count as Cypher says it: a word under thirteen ("three", "eleven"), digits from 13 on. */
export function countWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < 13 ? SMALL[n]! : n.toLocaleString('en-US');
}

/** The same, at the start of a sentence ("Three"). */
export const CountWord = (n: number) => upperFirst(countWord(n));

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
export const ordinalWord = (i: number) => ORDINALS[i] ?? `number ${i + 1}`;

export const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Lower-cases the first word unless it is a name or an acronym ("GitHub", "SXA", "Vercel"). */
export function lowerFirst(s: string, properNouns: ReadonlySet<string> = new Set()): string {
  const word = /^[^\s,.;:]+/.exec(s)?.[0] ?? '';
  if (!word || properNouns.has(word) || /[A-Z]/.test(word.slice(1)) || /\d/.test(word)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** "Emily Chen" → "Emily". */
export const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] ?? name;

/** "Emily Chen" → "EC"; "Cypher" → "C". */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/[\s&]+/)
    .filter((w) => /^[A-Za-z]/.test(w));
  if (!words.length) return '?';
  const pick = words.length > 1 ? [words[0]!, words.at(-1)!] : [words[0]!];
  return pick.map((w) => w[0]!.toUpperCase()).join('');
}

/** A sentence's end: adds a full stop when it has none. */
export const period = (s: string) => {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

/** The first sentence of a paragraph (a stop followed by a space and a capital, or the end). */
export function firstSentence(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(?=\s+["“(]?[A-Z0-9])/.exec(t);
  return m ? m[1]! : t;
}

/** At most `n` characters, cut at a clause or a word, never mid-word. */
export function clip(text: string, n = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const head = t.slice(0, n);
  const clause = Math.max(head.lastIndexOf('; '), head.lastIndexOf(', '));
  if (clause > n * 0.5) return `${head.slice(0, clause)}.`;
  return `${head.slice(0, head.lastIndexOf(' ')).replace(/[,;:]$/, '')}…`;
}

/** Words that name a thing and not a count when a number follows them ("phase 9", "preview 7"). */
const NUMBERED = new Set([
  'phase',
  'phases',
  'preview',
  'batch',
  'step',
  'build',
  'gate',
  'version',
  'deploy',
  'pr',
  'wave',
  'day',
  'week',
  'item',
  'task',
  'option',
  'rule',
  'v',
]);

/**
 * Counts under thirteen written as digits become words: "the remaining 12 renderings" → "the
 * remaining twelve renderings". Numbers that name something ("phase 9", "preview 7", "403") stay.
 */
export function countsAsWords(text: string): string {
  return text.replace(
    /(^|[^\w.#-])(\d{1,2})(\s+)([a-z][a-z-]*s)\b/g,
    (whole, pre: string, num: string, sp: string, noun: string, offset: number, all: string) => {
      const n = Number(num);
      if (n > 12) return whole;
      const before = /([A-Za-z]+)\s*$/.exec(all.slice(0, offset + pre.length))?.[1]?.toLowerCase();
      if (before && NUMBERED.has(before)) return whole;
      return `${pre}${countWord(n)}${sp}${noun}`;
    },
  );
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** "2:24": the project's local clock, without AM or PM (the voice's way of saying a time). */
export function shortClock(t: number, tz: string): string {
  const p = localParts(t, tz);
  return `${p.hour % 12 || 12}:${String(p.minute).padStart(2, '0')}`;
}

const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "November 3". */
export function monthDay(t: number, tz: string): string {
  const p = localParts(t, tz);
  return `${MONTH[p.month - 1]} ${p.day}`;
}

/** When a clock runs out, said the way Cypher would: "2:24", "tomorrow at 9:00", "Thursday at 2:24". */
export function clockWord(deadline: number, now: number, tz: string): string {
  const day = localDate(deadline, tz);
  if (day === localDate(now, tz)) return shortClock(deadline, tz);
  if (day === localDate(now + 86_400_000, tz)) return `tomorrow at ${shortClock(deadline, tz)}`;
  if (deadline - now < 6 * 86_400_000)
    return `${DAY[localParts(deadline, tz).weekday]} at ${shortClock(deadline, tz)}`;
  return monthDay(deadline, tz);
}

/** "2:24 PM" today, else "Thu 2:24 PM", for the Everything mode's notes. */
export function clockNote(deadline: number, now: number, tz: string): string {
  const time = clockTime(deadline, tz);
  return localDate(deadline, tz) === localDate(now, tz)
    ? time
    : `${DAY[localParts(deadline, tz).weekday]!.slice(0, 3)} ${time}`;
}

/** How long Cypher stays quiet: until five (17:00 local), or until morning after it. */
export function untilWord(now: number, tz: string): string {
  return localParts(now, tz).hour < 17 ? 'until five' : 'until morning';
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** What a card of each type is called in a sentence ("one decision", "one review"). */
export const TYPE_NOUN: Record<EscalationType, string> = {
  decision: 'decision',
  gate: 'review',
  access: 'access request',
  blocker: 'blocker',
  budget: 'budget call',
  risk: 'risk',
};

const LEADING = new Set([
  'where',
  'what',
  'which',
  'how',
  'who',
  'when',
  'why',
  'whether',
  'should',
  'does',
  'do',
  'is',
  'are',
  'can',
  'a',
  'an',
  'the',
  'one',
  'two',
  'three',
  'four',
]);

/** Words that start the verb of a title: the subject is what comes before them. */
const VERBISH = new Set([
  'is',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'needs',
  'need',
  'reads',
  'read',
  'can',
  "can't",
  'cannot',
  "won't",
  "doesn't",
  "don't",
  'should',
  'will',
  'must',
  'may',
  'might',
  'blocks',
  'waits',
  'uses',
  'lacks',
  'went',
  'goes',
  'gets',
  'got',
  'or',
  'and',
  'for',
  'with',
  'without',
  'from',
  'to',
  'in',
  'on',
  'vs',
  'versus',
]);

/** Words that start an object: the word before them is a verb ("calls a", "reads its"). */
const DETERMINERS = new Set([
  'a',
  'an',
  'the',
  'its',
  'their',
  'his',
  'her',
  'our',
  'your',
  'no',
  'nowhere',
  'nothing',
  'every',
  'each',
  'all',
  'some',
  'this',
  'that',
  'these',
  'those',
]);

/** Words a card names that are written with a capital mid-sentence in its own text (names). */
function namesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![.!?]\s|^)\b([A-Z][\w.-]*)/g)) out.add(m[1]!);
  return out;
}

export interface CardText {
  type: EscalationType;
  title: string;
  context?: string;
  impact?: string;
  typeLabel?: string | null;
}

/**
 * A card's subject, short, for a sentence: "Where search reads its content" → "search decision",
 * "Thumbnail upload returned 403" → "thumbnail upload", "Pilot slice review" → "pilot slice review".
 */
export function cardSubject(card: CardText): string {
  const body = `${card.context ?? ''} ${card.impact ?? ''}`;
  const names = namesIn(body);
  const head = card.title.split(/\s*(?::|;|,|\?|—|–|\s-\s|\()\s*/)[0] ?? card.title;
  const words = head.split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEADING.has(words[0]!.toLowerCase())) words.shift();
  const kept: string[] = [];
  for (const [i, w] of words.entries()) {
    const lw = w.toLowerCase();
    const next = words[i + 1]?.toLowerCase() ?? '';
    // "calculator calls a private API": a word in -s before a determiner is the verb.
    const verbBeforeObject = /^[a-z]{3,}[^s]s$/.test(lw) && DETERMINERS.has(next);
    if (
      kept.length &&
      (VERBISH.has(lw) || verbBeforeObject || (/^[a-z]{3,}ed$/.test(lw) && !/eed$/.test(lw)))
    )
      break;
    if (/^\d+$/.test(w) && kept.length) break;
    kept.push(w);
    if (kept.length === 3) break;
  }
  let subject = kept.length ? lowerFirst(kept.join(' '), names) : '';
  const noun = card.type === 'gate' ? 'review' : card.type === 'decision' ? 'decision' : null;
  if (!subject) return card.type === 'gate' ? (card.typeLabel ?? 'review') : TYPE_NOUN[card.type];
  if (noun && !/(decision|question|choice|review|gate|approval|sign-off)$/i.test(subject))
    subject = `${subject} ${noun}`;
  return subject;
}

/** Imperative verbs an option label can start with ("Build the index…", "Re-verify…"). */
const IMPERATIVE = new Set(
  (
    'accept acknowledge add allow approve ask build cancel change choose confirm continue create ' +
    'cut defer delete document escalate ignore increase log monitor note restore revert roll ' +
    'deploy drop extend fix give go grant hold keep leave let lower map mark merge migrate model ' +
    'move pause port proceed publish raise rebuild record re-run rerun re-verify register reject ' +
    'remove replace resume retry reuse rotate run send ship skip split start stop stub swap take ' +
    'treat try upload use verify wait'
  ).split(' '),
);

/** An option's label as an action, its first clause only ("Continue without thumbnails"). */
function optionAction(label: string): string {
  return label
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .split(/\.\s+/)[0]!
    .trim()
    .replace(/[.;:]$/, '');
}

export interface RecommendationInput extends CardText {
  options: { id: string; label: string; recommended?: boolean }[];
  defaultOptionId: string | null;
  triage: { mode: string; optionId: string | null; reasoning: string } | null;
  /** The document a gate asks the Director to approve ("Blueprint v2"). */
  artifact?: string | null;
  /** Rewrites role names to first names ("Rendering Registrar" → "Carlos"). */
  names?: (text: string) => string;
}

/**
 * Cypher's verdict on a card: the Lead's answer when triage gave one, else the option marked as
 * recommended, else the default. Gates are read before they're approved; access cards are
 * granted or rotated.
 */
export function recommendationFor(card: RecommendationInput): Recommendation {
  const names = card.names ?? ((t: string) => t);
  const why = (text: string) => clip(countsAsWords(names(firstSentence(text))));
  if (card.type === 'gate') {
    const reason = card.impact?.trim()
      ? card.impact
      : card.artifact
        ? `${card.artifact} is what everything after this phase builds on.`
        : 'Nothing after this phase starts until you approve it.';
    return { verdict: 'Read it first.', why: why(reason), pick: null };
  }
  const triaged =
    card.triage && card.triage.mode !== 'forwarded' && card.triage.optionId
      ? card.options.find((o) => o.id === card.triage!.optionId)
      : undefined;
  const option =
    triaged ??
    card.options.find((o) => o.recommended) ??
    card.options.find((o) => o.id === card.defaultOptionId);
  const reasonText = triaged && card.triage?.reasoning.trim() ? card.triage.reasoning : card.impact;
  const because = why(reasonText?.trim() ? reasonText : card.context || card.title);
  if (!option) return { verdict: "I'd read the context first.", why: because, pick: null };

  const action = optionAction(option.label);
  const first = action.split(/\s+/)[0]!.toLowerCase();
  let verdict: string;
  if (/^rotate\b/i.test(action)) verdict = 'Rotate it.';
  else if (/^(grant|give)\b/i.test(action)) verdict = 'Grant it when you can.';
  else if (IMPERATIVE.has(first)) {
    const short = action.length > 70 ? action.split(/,\s+/)[0]! : action;
    // A bare verb takes the card as its object ("Acknowledge" → "I'd acknowledge it.").
    verdict = `I'd ${lowerFirst(short)}${/\s/.test(short) ? '' : ' it'}.`;
  } else if (action.split(/\s+/).length <= 6) verdict = `I'd choose ${lowerFirst(action)}.`;
  else verdict = `I'd pick the ${ordinalWord(card.options.indexOf(option))}.`;
  return { verdict: countsAsWords(names(verdict)), why: because, pick: option.id };
}

// ---------------------------------------------------------------------------
// The portfolio
// ---------------------------------------------------------------------------

export interface PortfolioVoiceInput {
  now: number;
  tz: string;
  projects: number;
  running: number;
  /** The Director's cards: each with its clock (ms) when it has one still to run. */
  yours: { deadline: number | null }[];
  /** Running projects with nothing yours that still need watching, and why in a clause. */
  watching: { name: string; why: string }[];
}

/** "Three things are yours. One needs you before 2:24. The other two can wait for a quiet half hour." */
export function portfolioVoice(v: PortfolioVoiceInput): Voice {
  const until = `I'll say nothing ${untilWord(v.now, v.tz)}.`;
  if (!v.projects) return { text: 'No projects yet.', emphasis: null, closing: null };
  const n = v.yours.length;
  const clocks = v.yours
    .map((y) => y.deadline)
    .filter((d): d is number => d !== null && d > v.now)
    .sort((a, b) => a - b);
  const c = clocks.length;
  const rest = restLine(n > 0, v.watching);

  if (!n) {
    const text = v.running ? 'Nothing needs you.' : 'Nothing is running, and nothing needs you.';
    return { text, emphasis: null, closing: v.running ? `${rest} ${until}` : null };
  }
  const clock = c ? clockWord(clocks[0]!, v.now, v.tz) : null;
  let text: string;
  let emphasis: string;
  if (n === 1) {
    const head = 'One thing is yours.';
    if (clock) {
      emphasis = `It needs you before ${clock}.`;
      text = `${head} ${emphasis}`;
    } else {
      emphasis = head;
      text = `${head} It can wait for a quiet half hour.`;
    }
  } else {
    const head = `${CountWord(n)} things are yours.`;
    if (!c) {
      emphasis = head;
      text = `${head} None has a clock; they can wait for a quiet half hour.`;
    } else {
      emphasis =
        c === 1
          ? `One needs you before ${clock}.`
          : `${CountWord(c)} need you soon, the first before ${clock}.`;
      const others = n - c;
      const tail =
        others === 0
          ? ''
          : others === 1
            ? ' The other can wait for a quiet half hour.'
            : ` The other ${countWord(others)} can wait for a quiet half hour.`;
      text = `${head} ${emphasis}${tail}`;
    }
  }
  return { text, emphasis, closing: `${rest} ${until}` };
}

/** "Everyone else is fine." with any project that still needs watching named. */
function restLine(someYours: boolean, watching: PortfolioVoiceInput['watching']): string {
  const fine = someYours ? 'Everyone else is fine' : 'Everyone is on pace';
  if (!watching.length) return `${fine}.`;
  if (watching.length === 1) return `${fine} but ${watching[0]!.name}, where ${watching[0]!.why}.`;
  return `${CountWord(watching.length)} projects need watching; ${someYours ? 'everyone else is fine' : 'the rest are on pace'}.`;
}

/** The reason a project needs watching, as a clause ("spend is past 80 percent of the budget"). */
export function watchClause(reason: 'retry' | 'budget'): string {
  return reason === 'budget'
    ? 'spend is past 80 percent of the budget'
    : 'a task is on its second retry';
}

// ---------------------------------------------------------------------------
// A project: its tile read, and Mission Control's voice
// ---------------------------------------------------------------------------

export interface ProjectReadInput {
  status: string;
  /** All phases done (an archived project that was accepted). */
  accepted: boolean;
  acceptedAt: number | null;
  tz: string;
  health: 'healthy' | 'attention' | 'blocked';
  /** Why health is attention, when it is. */
  attention: 'retry' | 'budget' | null;
  /** The Director's cards, in queue order. */
  yours: CardText[];
  /** A gate card is open. */
  atGate: boolean;
  /** The subject of the card stopping work (blocker or access), when one is open. */
  stoppedOn: string | null;
  /** Agents working now. */
  working: number;
  /** Paused by the Director or held. */
  paused: boolean;
  /** The newest thing the team did, rewritten with first names, when there is one. */
  latest: string | null;
}

/** Cypher's one line on a project tile. */
export function projectRead(p: ProjectReadInput): { read: string; tone: ReadTone } {
  if (p.status === 'completed' || (p.accepted && p.status === 'archived'))
    return {
      read: p.acceptedAt
        ? `Accepted. Delivered on ${monthDay(p.acceptedAt, p.tz)}.`
        : 'Accepted. Delivered.',
      tone: 'quiet',
    };
  if (p.status === 'cancelled') return { read: 'Cancelled. Nothing is running.', tone: 'quiet' };
  if (p.status === 'archived') return { read: 'Archived. Nothing is running.', tone: 'quiet' };
  if (p.status === 'intake')
    return p.yours.length
      ? { read: 'Not started. One thing is yours before it can.', tone: 'yours' }
      : { read: 'Not started yet.', tone: 'quiet' };
  if (p.atGate) return { read: 'At your gate. Nothing starts until you approve.', tone: 'yours' };
  if (p.stoppedOn && (p.paused || p.working === 0))
    return { read: 'Paused for access. Nothing is burning.', tone: 'blocked' };
  if (p.paused) return { read: 'Paused. Nothing is burning.', tone: 'quiet' };

  const pace =
    p.health === 'blocked' && p.stoppedOn
      ? `Blocked on the ${p.stoppedOn}.`
      : p.attention === 'budget'
        ? 'Spend is past 80 percent of the budget.'
        : p.attention === 'retry'
          ? 'One task is on its second retry.'
          : 'On pace.';
  if (p.yours.length === 1) {
    const subject = cardSubject(p.yours[0]!);
    return {
      read:
        p.stoppedOn === subject
          ? `${pace} It's the one thing that's yours.`
          : `${pace} The ${subject} is the one thing that's yours.`,
      tone: 'yours',
    };
  }
  if (p.yours.length > 1)
    return { read: `${pace} ${CountWord(p.yours.length)} things are yours.`, tone: 'yours' };
  if (p.health === 'blocked') return { read: pace, tone: 'blocked' };
  if (pace !== 'On pace.') return { read: pace, tone: 'normal' };
  if (!p.working && !p.latest)
    return { read: 'On pace. Nobody is working right now.', tone: 'quiet' };
  return { read: p.latest ? `On pace. ${period(p.latest)}` : 'On pace.', tone: 'normal' };
}

/** "nine working", "waiting on you", "resting". */
export function workingWord(working: number, yours: number): string {
  if (working > 0) return `${countWord(working)} working`;
  return yours > 0 ? 'waiting on you' : 'resting';
}

export interface MissionVoiceInput {
  now: number;
  tz: string;
  status: string;
  accepted: boolean;
  acceptedAt: number | null;
  /** The phase in front ("Components", 62). */
  phase: { name: string; percent: number } | null;
  /** The phase in front waits on the Director's gate. */
  atGate?: boolean;
  yours: { type: EscalationType; deadline: number | null }[];
  /** Who is waiting on the Director's answer (first name), when someone is. */
  waiter: string | null;
  attention: 'retry' | 'budget' | null;
  paused: boolean;
}

/** "Components is at 62 percent. One decision before 2:24 is yours, and Emily is waiting on it." */
export function missionVoice(v: MissionVoiceInput): Voice {
  const until = untilWord(v.now, v.tz);
  if (v.status === 'completed' || (v.accepted && v.status === 'archived'))
    return {
      text: v.acceptedAt
        ? `Accepted. Delivered on ${monthDay(v.acceptedAt, v.tz)}.`
        : 'Accepted. Delivered.',
      emphasis: null,
      closing: null,
    };
  if (v.status === 'cancelled' || v.status === 'archived')
    return { text: 'Nothing is running here any more.', emphasis: null, closing: null };

  const lead =
    v.status === 'intake'
      ? 'Nothing has started yet.'
      : v.paused
        ? 'Paused. Nothing is burning.'
        : !v.phase
          ? 'Between phases.'
          : v.atGate
            ? `${v.phase.name} waits at your gate.`
            : v.phase.percent <= 0
              ? `${v.phase.name} has just started.`
              : v.phase.percent >= 100
                ? `${v.phase.name} is complete.`
                : `${v.phase.name} is at ${countWord(Math.round(v.phase.percent))} percent.`;

  const n = v.yours.length;
  const clocks = v.yours
    .map((y) => y.deadline)
    .filter((d): d is number => d !== null && d > v.now)
    .sort((a, b) => a - b);
  const clock = clocks.length ? clockWord(clocks[0]!, v.now, v.tz) : null;
  const rest =
    v.attention === 'budget'
      ? 'Spend is past 80 percent of the budget.'
      : v.attention === 'retry'
        ? 'One task is on its second retry.'
        : v.paused || v.status === 'intake'
          ? null
          : n
            ? 'Everything else is on pace.'
            : 'Everything is on pace.';

  if (!n)
    return {
      text: rest ? `${lead} ${rest}` : lead,
      emphasis: null,
      closing: `I'll say nothing ${until}.`,
    };

  const clause =
    n === 1
      ? `One ${TYPE_NOUN[v.yours[0]!.type]}${clock ? ` before ${clock}` : ''} is yours`
      : `${CountWord(n)} things are yours${clock ? `, the first before ${clock}` : ''}`;
  const emphasis = v.waiter ? `${clause},` : `${clause}.`;
  const waiting = v.waiter
    ? ` and ${v.waiter} is waiting on ${n === 1 ? 'it' : 'one of them'}.`
    : '';
  return {
    text: [lead, `${emphasis}${waiting}`, rest].filter(Boolean).join(' '),
    emphasis,
    closing: v.waiter
      ? `${v.waiter} picks up the moment you decide. I'll say nothing ${until}.`
      : `I'll say nothing else ${until}.`,
  };
}

// ---------------------------------------------------------------------------
// A Lead's line
// ---------------------------------------------------------------------------

const DOING: Record<string, string> = {
  engineering: 'building',
  content: 'migrating',
  discovery: 'researching',
  quality: 'checking',
};

export interface LeadReadInput {
  workstream: string;
  /** The Lead's own work in this stretch is done. */
  leadDone: boolean;
  /** First names of the reports working now. */
  active: number;
  /** Reports who are stuck, and on what (a card's subject) when a card names them. */
  stuck: { first: string; on: string | null }[];
  /** Reports waiting, and whether an open card of the Director's names them. */
  waiting: { first: string; onYou: boolean }[];
  /** Open cards of the Director's that came from this team. */
  cards: { type: EscalationType }[];
  /** The next phase the team works in, when it is still to come. */
  nextPhase: { name: string; number: number } | null;
}

/** "Four building; Ryan is stuck on the token." / "Done. Aisha is on call for your decision." */
export function leadRead(l: LeadReadInput): { read: string; tone: ReadTone } {
  const stuck = l.stuck[0];
  const stuckLine = stuck ? `${stuck.first} is stuck${stuck.on ? ` on the ${stuck.on}` : ''}` : '';
  const onYou = l.waiting.find((w) => w.onYou);
  const cardsLine =
    l.cards.length === 1
      ? `one ${TYPE_NOUN[l.cards[0]!.type]} is with you`
      : l.cards.length > 1
        ? `${countWord(l.cards.length)} cards are with you`
        : '';

  if (l.active > 0) {
    const head = `${CountWord(l.active)} ${DOING[l.workstream] ?? 'working'}`;
    const second =
      stuckLine || cardsLine || (l.waiting[0] ? `${l.waiting[0].first} is waiting` : '');
    return {
      read: period(second ? `${head}; ${second}` : head),
      tone: stuck ? 'blocked' : 'normal',
    };
  }
  if (stuck) return { read: period(stuckLine), tone: 'blocked' };
  if (l.leadDone) {
    const tail = onYou
      ? ` ${onYou.first} is on call for your decision.`
      : cardsLine
        ? ` ${upperFirst(cardsLine)}.`
        : '';
    return { read: `Done.${tail}`, tone: 'normal' };
  }
  if (onYou) return { read: `${onYou.first} is waiting on your decision.`, tone: 'yours' };
  if (l.waiting[0]) return { read: `${l.waiting[0].first} is waiting.`, tone: 'normal' };
  if (cardsLine) return { read: `${upperFirst(cardsLine)}.`, tone: 'yours' };
  if (l.nextPhase)
    return {
      read: `Standing by until ${lowerFirst(l.nextPhase.name)}, phase ${countWord(l.nextPhase.number)}.`,
      tone: 'quiet',
    };
  return { read: 'Standing by.', tone: 'quiet' };
}

// ---------------------------------------------------------------------------
// Handled without the Director
// ---------------------------------------------------------------------------

export interface HandledInput {
  by: 'lead' | 'rule' | 'default' | 'chief_of_staff';
  /** The Lead's first name, when a Lead settled it. */
  who: string | null;
  subject: string;
  /** The option it went with, as words, when short enough to say. */
  choice: string | null;
  /** The project, on the portfolio ("on Ansell"). */
  project?: string | null;
}

/** "Kevin settled the alt-text question on Hazard route." */
export function handledLine(h: HandledInput): string {
  const where = h.project ? ` on ${h.project}` : '';
  const choice = h.choice ? `: ${h.choice}` : '';
  switch (h.by) {
    case 'rule':
      return h.who
        ? `${h.who} settled the ${h.subject}${where} by your rule${choice}.`
        : `Your rule settled the ${h.subject}${where}${choice}.`;
    case 'default':
      return `The ${h.subject}${where} took its default${choice}.`;
    case 'chief_of_staff':
      return `I settled the ${h.subject}${where}${choice}.`;
    case 'lead':
      return `${h.who ?? 'The lead'} settled the ${h.subject}${where}${choice}.`;
  }
}

/** An option's label short enough to say after a colon, or null. */
export function choiceWords(label: string | null | undefined): string | null {
  if (!label) return null;
  const action = optionAction(label);
  return action.split(/\s+/).length <= 6 ? lowerFirst(action) : null;
}

/** "The leads settled eleven cards on their own this morning." with "since 8". */
export function handledSummary(count: number, since: number, now: number, tz: string): HandledItem {
  const morning = localParts(now, tz).hour < 12;
  const start = localParts(since, tz);
  return {
    text: `The leads settled ${countWord(count)} cards on their own ${morning ? 'this morning' : 'today'}.`,
    at: null,
    when: `since ${start.hour % 12 || 12}`,
  };
}

// ---------------------------------------------------------------------------
// The Everything mode's KPI notes
// ---------------------------------------------------------------------------

/** "One has a clock: 2:24 PM", "No clocks". */
export function yoursNote(deadlines: number[], now: number, tz: string): string {
  const future = deadlines.filter((d) => d > now).sort((a, b) => a - b);
  if (!future.length) return 'No clocks';
  const at = clockNote(future[0]!, now, tz);
  return future.length === 1
    ? `One has a clock: ${at}`
    : `${CountWord(future.length)} have clocks; the first at ${at}`;
}

/** "$1,506". */
export const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

// ---------------------------------------------------------------------------
// Documents (Workbench Bliss): a document in plain words, when its agent wrote none
// ---------------------------------------------------------------------------

/** What each kind of document is, said to someone who won't open it. */
const DOCUMENT_IS: Record<string, string> = {
  blueprint:
    'This is the plan of record: every component, template, page and media item the team will build, and how.',
  platform_notes:
    'These are the platform notes: what this platform does differently, and how the team works with it.',
  inventory: 'This is an inventory: what the source site holds, item by item.',
  report: 'This is a report: what the team checked, and what it found.',
  handover_pack: "This is the handover: what the client's team needs to run the site without us.",
  screenshot: 'These are screenshots of the work as it stands.',
  video: 'This is a recording of the work as it stands.',
  pull_request: 'This is a change to the code, with what it touches.',
};

export interface DocumentVoiceInput {
  kind: string;
  title: string;
  latest: number;
  /** The agent who wrote the latest version, by first name; "I" when it was Cypher. */
  writer: string | null;
  /** The newest approved version and the gate that approved it. */
  approved: { version: number; gate: string } | null;
  /** The gate waiting on the Director for this document now. */
  awaiting: string | null;
  /** Open cards (other than the gate) that point at this document. */
  questions: number;
}

/** Two to four sentences: what the document is, who wrote which version, where it stands with you. */
export function documentSummary(d: DocumentVoiceInput): string {
  const out: string[] = [DOCUMENT_IS[d.kind] ?? `This is ${d.title}.`];
  const v = countWord(d.latest);
  if (d.writer === 'I') out.push(`I wrote version ${v}.`);
  else if (d.writer) out.push(`${d.writer} wrote version ${v}.`);
  else if (d.latest > 1) out.push(`Version ${v} is the latest.`);
  if (d.awaiting) out.push(`It waits on your approval at ${d.awaiting}.`);
  else if (d.approved && d.approved.version === d.latest)
    out.push(`You approved it at ${d.approved.gate}; nothing has changed since.`);
  else if (d.approved)
    out.push(
      `You approved version ${countWord(d.approved.version)} at ${d.approved.gate}; it has moved on since, so read what changed.`,
    );
  if (d.questions === 1) out.push('One question about it waits on you.');
  else if (d.questions > 1) out.push(`${CountWord(d.questions)} questions about it wait on you.`);
  return out.join(' ');
}

export interface DocumentPointerInput {
  artifactId: string;
  awaiting: boolean;
  questions: number;
  approvedVersion: number | null;
  latest: number;
  writer: { agentId: string; firstName: string } | null;
  /** The site preview has pages to look at. */
  preview: boolean;
  kind: string;
}

/** Up to three "what to look at" pointers, in the order they matter. */
export function documentPointers(
  d: DocumentPointerInput,
): {
  label: string;
  target: { kind: 'artifact' | 'agent' | 'preview' | 'surface'; ref: string };
}[] {
  const out: {
    label: string;
    target: { kind: 'artifact' | 'agent' | 'preview' | 'surface'; ref: string };
  }[] = [];
  if (d.awaiting)
    out.push({ label: 'The review that waits on you', target: { kind: 'surface', ref: 'inbox' } });
  else if (d.questions)
    out.push({
      label: d.questions === 1 ? 'The question about it' : 'The questions about it',
      target: { kind: 'surface', ref: 'inbox' },
    });
  if (d.approvedVersion !== null && d.approvedVersion < d.latest)
    out.push({
      label: `What changed since version ${countWord(d.approvedVersion)}`,
      target: { kind: 'artifact', ref: d.artifactId },
    });
  if (d.preview && (d.kind === 'blueprint' || d.kind === 'report'))
    out.push({ label: 'The site as it stands', target: { kind: 'preview', ref: '' } });
  if (d.writer)
    out.push({
      label: `${d.writer.firstName}, who wrote it`,
      target: { kind: 'agent', ref: d.writer.agentId },
    });
  return out.slice(0, 3);
}
