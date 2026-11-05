/*
 * What both faces of Mission Control read from the snapshots: the open cards in the order the
 * Director should meet them, each phase's owning team, and the facts behind the top line.
 */
import type {
  EscalationView,
  Face,
  LeadRow,
  MissionControlSnapshot,
  PlanSnapshot,
  Voice,
  Workstream,
} from '@lw/contracts';
import { hueOf } from '../../ui/cypher/parts';

const TYPE_ORDER: Record<string, number> = {
  blocker: 0,
  access: 1,
  gate: 2,
  decision: 3,
  budget: 4,
  risk: 5,
};

/** Open cards: those with a clock first (soonest first), then by type, then oldest. */
export function openCards(mc: MissionControlSnapshot): EscalationView[] {
  return mc.waitingOnYou
    .filter((x) => x.status === 'open')
    .sort((a, b) => {
      if (!!a.deadline !== !!b.deadline) return a.deadline ? -1 : 1;
      if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
      return (
        (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) ||
        a.raisedAt.localeCompare(b.raisedAt)
      );
    });
}

/** The team owning each phase: the workstream with the most of that phase's tasks. */
export function phaseOwners(plan: PlanSnapshot | null): Record<number, Workstream | null> {
  const tally: Record<number, Record<string, number>> = {};
  for (const t of plan?.tasks ?? []) {
    if (!t.workstream) continue;
    const row = (tally[t.phase] ??= {});
    row[t.workstream] = (row[t.workstream] ?? 0) + 1;
  }
  const out: Record<number, Workstream | null> = {};
  for (const [phase, row] of Object.entries(tally)) {
    out[Number(phase)] =
      (Object.entries(row).sort((a, b) => b[1] - a[1])[0]?.[0] as Workstream) ?? null;
  }
  return out;
}

/** The phase strip's segments. */
export function stripOf(mc: MissionControlSnapshot, owners: Record<number, Workstream | null>) {
  return mc.phases.map((p) => {
    const done = p.status === 'done';
    const current = p.status === 'current';
    const percent = done ? 100 : (p.percent ?? 0);
    const gateDone = p.gate === 'director' && done;
    return {
      key: String(p.number),
      name: p.shortName || p.name,
      percent,
      hue: hueOf(owners[p.number] ?? null),
      current,
      future: !done && !current,
      sub: done
        ? gateDone
          ? `${gateShort(p.gateLabel)} ✓`
          : 'done'
        : current
          ? `${percent}%`
          : gateShort(p.gateLabel, ''),
    };
  });
}

/** "Gate 1: Director approves the Blueprint" → "Gate 1". */
export const gateShort = (label: string | null, fallback = 'Gate') =>
  label ? (label.split(':')[0] ?? label).trim() : fallback;

/** age() already reads "just now" or "4 min ago"; kept as the one place that phrasing could change. */
export const ago = (a: string) => a;

/** Cypher's sentence, or the snapshot's own subtitle until the API carries one. */
export const voiceOf = (mc: MissionControlSnapshot): Voice =>
  mc.voice ?? { text: mc.subtitle, emphasis: null, closing: null };

const WS: Record<Workstream, string> = {
  discovery: 'Discovery',
  engineering: 'Engineering',
  content: 'Content',
  quality: 'Quality',
};
export const teamName = (w: Workstream | null | undefined) => (w ? WS[w] : 'Leadership');

/** A Lead as a face, from the row's own face or its name. */
export function leadFace(l: LeadRow): Face {
  if (l.face) return l.face;
  const parts = l.name.split(/\s+/);
  return {
    agentId: l.agentId,
    name: l.name,
    firstName: parts[0] ?? l.name,
    initials: parts
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase(),
    workstream: l.workstream,
    working: l.active > 0,
  };
}

const WORDS = [
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
export const word = (n: number) => (n < 13 ? WORDS[n]! : String(n));
