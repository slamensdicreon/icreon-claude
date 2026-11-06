import type { ActivityItem, AgentView } from '@lw/contracts';
import { beatsFromItems, type Beat, type TaskLookup, type Workstream } from './model';

/**
 * The Floor as an orbit: Cypher at the core, each team on its own ring, the systems they use on
 * an outer ring. Pure model, no DOM: positions are fractions of the scene's side (0..1, centre at
 * 0.5), so the same scene draws at any size. Beats from the feed launch comets between agents,
 * stations and the core; `frame` says where everything is at a moment. Nothing moves that didn't
 * happen, except the orbits themselves, which turn slowly while the team works.
 */

export const RINGS: Workstream[] = ['discovery', 'engineering', 'content', 'quality'];
/** Ring radius per team, as a fraction of the side. */
export const RING_R: Record<Workstream | 'none', number> = {
  none: 0.112,
  discovery: 0.145,
  engineering: 0.215,
  content: 0.285,
  quality: 0.355,
};
/** Seconds per turn at full speed: the outer rings drift slower, like planets. */
export const RING_PERIOD: Record<Workstream | 'none', number> = {
  none: 70,
  discovery: 80,
  engineering: 100,
  content: 120,
  quality: 140,
};
export const STATION_R = 0.44;

export interface StationSpec {
  id: string;
  label: string;
  /** Degrees clockwise from the top. */
  deg: number;
}

/** The outer ring, clockwise from the Director at the top. */
export function stationsOf(cmsLabel: string): StationSpec[] {
  return [
    { id: 'door', label: 'Director', deg: 0 },
    { id: 'cms', label: cmsLabel, deg: 45 },
    { id: 'github', label: 'GitHub', deg: 90 },
    { id: 'hosting', label: 'Vercel', deg: 135 },
    { id: 'validators', label: 'Validators', deg: 180 },
    { id: 'sandbox', label: 'Sandbox', deg: 225 },
    { id: 'browser', label: 'Browser', deg: 270 },
    { id: 'research', label: 'Docs', deg: 315 },
  ];
}

export interface OrbitAgent {
  id: string;
  initials: string;
  name: string;
  first: string;
  role: string;
  tier: AgentView['tier'];
  ring: Workstream | 'none';
  /** Starting angle in degrees. */
  deg: number;
  reportsTo: string | null;
  state: AgentView['state'];
}

