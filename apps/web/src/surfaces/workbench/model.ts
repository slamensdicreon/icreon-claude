/*
 * The Workbench's pages: which artifacts the rail holds, in which section, and how each one is
 * labelled. Pure functions over the Workbench snapshot; the components only render them.
 */
import type { ArtifactView, BlueprintRow, BlueprintSnapshot } from '@lw/contracts';

/** The three pages that are not artifacts. */
export const DECISIONS = 'decisions';
export const FACTS = 'facts';
export const LESSONS = 'lessons';

/** Screenshots and videos aren't documents: the Workbench lists documents only. */
export const isDocument = (a: ArtifactView) => !['screenshot', 'video'].includes(a.kind);

/** Rail sections, in order: which artifact kinds each holds (null: whatever is left). */
const SECTIONS: { label: string; kinds: string[] | null; page?: Page }[] = [
  { label: 'Blueprint and plans', kinds: ['blueprint', 'platform_notes', 'charter', 'plan'] },
  { label: 'Inventories', kinds: ['inventory'] },
  { label: 'Reports', kinds: ['report'] },
  { label: 'Handover', kinds: ['handover_pack'] },
  {
    label: 'Decision Log',
    kinds: [],
    page: { id: DECISIONS, title: 'Decision Log', meta: 'Append-only' },
  },
  {
    label: 'Project facts',
    kinds: [],
    page: { id: FACTS, title: 'Project facts', meta: 'IDs and paths' },
  },
  {
    label: 'Lessons learned',
    kinds: [],
    page: { id: LESSONS, title: 'Lessons learned', meta: 'Retrospectives' },
  },
  { label: 'Pull requests', kinds: ['pull_request'] },
  { label: 'Other documents', kinds: null },
];

export type Tone = 'done' | 'yours' | 'warn' | 'moved' | 'quiet';

/** A status tag on a page: a word and what its color means. */
export interface Tag {
  label: string;
  tone: Tone;
}

export interface Page {
  id: string;
  title: string;
  meta: string;
  tag?: Tag | null;
}

export interface Section {
  label: string;
  items: Page[];
}

/** When an artifact last changed: its newest version's time. */
export const updatedAt = (a: ArtifactView) =>
  a.versions.reduce((m, v) => (v.ts > m ? v.ts : m), a.versions[0]?.ts ?? '');

/**
 * An artifact's status tag in the rail: approved as it stands, or changed since a gate approved an
 * earlier version. Documents no gate has seen carry no tag.
 */
export function tagOf(a: ArtifactView): Tag | null {
  const approved = a.approved[0];
  if (!approved) return null;
  return approved.version === a.latest
    ? { label: 'Approved', tone: 'done' }
    : { label: `Changed since v${approved.version}`, tone: 'moved' };
}

/** The rail: each section with the pages that match the search, empty sections left out. */
export function sectionsOf(
  docs: ArtifactView[],
  query: string,
  meta: (a: ArtifactView) => string,
): Section[] {
  const q = query.trim().toLowerCase();
  const match = (title: string) => !q || title.toLowerCase().includes(q);
  const placed = new Set<string>();
  return SECTIONS.map((sec) => {
    if (sec.page) return { label: sec.label, items: match(sec.page.title) ? [sec.page] : [] };
    const list = docs
      .filter((a) => (sec.kinds ? sec.kinds.includes(a.kind) : !placed.has(a.artifactId)))
      .sort((x, y) =>
        sec.label === 'Pull requests'
          ? updatedAt(y).localeCompare(updatedAt(x))
          : x.title.localeCompare(y.title, undefined, { numeric: true }),
      );
    for (const a of list) placed.add(a.artifactId);
    return {
      label: sec.label,
      items: list
        .filter((a) => match(a.title))
        .map((a) => ({ id: a.artifactId, title: a.title, meta: meta(a), tag: tagOf(a) })),
    };
  }).filter((sec) => sec.items.length);
}

/* ---------- the Blueprint ---------- */

export type Status = BlueprintRow['status'];
export const STATUSES: Status[] = ['done', 'in_progress', 'planned', 'merged', 'dropped'];

type Collection = BlueprintSnapshot['collections'][number];

/** A status in words; "done" is called what the collection calls it ("registered"). */
export const statusLabel = (s: Status, doneLabel: string) =>
  s === 'done'
    ? doneLabel
    : s === 'in_progress'
      ? 'in progress'
      : s === 'merged'
        ? 'library code'
        : s;

export const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * The Blueprint filter as `ui.bpFilter` holds it: "all", one key ("done", "changed"), or several
 * joined by commas ("done,planned,changed", "c:components"). Statuses are alternatives; "changed"
 * and collections narrow further.
 */
export interface BpFilter {
  statuses: Status[];
  changed: boolean;
  collections: string[];
}

export function parseFilter(raw: string): BpFilter {
  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k && k !== 'all');
  return {
    statuses: keys.filter((k): k is Status => (STATUSES as string[]).includes(k)),
    changed: keys.includes('changed'),
    collections: keys.filter((k) => k.startsWith('c:')).map((k) => k.slice(2)),
  };
}

export function formatFilter(f: BpFilter): string {
  const keys = [
    ...f.statuses,
    ...(f.changed ? ['changed'] : []),
    ...f.collections.map((c) => `c:${c}`),
  ];
  return keys.length ? keys.join(',') : 'all';
}

export const rowMatches = (f: BpFilter, coll: Collection, r: BlueprintRow) =>
  (!f.statuses.length || f.statuses.includes(r.status)) &&
  (!f.changed || r.changed) &&
  (!f.collections.length || f.collections.includes(coll.name));
