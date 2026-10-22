import { InMemoryEventStore } from '@lw/events';
import {
  conversation,
  missionControl,
  preview,
  scheduleSnapshot,
  settingsView,
  team,
  workbench,
} from '@lw/domain';
import { Blueprint, blueprintSnapshot } from '@lw/plan';
import { loadPlaybook } from '@lw/playbook-sdk';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemo, type DemoProject } from '../src';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const blobs = new Map<string, Uint8Array>();
let ansell: DemoProject;
let ansco: DemoProject;

const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const blueprintOf = (p: DemoProject) => {
  const s = p.state;
  const a = s.artifacts.blueprint!;
  const read = (version: number) =>
    Blueprint.parse(
      JSON.parse(
        new TextDecoder().decode(blobs.get(a.versions.find((v) => v.version === version)!.ref!)!),
      ),
    );
  const ok = a.approved[0];
  return blueprintSnapshot({
    seq: s.seq,
    current: { version: a.latest, blueprint: read(a.latest) },
    approved: ok ? { version: ok.version, at: ok.at, blueprint: read(ok.version) } : null,
    tasks: Object.values(s.tasks),
    decisions: s.decisions,
  });
};

beforeAll(async () => {
  [ansell, ansco] = (await startDemo(
    new InMemoryEventStore(),
    await loadPlaybook(PLAYBOOK),
    {
      async put(p, k, b) {
        blobs.set(`blob://${p}/${k}`, b);
        return `blob://${p}/${k}`;
      },
    },
    { auto: false, speed: 50, undoWindowMs: 50, directiveWindowMs: 100 },
  )) as [DemoProject, DemoProject];
});

afterAll(() => {
  ansell?.stop();
  ansco?.stop();
});

