import type { ActivityItem, AgentView } from '@lw/contracts';
import { describe, expect, it } from 'vitest';
import {
  advanceOrbit,
  agentAt,
  applyOrbitBeat,
  beatsWithItems,
  cometAt,
  createOrbit,
  orbitAgents,
  rebuildOrbit,
  resetOrbit,
  RING_R,
} from './orbit';

const agent = (over: Partial<AgentView>): AgentView => ({
  agentId: 'a',
  role: 'component-engineer',
  name: 'Component Engineer',
  tier: 'specialist',
  reportsTo: null,
  workstream: 'engineering',
  model: 'm',
  activePhases: [],
  state: 'idle',
  now: null,
  taskId: null,
  tokensThisTask: 0,
  since: null,
  persona: null,
  description: '',
  projectNote: null,
  step: null,
  tokensProject: 0,
  modelClass: 'Sonnet-class',
  next: null,
  ...over,
});

const row = (over: Partial<ActivityItem>): ActivityItem => ({
  seq: 1,
  ts: '2026-01-01T00:00:00.000Z',
  type: 'step.recorded',
  severity: 'routine',
  phase: null,
  agentId: null,
  taskId: null,
  toolServer: null,
  operation: null,
  resultCode: null,
  durationMs: null,
  tokens: null,
  summary: 'Something happened',
  actorId: 'system',
  toolLabel: null,
  outcome: null,
  note: null,
  ...over,
});

const roster = [
  agent({ agentId: 'cos', tier: 'chief_of_staff', workstream: null, name: 'Chief of Staff' }),
  agent({ agentId: 'eng-lead', tier: 'lead', persona: 'Marcus Reyes', name: 'Engineering Lead' }),
  agent({ agentId: 'eng-1', persona: 'Carlos Ramirez', reportsTo: 'eng-lead', state: 'active' }),
  agent({ agentId: 'qa-1', workstream: 'quality', persona: 'Kevin Nguyen' }),
];
const lookup = { agentOf: (t: string) => (t === 't1' ? 'eng-1' : null) };

