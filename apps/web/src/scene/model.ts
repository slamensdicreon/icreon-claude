import type { ActivityItem, AgentView, TaskView } from '@lw/contracts';

/**
 * The agent floor: the Activity feed as motion. Pure model, no DOM. An office floor is laid out
 * from the roster (Cypher in the middle, the Director's door at the top, one island per
 * workstream with its Lead at the head, tool stations along the edges, the live site and the
 * Workbench in the corners). Beats derived from the feed and the plan move figures and packets;
 * `tick` advances the motion. Nothing moves that didn't happen.
 */

export interface Point {
  x: number;
  y: number;
}

export type Workstream = 'discovery' | 'engineering' | 'content' | 'quality';
export const WORKSTREAMS: Workstream[] = ['discovery', 'engineering', 'content', 'quality'];
export const WORKSTREAM_LABEL: Record<Workstream, string> = {
  discovery: 'Discovery',
  engineering: 'Engineering',
  content: 'Content',
  quality: 'Quality',
};

/** Which station a tool server's calls go to; internal servers (artifacts, blackboard…) go nowhere. */
export const STATION_OF: Record<string, string> = {
  'sitecore-authoring': 'cms',
  'sitecore-cli': 'cms',
  'sitecore-deploy': 'cms',
  'optimizely-cms': 'cms',
  'optimizely-graph': 'cms',
  github: 'github',
  'build-repo': 'github',
  hosting: 'hosting',
  browser: 'browser',
  sandbox: 'sandbox',
  research: 'research',
  validators: 'validators',
};

export const STATION_LABEL: Record<string, string> = {
  cms: 'CMS',
  github: 'GitHub',
  hosting: 'Vercel',
  browser: 'Browser',
  sandbox: 'Sandbox',
  research: 'Docs',
  validators: 'Validators',
};

export interface Station {
  id: string;
  label: string;
  pos: Point;
}

export interface Island {
  ws: Workstream;
  label: string;
  /** Bounding box. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  width: number;
  height: number;
  door: Point;
  cypher: Point;
  workbench: Point;
  site: Point;
  islands: Island[];
  stations: Station[];
  /** Desk per agent id. */
  homes: Map<string, Point>;
}

export interface FigureSpec {
  id: string;
  initials: string;
  name: string;
  role: string;
  tier: AgentView['tier'];
  workstream: Workstream | null;
  reportsTo: string | null;
  /** Not instantiated in the current phase: drawn faint, never moves. */
  inactive: boolean;
}