function initialsOf(a: Pick<AgentView, 'persona' | 'name'>): string {
  const words = (a.persona ?? a.name).split(/[\s'-]+/).filter(Boolean);
  if (!words.length) return '?';
  const two =
    words.length >= 2 ? words[0]![0]! + words[words.length - 1]![0]! : words[0]!.slice(0, 2);
  return two.toUpperCase();
}

const KNOWN = new Set<string>(RINGS);

/**
 * Everyone but Cypher, on their team's ring. A team's members share the ring evenly, the Lead
 * first; each ring starts at its own offset so teams don't line up. Older projects carry agents
 * with no team (the Handover Writer) or a team name this build doesn't know: they ride the inner
 * ring beside Cypher rather than disappear.
 */
export function orbitAgents(agents: AgentView[]): OrbitAgent[] {
  const byRing = new Map<Workstream | 'none', AgentView[]>();
  for (const a of agents) {
    if (a.tier === 'chief_of_staff') continue;
    const ring = a.workstream && KNOWN.has(a.workstream) ? a.workstream : 'none';
    if (!byRing.has(ring)) byRing.set(ring, []);
    byRing.get(ring)!.push(a);
  }
  const offset: Record<Workstream | 'none', number> = {
    none: 200,
    discovery: 30,
    engineering: 80,
    content: 130,
    quality: 330,
  };
  const out: OrbitAgent[] = [];
  for (const [ring, list] of byRing) {
    const sorted = [...list].sort(
      (a, b) => (a.tier === 'lead' ? -1 : 0) - (b.tier === 'lead' ? -1 : 0),
    );
    sorted.forEach((a, i) => {
      const name = a.persona ?? a.name;
      out.push({
        id: a.agentId,
        initials: initialsOf(a),
        name,
        first: name.split(/\s+/)[0] ?? name,
        role: a.name,
        tier: a.tier,
        ring,
        deg: (offset[ring] + (360 / sorted.length) * i) % 360,
        reportsTo: a.reportsTo,
        state: a.state,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

export type End = { agent: string } | { station: string } | { core: true };
export type Tone = 'team' | 'good' | 'bad' | 'ink' | 'coral';

export interface Comet {
  from: End;
  to: End;
  start: number;
  dur: number;
  tone: Tone;
  /** The team hue to use when tone is 'team'. */
  ws: Workstream | 'none';
  shape: 'dot' | 'doc';
}

export interface OrbitState {
  agents: Map<string, OrbitAgent>;
  stations: StationSpec[];
  comets: Comet[];
  /** Arrival glows, until a time, per station and per agent. */
  glow: Map<string, { until: number; tone: Tone; ws: Workstream | 'none' }>;
  flash: Map<string, { until: number; tone: Tone }>;
  working: Set<string>;
  paused: boolean;
  phase: number | null;
  /** The last place something landed, for Cypher's glance. */
  lastTarget: { end: End; at: number } | null;
  /** Bumped on a pass (a check came back green), for Cypher's pleased squint. */
  cheers: number;
  cheerAt: number;
  /** Bumped when something becomes the Director's. */
  alerts: number;
  /** The newest row that landed, for the caption under the floor. */
  latest: ActivityItem | null;
  beats: number;
  /** Turn offset per ring, in degrees, accumulated by `advance` so speed can change smoothly. */
  turn: Record<Workstream | 'none', number>;
}

export function createOrbit(agents: AgentView[], cmsLabel: string): OrbitState {
  const list = orbitAgents(agents);
  return {
    agents: new Map(list.map((a) => [a.id, a])),
    stations: stationsOf(cmsLabel),
    comets: [],
    glow: new Map(),
    flash: new Map(),
    working: new Set(list.filter((a) => a.state === 'active').map((a) => a.id)),
    paused: false,
    phase: null,
    lastTarget: null,
    cheers: 0,
    cheerAt: 0,
    alerts: 0,
    latest: null,
    beats: 0,
    turn: { none: 0, discovery: 0, engineering: 0, content: 0, quality: 0 },
  };
}

/** A new roster (or platform name) keeps what is in flight and how far the rings have turned. */
export function rebuildOrbit(prev: OrbitState, agents: AgentView[], cmsLabel: string): OrbitState {
  const next = createOrbit(agents, cmsLabel);
  next.comets = prev.comets.filter((c) => endKnown(next, c.from) && endKnown(next, c.to));
  next.glow = prev.glow;
  next.flash = prev.flash;
  next.paused = prev.paused;
  next.phase = prev.phase;
  next.lastTarget = prev.lastTarget;
  next.cheers = prev.cheers;
  next.cheerAt = prev.cheerAt;
  next.alerts = prev.alerts;
  next.latest = prev.latest;
  next.beats = prev.beats;
  next.turn = prev.turn;
  return next;
}

/** Nothing in flight, nobody flagged: where a replay starts. */
export function resetOrbit(s: OrbitState): void {
  s.comets = [];
  s.glow.clear();
  s.flash.clear();
  s.working.clear();
  s.paused = false;
  s.phase = null;
  s.lastTarget = null;
  s.latest = null;
}

function endKnown(s: OrbitState, e: End): boolean {
  if ('agent' in e) return s.agents.has(e.agent);
  if ('station' in e) return s.stations.some((x) => x.id === e.station);
  return true;
}

/** An agent this roster doesn't know (an older row, a retired role) acts from the core. */
const who = (s: OrbitState, id: string | null): End =>
  id && s.agents.has(id) ? { agent: id } : { core: true };

function launch(
  s: OrbitState,
  now: number,
  from: End,
  to: End,
  tone: Tone,
  shape: Comet['shape'] = 'dot',
) {
  const ws = 'agent' in from ? (s.agents.get(from.agent)?.ring ?? 'none') : 'none';
  // A crowded floor drops the oldest comet rather than piling up.
  if (s.comets.length > 20) s.comets.shift();
  s.comets.push({ from, to, start: now, dur: 1100, tone, ws, shape });
}

const PASS_GAP = 3500;

/**
 * Applies one beat at `now` (ms). `instant` rebuilds state without motion (a replay seek):
 * flags flip, nothing flies. `item` is the row the beat came from, when there is one.
 */
export function applyOrbitBeat(
  s: OrbitState,
  b: Beat,
  now: number,
  opts: { instant?: boolean; item?: ActivityItem | null } = {},
): void {
  const fly = !opts.instant;
  s.beats++;
  if (opts.item) s.latest = opts.item;
  const glowAt = (id: string, tone: Tone, ws: Workstream | 'none' = 'none') =>
    fly && s.glow.set(id, { until: now + 1100 + 900, tone, ws });
  const flashAt = (id: string, tone: Tone) =>
    fly && s.flash.set(id, { until: now + 1100 + 900, tone });
  const target = (end: End) => {
    if (fly) s.lastTarget = { end, at: now + 1100 };
  };
  const cheer = () => {
    if (!fly || now - s.cheerAt < PASS_GAP) return;
    s.cheers++;
    s.cheerAt = now + 1100;
  };
  switch (b.kind) {
    case 'step': {
      const from = who(s, b.agentId);
      if ('agent' in from) s.working.add(b.agentId);
      if (!b.station) break;
      const to: End = { station: b.station };
      if (fly) launch(s, now, from, to, b.bad ? 'bad' : 'team');
      glowAt(b.station, b.bad ? 'bad' : 'team', s.agents.get(b.agentId)?.ring ?? 'none');
      target(to);
      if (b.station === 'validators' && !b.bad) cheer();
      break;
    }
    case 'artifact':
      if (fly) launch(s, now, who(s, b.agentId), { core: true }, 'ink', 'doc');
      break;
    case 'review': {
      const to = who(s, b.agentId);
      if (fly) launch(s, now, who(s, b.reviewerId), to, b.accept ? 'good' : 'bad');
      if ('agent' in to) flashAt(to.agent, b.accept ? 'good' : 'bad');
      target(to);
      if (b.accept) cheer();
      break;
    }
    case 'card': {
      const from = who(s, b.agentId);
      if (fly) launch(s, now, from, { core: true }, 'coral');
      if ('agent' in from) flashAt(from.agent, 'coral');
      if (fly) s.alerts++;
      target({ core: true });
      break;
    }
    case 'decision':
      if (fly) launch(s, now, { station: 'door' }, { core: true }, 'ink');
      glowAt('door', 'ink');
      break;
    case 'dispatch': {
      const to = who(s, b.agentId);
      if ('agent' in to) s.working.add(b.agentId);
      if (fly) launch(s, now, { core: true }, to, 'ink');
      target(to);
      break;
    }
    case 'handoff': {
      const to = who(s, b.toAgentId);
      if (fly) launch(s, now, who(s, b.fromAgentId), to, 'team', 'doc');
      target(to);
      break;
    }
    case 'done': {
      s.working.delete(b.agentId);
      const a = s.agents.get(b.agentId);
      const lead = a?.reportsTo && s.agents.has(a.reportsTo) ? a.reportsTo : null;
      if (fly) launch(s, now, who(s, b.agentId), lead ? { agent: lead } : { core: true }, 'good');
      flashAt(b.agentId, 'good');
      break;
    }
    case 'deploy':
      if (fly) launch(s, now, who(s, b.agentId), { station: 'hosting' }, 'good');
      glowAt('hosting', 'good');
      target({ station: 'hosting' });
      break;
    case 'hold':
      s.paused = b.held;
      break;
    case 'presence': {
      const a = s.agents.get(b.agentId);
      if (a) a.state = b.state as OrbitAgent['state'];
      if (b.state === 'active') s.working.add(b.agentId);
      else s.working.delete(b.agentId);
      break;
    }
    case 'phase':
      s.phase = b.phase;
      break;
  }
}

/** Beats per row, keeping the row beside each so the caption can quote it. */
export function beatsWithItems(
  items: ActivityItem[],
  lookup: TaskLookup,
): { beat: Beat; item: ActivityItem }[] {
  const out: { beat: Beat; item: ActivityItem }[] = [];
  for (const item of items)
    for (const beat of beatsFromItems([item], lookup)) out.push({ beat, item });
  return out;
}

/** Turns the rings by `dt` seconds at `rate` (1 normal, 0 still), and drops what has landed. */
export function advanceOrbit(s: OrbitState, dt: number, rate: number, now: number): void {
  for (const ring of Object.keys(s.turn) as (Workstream | 'none')[])
    s.turn[ring] = (s.turn[ring] + (360 * dt * rate) / RING_PERIOD[ring]) % 360;
  s.comets = s.comets.filter((c) => now - c.start < c.dur);
  for (const [k, g] of s.glow) if (g.until < now) s.glow.delete(k);
  for (const [k, f] of s.flash) if (f.until < now) s.flash.delete(k);
}

export interface P {
  x: number;
  y: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const polar = (r: number, deg: number): P => ({
  x: 0.5 + r * Math.sin(rad(deg)),
  y: 0.5 - r * Math.cos(rad(deg)),
});

/** Where an agent is now, as a fraction of the side. */
export function agentAt(s: OrbitState, id: string): P | null {
  const a = s.agents.get(id);
  if (!a) return null;
  return polar(RING_R[a.ring], a.deg + s.turn[a.ring]);
}

export function stationAt(s: OrbitState, id: string): P | null {
  const st = s.stations.find((x) => x.id === id);
  return st ? polar(STATION_R, st.deg) : null;
}

export function endAt(s: OrbitState, e: End): P {
  if ('agent' in e) return agentAt(s, e.agent) ?? { x: 0.5, y: 0.5 };
  if ('station' in e) return stationAt(s, e.station) ?? { x: 0.5, y: 0.5 };
  return { x: 0.5, y: 0.5 };
}

/** A comet's position at `now`: a curve that bows toward the core, eased in and out. */
export function cometAt(s: OrbitState, c: Comet, now: number): { p: P; t: number } {
  const raw = Math.min(1, Math.max(0, (now - c.start) / c.dur));
  const t = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
  const a = endAt(s, c.from);
  const b = endAt(s, c.to);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const ctrl = { x: mid.x + (0.5 - mid.x) * 0.35, y: mid.y + (0.5 - mid.y) * 0.35 };
  const u = 1 - t;
  return {
    p: {
      x: u * u * a.x + 2 * u * t * ctrl.x + t * t * b.x,
      y: u * u * a.y + 2 * u * t * ctrl.y + t * t * b.y,
    },
    t: raw,
  };
}

/** Which way Cypher looks: a unit vector from the core toward a point. */
export function gazeTo(p: P): { x: number; y: number } {
  const dx = p.x - 0.5;
  const dy = p.y - 0.5;
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}
