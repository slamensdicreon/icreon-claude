import type { ActivityItem, ActivityPage } from '@lw/contracts';
import { get } from '../lib/api';

/**
 * Replay for the agent floor: a window of the project's history (every row the floor can act
 * on), a project-time clock that runs faster than real time, and the density strip under the
 * scene. Pure except for `loadHistory`.
 */

export type ReplayPreset = 'hour' | 'today' | 'phase' | 'start';
export const PRESETS: ReplayPreset[] = ['hour', 'today', 'phase', 'start'];
export const PRESET_LABEL: Record<ReplayPreset, string> = {
  hour: 'Last hour',
  today: 'Today',
  phase: 'This phase',
  start: 'Since start',
};
export const SPEEDS = [10, 60] as const;
export type Speed = (typeof SPEEDS)[number];

export interface TimeWindow {
  since: number;
  until: number;
}

/** Midnight today in the project's time zone. */
export function startOfDay(now: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sinceMidnight = ((n('hour') * 60 + n('minute')) * 60 + n('second')) * 1000 + (now % 1000);
  return now - sinceMidnight;
}

export function presetWindow(
  preset: ReplayPreset,
  ctx: { now: number; tz: string; startedAt: string | null; phaseEnteredAt: string | null },
): TimeWindow {
  const { now } = ctx;
  const since =
    preset === 'hour'
      ? now - 3_600_000
      : preset === 'today'
        ? startOfDay(now, ctx.tz)
        : preset === 'phase'
          ? ctx.phaseEnteredAt
            ? Date.parse(ctx.phaseEnteredAt)
            : startOfDay(now, ctx.tz)
          : ctx.startedAt
            ? Date.parse(ctx.startedAt)
            : startOfDay(now, ctx.tz);
  return { since: Math.min(since, now - 60_000), until: now };
}

/** The rows the floor acts on; the rest of the feed (budgets, metrics, messages) stays home. */
const REPLAY_TYPES = [
  'step.recorded',
  'review.recorded',
  'task.state',
  'agent.state',
  'escalation.raised',
  'escalation.updated',
  'decision.recorded',
  'preview.deployed',
  'control.hold',
  'phase.entered',
].join(',');

const PAGE = 2000;

/** Every replayable row in the window, oldest first. Pages newest-first until the window's start. */
export async function loadHistory(
  projectId: string,
  w: TimeWindow,
  onProgress: (loaded: number) => void,
  cancelled: () => boolean,
): Promise<ActivityItem[]> {
  const rows: ActivityItem[] = [];
  let before: number | null = null;
  do {
    const q = new URLSearchParams({
      view: 'all',
      limit: String(PAGE),
      type: REPLAY_TYPES,
      since: new Date(w.since).toISOString(),
    });
    if (before) q.set('before', String(before));
    const page: ActivityPage = await get<ActivityPage>(`/projects/${projectId}/activity?${q}`);
    if (cancelled()) return [];
    for (const i of page.items) if (Date.parse(i.ts) <= w.until) rows.push(i);
    onProgress(rows.length);
    before = page.nextBefore;
  } while (before !== null);
  rows.sort((a, b) => a.seq - b.seq);
  return rows;
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

export interface Replay {
  rows: ActivityItem[];
  /** Parsed timestamps, parallel to `rows`. */
  times: number[];
  /** The next row to play. */
  cursor: number;
  /** Project time (ms). */
  vt: number;
  speed: number;
  playing: boolean;
  window: TimeWindow;
  /** Set when a quiet stretch was just skipped; the bar says so for a moment. */
  skippedAt: number | null;
}

/** Nothing for this long (project time) and the floor at rest: jump ahead. */
const SKIP_GAP_MS = 20_000;
/** Land a little before the next row so the figure is seen leaving the desk. */
const LEAD_IN_MS = 2_000;
/** Rows released per frame at most; the clock waits for the rest. */
const MAX_PER_FRAME = 2;

export function createReplay(rows: ActivityItem[], window: TimeWindow, speed: number): Replay {
  return {
    rows,
    times: rows.map((r) => Date.parse(r.ts)),
    cursor: 0,
    vt: rows.length
      ? Math.max(window.since, rows[0]!.ts ? Date.parse(rows[0]!.ts) - LEAD_IN_MS : window.since)
      : window.since,
    speed,
    playing: true,
    window,
    skippedAt: null,
  };
}

/** Moves the playhead to `t`: the cursor points at the first row after it. */
export function seekTo(r: Replay, t: number): void {
  const vt = Math.max(r.window.since, Math.min(r.window.until, t));
  let lo = 0;
  let hi = r.times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (r.times[mid]! <= vt) lo = mid + 1;
    else hi = mid;
  }
  r.cursor = lo;
  r.vt = vt;
  r.skippedAt = null;
}

/**
 * Advances the clock by `dtMs` of real time and returns the rows that came due. With nothing due
 * for a while and the floor settled, the clock jumps to just before the next row.
 */
export function advance(r: Replay, dtMs: number, settled: boolean, now: number): ActivityItem[] {
  if (!r.playing) return [];
  const next = r.times[r.cursor];
  if (next !== undefined && next - r.vt > SKIP_GAP_MS && settled) {
    r.vt = next - LEAD_IN_MS;
    r.skippedAt = now;
  }
  r.vt = Math.min(r.window.until, r.vt + dtMs * r.speed);
  const due: ActivityItem[] = [];
  while (r.cursor < r.rows.length && r.times[r.cursor]! <= r.vt && due.length < MAX_PER_FRAME)
    due.push(r.rows[r.cursor++]!);
  // More due than released: the clock waits at the backlog's head so nothing is skipped.
  if (r.cursor < r.rows.length && r.times[r.cursor]! <= r.vt) r.vt = r.times[r.cursor]!;
  if (r.vt >= r.window.until && r.cursor >= r.rows.length) r.playing = false;
  return due;
}

export const atEnd = (r: Replay) => r.cursor >= r.rows.length && r.vt >= r.window.until;

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

export interface Density {
  bins: number;
  counts: number[];
  bad: number[];
  max: number;
  /** Positions 0..1 of cards raised. */
  cards: number[];
  /** Phase starts inside the window. */
  phases: { at: number; phase: number }[];
}

export function density(r: Replay, bins = 160): Density {
  const counts = new Array<number>(bins).fill(0);
  const bad = new Array<number>(bins).fill(0);
  const cards: number[] = [];
  const phases: Density['phases'] = [];
  const span = Math.max(1, r.window.until - r.window.since);
  r.rows.forEach((row, i) => {
    const at = (r.times[i]! - r.window.since) / span;
    const b = Math.min(bins - 1, Math.max(0, Math.floor(at * bins)));
    counts[b]!++;
    if (row.severity === 'failure') bad[b]!++;
    if (row.type === 'escalation.raised') cards.push(at);
    if (row.type === 'phase.entered' && row.phase !== null) phases.push({ at, phase: row.phase });
  });
  return { bins, counts, bad, max: Math.max(1, ...counts), cards, phases };
}