export function initialsOf(a: Pick<AgentView, 'persona' | 'name' | 'tier'>): string {
  if (a.tier === 'chief_of_staff') return 'C';
  const words = (a.persona ?? a.name).split(/[\s'-]+/).filter(Boolean);
  const two =
    words.length >= 2 ? words[0]![0]! + words[words.length - 1]![0]! : words[0]!.slice(0, 2);
  return two.toUpperCase();
}

export function specsOf(agents: AgentView[]): FigureSpec[] {
  return agents.map((a) => ({
    id: a.agentId,
    initials: initialsOf(a),
    name: a.persona ?? a.name,
    role: a.name,
    tier: a.tier,
    workstream: (a.workstream as Workstream | null) ?? null,
    reportsTo: a.reportsTo,
    inactive: a.state === 'inactive',
  }));
}

/** Where everyone sits. Islands sit around Cypher; specialists in rows behind their Lead. */
export function layoutFloor(
  specs: FigureSpec[],
  width: number,
  height: number,
  cmsLabel: string,
): Layout {
  const W = Math.max(640, width);
  const H = Math.max(480, height);
  const door = { x: W / 2, y: 38 };
  const cypher = { x: W / 2, y: H * 0.47 };
  const workbench = { x: W - 70, y: 60 };
  const site = { x: W - 70, y: H - 62 };
  const centers: Record<Workstream, Point> = {
    discovery: { x: W * 0.25, y: H * 0.3 },
    engineering: { x: W * 0.75, y: H * 0.3 },
    content: { x: W * 0.75, y: H * 0.71 },
    quality: { x: W * 0.25, y: H * 0.71 },
  };
  const homes = new Map<string, Point>();
  const islands: Island[] = [];
  for (const ws of WORKSTREAMS) {
    const c = centers[ws];
    const lead = specs.find((s) => s.tier === 'lead' && s.workstream === ws);
    const members = specs.filter((s) => s.tier === 'specialist' && s.workstream === ws);
    // The Lead sits on the island's edge nearest Cypher; the rest fill rows behind.
    const towardX = Math.sign(cypher.x - c.x) || 1;
    const towardY = Math.sign(cypher.y - c.y) || 1;
    const cols = Math.min(4, Math.max(2, Math.ceil(members.length / 2)));
    const gap = 46;
    const rows = Math.max(1, Math.ceil(members.length / cols));
    const gridW = (cols - 1) * gap;
    const gridH = (rows - 1) * gap;
    const leadPos = { x: c.x + towardX * (gridW / 2 + 30), y: c.y + towardY * 8 };
    if (lead) homes.set(lead.id, leadPos);
    members.forEach((m, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = c.x - towardX * (gridW / 2 + 10) + towardX * col * gap;
      const y = c.y - gridH / 2 + row * gap - towardY * 4;
      homes.set(m.id, { x, y });
    });
    const pad = 34;
    // The Lead's name sits under the disc; give it room inside the island.
    const xs = [leadPos.x - 44, leadPos.x + 44, ...members.map((m) => homes.get(m.id)!.x)];
    const ys = [leadPos.y, ...members.map((m) => homes.get(m.id)!.y)];
    const x0 = Math.min(...xs) - pad;
    const x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad - 10;
    const y1 = Math.max(...ys) + pad;
    islands.push({ ws, label: WORKSTREAM_LABEL[ws], x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  const cos = specs.find((s) => s.tier === 'chief_of_staff');
  if (cos) homes.set(cos.id, cypher);
  // Anyone without a workstream (the Handover Writer reports to Cypher) sits in a row under him.
  const unassigned = specs.filter((s) => !homes.has(s.id));
  unassigned.forEach((s, i) =>
    homes.set(s.id, { x: cypher.x + (i - (unassigned.length - 1) / 2) * 40, y: cypher.y + 64 }),
  );
  const stations: Station[] = [
    { id: 'cms', label: cmsLabel, pos: { x: W - 66, y: H * 0.36 } },
    { id: 'github', label: STATION_LABEL.github!, pos: { x: W - 66, y: H * 0.5 } },
    { id: 'hosting', label: STATION_LABEL.hosting!, pos: { x: W - 66, y: H * 0.64 } },
    { id: 'research', label: STATION_LABEL.research!, pos: { x: 66, y: H * 0.43 } },
    { id: 'browser', label: STATION_LABEL.browser!, pos: { x: 66, y: H * 0.57 } },
    { id: 'sandbox', label: STATION_LABEL.sandbox!, pos: { x: W * 0.42, y: H - 62 } },
    { id: 'validators', label: STATION_LABEL.validators!, pos: { x: W * 0.58, y: H - 62 } },
  ];
  return { width: W, height: H, door, cypher, workbench, site, islands, stations, homes };
}

// ---------------------------------------------------------------------------
// Beats: what happened, as the scene understands it
// ---------------------------------------------------------------------------

export type Beat =
  | { kind: 'step'; agentId: string; station: string | null; bad: boolean }
  | { kind: 'artifact'; agentId: string }
  | { kind: 'review'; reviewerId: string; agentId: string | null; accept: boolean }
  | { kind: 'card'; agentId: string | null }
  | { kind: 'decision' }
  | { kind: 'dispatch'; agentId: string }
  | { kind: 'handoff'; fromAgentId: string; toAgentId: string }
  | { kind: 'done'; agentId: string }
  | { kind: 'deploy'; agentId: string | null }
  | { kind: 'hold'; held: boolean }
  /** An agent's state changed (from `agent.state` rows): who works, who is out of this phase. */
  | { kind: 'presence'; agentId: string; state: string }
  | { kind: 'phase'; phase: number };

/** What the scene needs to know about a task: who runs it and who waits on it. */
export interface TaskLookup {
  agentOf: (taskId: string) => string | null;
  heirsOf?: (taskId: string) => string[];
}

const asLookup = (l: TaskLookup | ((taskId: string) => string | null)): TaskLookup =>
  typeof l === 'function' ? { agentOf: l } : l;

/**
 * Beats from activity rows (oldest first). Log rows (tool calls, reviews, cards…) drive the live
 * floor; `task.state` and `agent.state` rows, which only the full feed carries, drive the replay
 * where no plan diff exists.
 */
export function beatsFromItems(
  items: ActivityItem[],
  lookup: TaskLookup | ((taskId: string) => string | null),
): Beat[] {
  const { agentOf, heirsOf } = asLookup(lookup);
  const taskAgent = agentOf;
  const out: Beat[] = [];
  for (const i of items) {
    switch (i.type) {
      case 'task.state': {
        const agentId = i.taskId ? agentOf(i.taskId) : null;
        if (!agentId || !i.operation) break;
        if (i.operation === 'running') out.push({ kind: 'dispatch', agentId });
        else if (i.operation === 'done') {
          out.push({ kind: 'done', agentId });
          for (const h of (heirsOf?.(i.taskId!) ?? []).slice(0, 3))
            if (h !== agentId) out.push({ kind: 'handoff', fromAgentId: agentId, toAgentId: h });
        } else if (i.operation === 'blocked') out.push({ kind: 'card', agentId });
        break;
      }
      case 'agent.state':
        if (i.agentId && i.operation)
          out.push({ kind: 'presence', agentId: i.agentId, state: i.operation });
        break;
      case 'phase.entered':
        if (i.phase !== null) out.push({ kind: 'phase', phase: i.phase });
        break;
      case 'step.recorded': {
        if (!i.agentId || !i.toolServer) break;
        if (i.toolServer === 'artifacts' && (i.operation ?? '').startsWith('write')) {
          out.push({ kind: 'artifact', agentId: i.agentId });
          break;
        }
        const station = STATION_OF[i.toolServer] ?? null;
        if (station)
          out.push({ kind: 'step', agentId: i.agentId, station, bad: i.severity === 'failure' });
        break;
      }
      case 'review.recorded':
        if (i.agentId)
          out.push({
            kind: 'review',
            reviewerId: i.agentId,
            agentId: i.taskId ? taskAgent(i.taskId) : null,
            accept: i.outcome !== 'reject',
          });
        break;
      case 'escalation.raised':
        out.push({ kind: 'card', agentId: i.agentId });
        break;
      case 'decision.recorded':
      case 'escalation.updated':
        out.push({ kind: 'decision' });
        break;
      case 'preview.deployed':
        out.push({ kind: 'deploy', agentId: i.agentId });
        break;
      case 'control.hold':
        out.push({ kind: 'hold', held: (i.operation ?? '').startsWith('pause') });
        break;
      default:
        break;
    }
  }
  return out;
}

const RUNNING = new Set(['running', 'validating']);

/** Beats from one plan snapshot to the next: dispatches, handoffs along dependencies, cards. */
export function beatsFromPlan(prev: Map<string, TaskView>, next: TaskView[]): Beat[] {
  const out: Beat[] = [];
  for (const t of next) {
    const was = prev.get(t.taskId);
    if (!was) continue;
    if (!RUNNING.has(was.state) && RUNNING.has(t.state))
      out.push({ kind: 'dispatch', agentId: t.agentId });
    if (was.state !== 'blocked' && t.state === 'blocked' && t.escalationId)
      out.push({ kind: 'card', agentId: t.agentId });
    if (was.state !== 'done' && t.state === 'done') {
      // The result goes to the Lead; the work moves on to whoever was waiting on it.
      out.push({ kind: 'done', agentId: t.agentId });
      const heirs = next.filter(
        (n) => n.dependsOn.includes(t.taskId) && n.agentId !== t.agentId && n.state !== 'done',
      );
      for (const h of heirs.slice(0, 3))
        out.push({ kind: 'handoff', fromAgentId: t.agentId, toAgentId: h.agentId });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Motion state
// ---------------------------------------------------------------------------

interface Trip {
  to: Point;
  dwell: number;
  kind: 'station' | 'lead' | 'cypher' | 'door' | 'home';
  stationId?: string;
  bad?: boolean;
}

export interface Figure {
  spec: FigureSpec;
  home: Point;
  pos: Point;
  trips: Trip[];
  /** When the current stop ends; null while walking. */
  dwellUntil: number | null;
  /** Working at the desk: pulses. */
  working: boolean;
  /** Running tasks, drawn as orbiting particles. */
  tasks: number;
  /** Recent positions for trails (presentation). */
  trail: Point[];
  /** A flash after a review or a failure: 1 fades to 0. */
  flash: number;
  flashBad: boolean;
  /** The station the figure is at, for the glow. */
  at: string | null;
}

export interface Packet {
  from: Point;
  to: Point;
  t: number;
  dur: number;
  kind: 'task' | 'doc' | 'release' | 'answer';
}

export interface SceneState {
  layout: Layout;
  figures: Map<string, Figure>;
  packets: Packet[];
  paused: boolean;
  /** Reduced motion: no interpolation, no pulses, no packets. */
  still: boolean;
  /** Steps counted since the floor opened, for the state pill. */
  beats: number;
  /** The phase the latest beat belonged to (replay caption); null until one is seen. */
  phase: number | null;
}

export function createScene(layout: Layout, specs: FigureSpec[], still: boolean): SceneState {
  const figures = new Map<string, Figure>();
  for (const s of specs) {
    const home = layout.homes.get(s.id) ?? layout.cypher;
    figures.set(s.id, {
      spec: s,
      home,
      pos: { ...home },
      trips: [],
      dwellUntil: null,
      working: false,
      tasks: 0,
      trail: [],
      flash: 0,
      flashBad: false,
      at: null,
    });
  }
  return { layout, figures, packets: [], paused: false, still, beats: 0, phase: null };
}

/** Keeps motion in flight when the roster or the canvas size changes. */
export function relayout(state: SceneState, layout: Layout, specs: FigureSpec[]): SceneState {
  const next = createScene(layout, specs, state.still);
  for (const [id, f] of next.figures) {
    const old = state.figures.get(id);
    if (!old) continue;
    f.working = old.working;
    f.tasks = old.tasks;
    // Scale the old position into the new layout, so a walk in progress carries on.
    const sx = layout.width / state.layout.width;
    const sy = layout.height / state.layout.height;
    f.pos = old.trips.length ? { x: old.pos.x * sx, y: old.pos.y * sy } : { ...f.home };
    f.trips = old.trips.map((t) => ({ ...t, to: { x: t.to.x * sx, y: t.to.y * sy } }));
  }
  next.paused = state.paused;
  next.beats = state.beats;
  next.phase = state.phase;
  return next;
}

/** Everyone at their desk, nothing in flight, nobody working: the replay's starting point. */
export function resetScene(state: SceneState): void {
  for (const f of state.figures.values()) {
    f.pos = { ...f.home };
    f.trips = [];
    f.dwellUntil = null;
    f.working = false;
    f.tasks = 0;
    f.trail = [];
    f.flash = 0;
    f.at = null;
    f.spec.inactive = false;
  }
  state.packets = [];
  state.paused = false;
  state.phase = null;
}

/** Ends every walk where it was headed, without the walking: used after a seek. */
export function settle(state: SceneState): void {
  for (const f of state.figures.values()) {
    const last = f.trips.at(-1);
    f.trips = last ? [last] : [];
    f.pos = { ...(last?.to ?? f.home) };
    f.dwellUntil = null;
    f.trail = [];
    f.flash = 0;
  }
  state.packets = [];
}

const near = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy });
function hash(who: string): number {
  let h = 0;
  for (const ch of who) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
/** A seat beside a figure, at an angle of the visitor's own, far enough that the discs don't touch. */
function seat(target: Point, who: string, radius: number): Point {
  const a = ((hash(who) % 360) * Math.PI) / 180;
  return near(target, Math.cos(a) * radius, Math.sin(a) * radius);
}
/**
 * A seat at a station: beside the box, never over it or its label, spread so visitors don't
 * stack. Edge stations seat toward the floor; the bottom pair seat toward the middle, in the
 * aisle between the two lower islands.
 */
function stationSeat(st: Station, layout: Layout, who: string): Point {
  const cx = layout.width / 2;
  const cy = layout.height / 2;
  const dx = cx - st.pos.x;
  const dy = cy - st.pos.y;
  const spread = ((hash(who) % 5) - 2) * 15;
  if (Math.abs(dx) > Math.abs(dy))
    return { x: st.pos.x + Math.sign(dx) * 46, y: st.pos.y + spread };
  // Beside and a little above, so a Lead's name clears the station's label.
  return {
    x: st.pos.x + (Math.sign(dx) || 1) * (44 + Math.abs(spread)),
    y: st.pos.y - 22 + (spread < 0 ? -10 : 0),
  };
}
const LEAD_SEAT = 38;
const CYPHER_SEAT = 46;

function queue(f: Figure, trip: Trip) {
  const last = f.trips.at(-1);
  // The same stop again: stay a little longer instead of pacing.
  if (last && last.kind === trip.kind && last.stationId === trip.stationId) {
    last.dwell = Math.min(2600, last.dwell + 400);
    if (trip.bad) last.bad = true;
    return;
  }
  if (f.trips.length >= 3) f.trips.splice(1, 1);
  f.trips.push(trip);
}

/** Applies one beat: queues walks, launches packets, flips flags. */
export function applyBeat(state: SceneState, b: Beat): void {
  const { layout, figures } = state;
  const fig = (id: string | null | undefined) => (id ? figures.get(id) : undefined);
  const cos = [...figures.values()].find((f) => f.spec.tier === 'chief_of_staff');
  state.beats++;
  switch (b.kind) {
    case 'hold': {
      state.paused = b.held;
      if (b.held) for (const f of figures.values()) f.trips = [];
      return;
    }
    case 'step': {
      const f = fig(b.agentId);
      const st = layout.stations.find((s) => s.id === b.station);
      if (!f || !st || f.spec.inactive) return;
      if (b.bad) {
        f.flash = 1;
        f.flashBad = true;
      }
      queue(f, {
        to: stationSeat(st, layout, f.spec.id),
        dwell: 700,
        kind: 'station',
        stationId: st.id,
        bad: b.bad,
      });
      return;
    }
    case 'artifact': {
      const f = fig(b.agentId);
      if (!f) return;
      if (!state.still)
        state.packets.push({
          from: { ...f.pos },
          to: layout.workbench,
          t: 0,
          dur: 1.3,
          kind: 'doc',
        });
      return;
    }
    case 'review': {
      const lead = fig(b.reviewerId);
      const f = fig(b.agentId);
      if (lead && f && f !== lead) {
        queue(f, { to: seat(lead.home, f.spec.id, LEAD_SEAT), dwell: 1000, kind: 'lead' });
        if (!state.still)
          state.packets.push({ from: { ...f.pos }, to: lead.home, t: 0, dur: 0.9, kind: 'task' });
      }
      const flashed = f ?? lead;
      if (flashed) {
        flashed.flash = 1;
        flashed.flashBad = !b.accept;
      }
      return;
    }
    case 'card': {
      const f = fig(b.agentId);
      if (f && cos && f !== cos)
        queue(f, { to: seat(cos.home, f.spec.id, CYPHER_SEAT), dwell: 1300, kind: 'cypher' });
      if (cos) queue(cos, { to: near(layout.door, 0, 34), dwell: 1000, kind: 'door' });
      return;
    }
    case 'decision': {
      if (cos) queue(cos, { to: near(layout.door, 0, 34), dwell: 700, kind: 'door' });
      if (!state.still)
        state.packets.push({
          from: layout.door,
          to: layout.cypher,
          t: 0,
          dur: 0.8,
          kind: 'answer',
        });
      return;
    }
    case 'dispatch': {
      const f = fig(b.agentId);
      if (!f) return;
      const lead = fig(f.spec.reportsTo) ?? cos;
      if (lead && !state.still)
        state.packets.push({ from: { ...lead.pos }, to: f.home, t: 0, dur: 0.9, kind: 'task' });
      f.working = true;
      f.tasks = Math.min(8, f.tasks + 1);
      return;
    }
    case 'presence': {
      const f = fig(b.agentId);
      if (!f) return;
      f.spec.inactive = b.state === 'inactive';
      f.working = b.state === 'active' && !state.paused;
      if (b.state === 'active') f.tasks = Math.max(1, f.tasks);
      else if (b.state !== 'waiting') f.tasks = 0;
      return;
    }
    case 'phase':
      state.phase = b.phase;
      return;
    case 'done': {
      const f = fig(b.agentId);
      if (!f) return;
      f.tasks = Math.max(0, f.tasks - 1);
      const lead = fig(f.spec.reportsTo) ?? cos;
      if (lead && lead !== f) {
        queue(f, { to: seat(lead.home, f.spec.id, LEAD_SEAT), dwell: 900, kind: 'lead' });
        if (!state.still)
          state.packets.push({ from: { ...f.pos }, to: lead.home, t: 0, dur: 0.9, kind: 'task' });
      }
      return;
    }
    case 'handoff': {
      const a = fig(b.fromAgentId);
      const c = fig(b.toAgentId);
      if (a && c && a !== c && !state.still)
        state.packets.push({ from: { ...a.pos }, to: c.home, t: 0, dur: 1.1, kind: 'task' });
      return;
    }
    case 'deploy': {
      const f = fig(b.agentId);
      const hosting = layout.stations.find((s) => s.id === 'hosting');
      if (f && hosting)
        queue(f, {
          to: stationSeat(hosting, layout, f.spec.id),
          dwell: 800,
          kind: 'station',
          stationId: 'hosting',
        });
      if (hosting && !state.still)
        state.packets.push({ from: hosting.pos, to: layout.site, t: 0, dur: 1.4, kind: 'release' });
      return;
    }
  }
}

/** The team's current state: who works, how many tasks each carries. */
export function applyTeam(
  state: SceneState,
  agents: AgentView[],
  runningTasks: Map<string, number>,
): void {
  for (const a of agents) {
    const f = state.figures.get(a.agentId);
    if (!f) continue;
    f.working = a.state === 'active' && !state.paused;
    f.tasks = Math.min(8, runningTasks.get(a.agentId) ?? (a.taskId ? 1 : 0));
    f.spec.inactive = a.state === 'inactive';
  }
}

const SPEED = 420; // px per second, cap
export const TRAIL = 24;

/** Advances the motion by `dt` seconds at time `now` (ms); `trail` points are kept per figure. */
export function tick(state: SceneState, dt: number, now: number, trail = TRAIL): void {
  for (const f of state.figures.values()) {
    const trip = f.trips[0];
    const target = trip ? trip.to : f.home;
    const dx = target.x - f.pos.x;
    const dy = target.y - f.pos.y;
    const dist = Math.hypot(dx, dy);
    if (state.still) {
      f.pos = { ...target };
    } else if (dist > 0.5) {
      // Ease toward the target; cap the speed so long walks read as walks.
      const k = 1 - Math.exp(-dt * 5.5);
      let sx = dx * k;
      let sy = dy * k;
      const step = Math.hypot(sx, sy);
      const max = SPEED * dt;
      if (step > max) {
        sx = (sx / step) * max;
        sy = (sy / step) * max;
      }
      f.pos = { x: f.pos.x + sx, y: f.pos.y + sy };
    }
    if (trip) {
      if (Math.hypot(target.x - f.pos.x, target.y - f.pos.y) < 3) {
        f.at = trip.kind === 'station' ? (trip.stationId ?? null) : null;
        if (f.dwellUntil === null) f.dwellUntil = now + trip.dwell;
        else if (now >= f.dwellUntil) {
          f.trips.shift();
          f.dwellUntil = null;
          f.at = null;
        }
      } else {
        f.at = null;
      }
    }
    if (f.flash > 0) f.flash = Math.max(0, f.flash - dt * 0.9);
    if (!state.still) {
      const last = f.trail.at(-1);
      if (!last || Math.hypot(last.x - f.pos.x, last.y - f.pos.y) > 4) {
        f.trail.push({ ...f.pos });
        while (f.trail.length > trail) f.trail.shift();
      } else if (f.trail.length) {
        // Standing still: the trail fades away.
        f.trail.shift();
      }
    }
  }
  for (const p of state.packets) p.t += dt / p.dur;
  state.packets = state.packets.filter((p) => p.t < 1);
}

/** An eased position along a packet's path, with a slight arc. */
export function packetPos(p: Packet): Point {
  const t = p.t < 0.5 ? 2 * p.t * p.t : 1 - Math.pow(-2 * p.t + 2, 2) / 2;
  const x = p.from.x + (p.to.x - p.from.x) * t;
  const y = p.from.y + (p.to.y - p.from.y) * t;
  const lift = Math.sin(Math.PI * t) * 18;
  return { x, y: y - lift };
}