describe('orbit', () => {
  it('puts each team on its ring, leaves Cypher at the core, and starts who is working', () => {
    const s = createOrbit(roster, 'SitecoreAI');
    expect(s.agents.has('cos')).toBe(false);
    expect(s.agents.get('eng-lead')!.ring).toBe('engineering');
    expect(s.agents.get('qa-1')!.ring).toBe('quality');
    expect(s.agents.get('eng-1')!.initials).toBe('CR');
    expect(s.working.has('eng-1')).toBe(true);
    expect(s.stations.find((x) => x.id === 'cms')!.label).toBe('SitecoreAI');
    const p = agentAt(s, 'eng-lead')!;
    expect(Math.hypot(p.x - 0.5, p.y - 0.5)).toBeCloseTo(RING_R.engineering, 5);
  });

  it('keeps older rosters whole: no team, an unknown team, a missing name', () => {
    const list = orbitAgents([
      agent({ agentId: 'writer', workstream: null, name: 'Handover Writer' }),
      agent({ agentId: 'legacy', workstream: 'design' as never, name: 'Designer' }),
      agent({ agentId: 'blank', name: '' }),
    ]);
    expect(list.find((a) => a.id === 'writer')!.ring).toBe('none');
    expect(list.find((a) => a.id === 'legacy')!.ring).toBe('none');
    expect(list.find((a) => a.id === 'blank')!.initials).toBe('?');
  });

  it('turns the feed into motion: a tool call flies to its station and lights it on arrival', () => {
    const s = createOrbit(roster, 'CMS');
    const beats = beatsWithItems(
      [row({ agentId: 'eng-1', toolServer: 'sandbox', operation: 'exec.build' })],
      lookup,
    );
    expect(beats).toHaveLength(1);
    applyOrbitBeat(s, beats[0]!.beat, 1000, { item: beats[0]!.item });
    expect(s.comets).toHaveLength(1);
    expect(s.comets[0]!.to).toEqual({ station: 'sandbox' });
    expect(s.glow.get('sandbox')).toBeTruthy();
    expect(s.latest?.summary).toBe('Something happened');
    // Halfway there the comet is between the two; after it lands it is gone.
    const mid = cometAt(s, s.comets[0]!, 1550);
    expect(mid.t).toBeCloseTo(0.5, 1);
    advanceOrbit(s, 1, 1, 2200);
    expect(s.comets).toHaveLength(0);
  });

  it('cheers on a green check, not on a red one, and not twice in a breath', () => {
    const s = createOrbit(roster, 'CMS');
    applyOrbitBeat(s, { kind: 'step', agentId: 'qa-1', station: 'validators', bad: true }, 0);
    expect(s.cheers).toBe(0);
    applyOrbitBeat(s, { kind: 'step', agentId: 'qa-1', station: 'validators', bad: false }, 5000);
    applyOrbitBeat(s, { kind: 'step', agentId: 'qa-1', station: 'validators', bad: false }, 5500);
    expect(s.cheers).toBe(1);
  });

  it('acts from the core for rows from roles no longer on the roster', () => {
    const s = createOrbit(roster, 'CMS');
    applyOrbitBeat(s, { kind: 'step', agentId: 'retired-role', station: 'github', bad: false }, 0);
    expect(s.comets[0]!.from).toEqual({ core: true });
    applyOrbitBeat(s, { kind: 'handoff', fromAgentId: 'gone', toAgentId: 'also-gone' }, 0);
    expect(s.comets[1]!.from).toEqual({ core: true });
    expect(s.comets[1]!.to).toEqual({ core: true });
  });

  it('sends a finished task to the Lead, and a card to Cypher', () => {
    const s = createOrbit(roster, 'CMS');
    applyOrbitBeat(s, { kind: 'done', agentId: 'eng-1' }, 0);
    expect(s.comets[0]!.to).toEqual({ agent: 'eng-lead' });
    expect(s.working.has('eng-1')).toBe(false);
    applyOrbitBeat(s, { kind: 'card', agentId: 'qa-1' }, 0);
    expect(s.comets[1]!.to).toEqual({ core: true });
    expect(s.alerts).toBe(1);
  });

  it('rebuilds state without motion on a replay seek, and resets cleanly', () => {
    const s = createOrbit(roster, 'CMS');
    const rows = [
      row({ seq: 1, type: 'agent.state', agentId: 'qa-1', operation: 'active' }),
      row({ seq: 2, type: 'control.hold', operation: 'pause' }),
      row({ seq: 3, type: 'phase.entered', phase: 4 }),
      row({ seq: 4, agentId: 'qa-1', toolServer: 'browser' }),
    ];
    for (const { beat, item } of beatsWithItems(rows, lookup))
      applyOrbitBeat(s, beat, 0, { instant: true, item });
    expect(s.comets).toHaveLength(0);
    expect(s.working.has('qa-1')).toBe(true);
    expect(s.paused).toBe(true);
    expect(s.phase).toBe(4);
    resetOrbit(s);
    expect(s.paused).toBe(false);
    expect(s.working.size).toBe(0);
  });

  it('keeps flights and the rings’ turn when the roster changes, dropping comets to people who left', () => {
    const s = createOrbit(roster, 'CMS');
    advanceOrbit(s, 10, 1, 0);
    applyOrbitBeat(s, { kind: 'dispatch', agentId: 'qa-1' }, 0);
    applyOrbitBeat(s, { kind: 'dispatch', agentId: 'eng-1' }, 0);
    const next = rebuildOrbit(
      s,
      roster.filter((a) => a.agentId !== 'qa-1'),
      'CMS',
    );
    expect(next.turn.engineering).toBe(s.turn.engineering);
    expect(next.comets).toHaveLength(1);
    expect(next.comets[0]!.to).toEqual({ agent: 'eng-1' });
  });

  it('holds still at rate 0 (paused, or reduced motion)', () => {
    const s = createOrbit(roster, 'CMS');
    const before = agentAt(s, 'eng-1');
    advanceOrbit(s, 5, 0, 0);
    expect(agentAt(s, 'eng-1')).toEqual(before);
  });
});