describe('Ansell, mid-build', () => {
  it('opens on the prototype’s state of play', () => {
    const mc = missionControl(ansell.state);
    expect(mc.subtitle).toBe(
      'Phase 4, Components, runs with phase 5 in parallel. Next gate: Acceptance.',
    );
    expect(mc.stats.map((s) => `${s.label} ${s.value}/${s.total}`)).toEqual([
      'Renderings 9/15',
      'Content items 0/89',
      'Media 0/17',
      'QA pass 7/9',
    ]);
    expect(mc.waitingOnYou.map((x) => x.title)).toEqual(['Pilot slice review']);
    expect(mc.project).toMatchObject({
      initials: 'AN',
      subtitle: 'ansell-main to SitecoreAI',
      health: 'healthy',
    });

    const emily = team(ansell.state).agents.find((a) => a.agentId === 'component-engineer')!;
    expect(emily).toMatchObject({
      persona: 'Emily Chen',
      state: 'active',
      now: 'Porting SampleKitPromo: starter kits from a Data folder',
      step: { n: 3, of: 5 },
      tokensProject: 540_000,
      modelClass: 'Sonnet-class',
    });

    const schedule = scheduleSnapshot(ansell.state, Date.now());
    expect(schedule.days).toHaveLength(10);
    expect(schedule.phases.find((p) => p.phase === 2)!.gateLabel).toBe(
      'Gate 1: Director approves the Blueprint',
    );

    const wb = workbench(ansell.state).artifacts.map((a) => a.shortTitle);
    expect(wb).toEqual(
      expect.arrayContaining([
        'Blueprint',
        'Components',
        'Content',
        'Media',
        'Platform Notes',
        'Pilot report',
        'Conformance',
        'PR 11',
        'PR 12',
      ]),
    );
    expect(preview(ansell.state)).toMatchObject({
      source: { label: 'Vite build of ansell-main' },
      target: { label: 'SitecoreAI, preview deploy 6' },
    });
    expect(settingsView(ansell.state, []).conventions.lockedAt).not.toBeNull();

    const bp = blueprintOf(ansell);
    expect(bp).toMatchObject({ version: 2, approvedVersion: 1 });
    expect(bp.collections[0]!.rows.filter((r) => r.changed).map((r) => r.key)).toEqual([
      'campaign-slots',
      'story',
    ]);
  });

  it('settles the search decision after the undo window: Blueprint, Decision Log, plan', async () => {
    await ansell.runScenario('hero');
    expect(ansell.state.escalations['E-07']!.status).toBe('open');
    await ansell.resolve('E-07', 'A');
    await until(() =>
      ansell.state.decisions.some((d) => d.question === 'Where search reads its content'),
    );
    const d = ansell.state.decisions.at(-1)!;
    expect(d).toMatchObject({ ref: 'D-07', decidedBy: 'director' });
    expect(ansell.state.tasks.t12!.state).toBe('done');
    const bp = blueprintOf(ansell);
    expect(bp.version).toBe(3);
    expect(bp.collections[0]!.rows.find((r) => r.key === 'search-overlay')).toMatchObject({
      fields: 'Index built from Edge GraphQL at build time',
      changed: true,
    });
    expect(bp.updatedBy).toContain('D-07');
  });

  it('answers status, needs and next, pauses by first name, and applies a scope directive', async () => {
    await ansell.postMessage('Status');
    await until(() => conversation(ansell.state).items.some((i) => i.kind === 'status'));
    expect(conversation(ansell.state).items.find((i) => i.kind === 'status')!.status).toMatchObject(
      {
        phase: 'Phase 4, Components',
        headline: { label: 'Renderings', value: '9 of 15', sub: 'QA pass 7 of 9' },
      },
    );
    await ansell.postMessage('What needs me?');
    await until(() => conversation(ansell.state).items.some((i) => i.kind === 'needs'));
    await ansell.postMessage('What is next?');
    await until(() => conversation(ansell.state).items.some((i) => i.kind === 'next'));
    expect(
      conversation(ansell.state).items.find((i) => i.kind === 'next')!.upNext.length,
    ).toBeGreaterThan(0);

    await ansell.postMessage('pause Emily');
    await until(() => ansell.state.agents['component-engineer']!.state === 'paused');
    await ansell.control({ verb: 'resume', scope: { kind: 'agent', id: 'component-engineer' } });
    expect(ansell.state.agents['component-engineer']!.state).toBe('active');

    await ansell.postMessage('Skip the sustainability band');
    await until(() =>
      conversation(ansell.state).items.some((i) => i.kind === 'directive_ack' && i.settled),
    );
    const ack = conversation(ansell.state).items.find((i) => i.kind === 'directive_ack')!;
    expect(ack.settled).toMatchObject({
      outcome: 'applied',
      summary: expect.stringMatching(/^Done\. Logged as D-08; Blueprint v4/),
    });
  });

  it('lets a choice be undone inside its window', async () => {
    await ansell.runScenario('kit');
    await ansell.resolve('E-09', 'B');
    await ansell.undo('E-09');
    expect(ansell.state.escalations['E-09']!.status).toBe('open');
    await new Promise((r) => setTimeout(r, 120));
    expect(
      ansell.state.decisions.some((d) => d.question === 'Sample kit request destination'),
    ).toBe(false);
  });
});

describe('Ansco, at Gate 1', () => {
  it('waits on Gate 1, then starts foundation when it is approved', async () => {
    expect(missionControl(ansco.state).subtitle).toBe(
      'Phase 2, Blueprint. Gate 1 waits on your approval.',
    );
    expect(
      settingsView(ansco.state, []).credentials.find((c) => c.system === 'Postgres (forms)'),
    ).toMatchObject({ provided: false });
    await ansco.resolve('E-11', 'approve');
    await until(() => ansco.state.phases[3]!.status === 'current');
    expect(ansco.state.phases[2]!.status).toBe('done');
    expect(ansco.state.tasks.e2!.state).toBe('running');
    expect(settingsView(ansco.state, []).conventions.lockedAt).not.toBeNull();
    expect(blueprintOf(ansco).approvedVersion).toBe(1);
    expect(missionControl(ansco.state).subtitle).toBe(
      'Phase 3, Foundation. Next gate: Acceptance.',
    );
  });
});
