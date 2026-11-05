import { fileURLToPath } from 'node:url';
import { MissionControlSnapshot, PortfolioOverview, WorkbenchSnapshot } from '@lw/contracts';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { Simulation, sitecoreScenario, startDemo, type DemoProject } from '@lw/simulator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { demoCommands, simulationCommands } from '../src/commands';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));

let app: FastifyInstance;
let demo: DemoProject;
let sim: Simulation;

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms = 10_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const get = async (url: string) => {
  const r = await app.inject({ method: 'GET', url });
  expect(r.statusCode).toBe(200);
  return r.json();
};

/** Every Cypher sentence follows the voice rules: the emphasis is part of the text, no apologies. */
const inVoice = (v: { text: string; emphasis: string | null; closing: string | null }) => {
  expect(v.text.length).toBeGreaterThan(0);
  if (v.emphasis) expect(v.text).toContain(v.emphasis);
  expect(`${v.text} ${v.closing ?? ''}`).not.toMatch(/sorry|apolog|\b(1[0-2]|[2-9]) things\b/i);
};

beforeAll(async () => {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const playbook = await loadPlaybook(PLAYBOOK);
  // A finished engagement (its cards settled by their defaults on autopilot)…
  sim = new Simulation(store, playbook, {
    projectId: 'p1',
    name: 'Acme corporate site',
    client: 'Acme Corp',
    speed: 200_000,
    autopilot: true,
  });
  await sim.run(sitecoreScenario);
  sim.stop();
  // …and Ansell mid-build, with its pilot slice waiting at the Director's review.
  [demo] = (await startDemo(
    store,
    playbook,
    { put: async (p, k) => `blob://${p}/${k}` },
    { auto: false, speed: 50, undoWindowMs: 50, directiveWindowMs: 100 },
  )) as [DemoProject];
  app = await buildApp({
    store,
    projections,
    commands: (id) =>
      id === 'p1'
        ? simulationCommands(sim)
        : id === demo.projectId
          ? demoCommands(demo)
          : undefined,
  });
});

afterAll(async () => {
  demo?.stop();
  await app?.close();
});

describe('GET /portfolio/overview', () => {
  it('serves the Dashboard in the contract shape, in Cypher’s voice', async () => {
    const o = PortfolioOverview.parse(await get('/portfolio/overview'));
    inVoice(o.voice);
    expect(o.timezone).toBe('America/New_York');
    expect(o.kpis.map((k) => k.key)).toEqual(['yours', 'running', 'spend', 'events']);
    expect(o.counts).toMatchObject({ projects: 2, running: 1, archived: 1 });
    expect(o.counts.agents).toBeGreaterThan(10);

    // What's yours carries Cypher's verdict and its raiser.
    const pilot = o.yours.find((y) => y.escalation.title === 'Pilot slice review')!;
    expect(pilot).toMatchObject({
      projectId: 'prj-ansell',
      project: 'Ansell',
      projectInitials: 'AN',
    });
    expect(pilot.escalation.recommendation).toEqual({
      verdict: 'Read it first.',
      why: 'Approving confirms the pattern for the remaining twelve renderings.',
      pick: null,
    });
    expect(o.kpis[0]).toMatchObject({ value: String(o.yours.length), tone: 'yours' });
    expect(o.voice.text).toMatch(/yours/);
    expect(o.voice.closing).toMatch(
      /^Everyone else is fine.* I'll say nothing until (five|morning)\.$/,
    );

    // Ansell first (it needs the Director), the accepted engagement last.
    const [ansell, acme] = o.projects;
    expect(ansell).toMatchObject({
      projectId: 'prj-ansell',
      archived: false,
      phaseLabel: 'Components, phase 4',
      phaseName: 'Components',
      eye: 'needs-a-word',
      readTone: 'yours',
      hue: 'engineering',
    });
    // A review without a phase gate is one card among others, not "at your gate".
    expect(ansell!.read).toBe("On pace. The pilot slice review is the one thing that's yours.");
    expect(ansell!.faces.length).toBeGreaterThan(0);
    expect(ansell!.faces.length).toBeLessThanOrEqual(5);
    expect(ansell!.workingWord).toMatch(/^(\w+ working|waiting on you|resting)$/);
    expect(acme).toMatchObject({
      projectId: 'p1',
      archived: true,
      hue: 'done',
      percent: 100,
      healthWord: 'Accepted',
      eye: 'resting',
      readTone: 'quiet',
    });
    expect(acme!.read).toMatch(/^Accepted\. Delivered on [A-Z][a-z]+ \d+\.$/);
    expect(acme!.phaseLabel).toMatch(/^Accepted at /);

    // The week and the day.
    expect(o.spendByDay.days.map((d) => d.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(o.spendByDay.weekUsd).toBeGreaterThan(0);
    expect(o.escalations.points).toHaveLength(25);
    expect(o.escalations.points.at(-1)!.raised).toBe(o.escalations.raised);
    expect(o.escalations.raised).toBeGreaterThan(0);
    for (const d of o.deploys) expect(d.id).toMatch(/^[A-Z]+-\d+$/);
    expect(o.deploys.length).toBeLessThanOrEqual(5);
    expect(o.load.length).toBeLessThanOrEqual(5);
    expect(o.handled.length).toBeLessThanOrEqual(4);
    // The finished engagement's cards went to their defaults while it ran.
    expect(o.handled.some((h) => /took its default/.test(h.text))).toBe(true);
    expect(o.kpis[3]!.note).toMatch(/^\d+ running · \d+ failures?$/);
  });
});

describe('GET /projects/:id/mission-control', () => {
  it('carries the voice, verdicts, raisers and the Leads’ lines', async () => {
    const r = await app.inject({ method: 'POST', url: '/projects/prj-ansell/scenarios/hero' });
    expect(r.statusCode).toBe(200);
    const mc = await until(async () => {
      const m = MissionControlSnapshot.parse(await get('/projects/prj-ansell/mission-control'));
      return m.waitingOnYou.some((x) => x.escalationId === 'E-07') && m;
    });
    inVoice(mc.voice!);
    expect(mc.voice!.text).toMatch(/^Components is at \w+ percent\. Two things are yours/);
    expect(mc.handled).toEqual([]);

    const search = mc.waitingOnYou.find((x) => x.escalationId === 'E-07')!;
    expect(search.recommendation).toEqual({
      verdict: "I'd build the search index from Experience Edge at build time.",
      why: 'The Blueprint keeps products, topics and documents in Sitecore, so search should read them from there too.',
      pick: 'A',
    });
    // No source task: the Lead whose triage saw it first raised it.
    expect(search.raisedBy).toMatchObject({
      agentId: 'engineering-lead',
      name: 'Marcus Reyes',
      firstName: 'Marcus',
      initials: 'MR',
      workstream: 'engineering',
    });

    const lead = (id: string) => mc.teamNow.find((l) => l.agentId === id)!;
    for (const row of mc.teamNow) {
      expect(row.face?.agentId).toBe(row.agentId);
      expect(row.read).toMatch(/\.$/);
      expect(row.reports!.length).toBeGreaterThan(0);
    }
    expect(lead('content-lead')).toMatchObject({
      read: 'Standing by until migration, phase six.',
      readTone: 'quiet',
    });
    expect(lead('discovery-lead').read).toMatch(/^Done\./);
    expect(lead('engineering-lead').read).toMatch(/^\w+ building/);
    expect(lead('engineering-lead').face!.name).toBe('Marcus Reyes');
  });

  it('says what was settled without the Director on a finished engagement', async () => {
    const mc = MissionControlSnapshot.parse(await get('/projects/p1/mission-control'));
    expect(mc.voice!.text).toMatch(/^Accepted\. Delivered on /);
    expect(mc.handled!.length).toBeGreaterThan(0);
    expect(mc.handled!.length).toBeLessThanOrEqual(4);
    for (const h of mc.handled!) {
      expect(h.at).not.toBeNull();
      expect(h.text).toMatch(/^[A-Z].*\.$/);
    }
    for (const l of mc.teamNow) expect(l.read).toMatch(/^Done\./);
  });
});

describe('GET /projects/:id/workbench', () => {
  it('gives every document a plain-words summary and pointers: the agent’s, or Cypher’s', async () => {
    const wb = WorkbenchSnapshot.parse(await get(`/projects/${demo.projectId}/workbench`));
    const by = new Map(wb.artifacts.map((a) => [a.artifactId, a]));
    // The demo's agents wrote these at save.
    expect(by.get('pilot')).toMatchObject({
      summaryBy: 'agent',
      summary: expect.stringMatching(/^The pilot slice works end to end/),
    });
    expect(by.get('pilot')!.attention!.length).toBeGreaterThan(0);
    expect(by.get('blueprint')!.summary).toMatch(/components carry over/);
    for (const a of wb.artifacts) {
      expect(a.summary!.length).toBeGreaterThan(0);
      expect(a.attention!.length).toBeLessThanOrEqual(3);
      expect(a.summary).not.toMatch(/sorry|apolog/i);
    }
  });
});

describe('the week and the deploys, from the log', () => {
  it('takes each day’s spend as the change in cumulative spend, and reads hosting steps as deploys', async () => {
    const { createProjectState } = await import('@lw/domain');
    const { portfolioOverview } = await import('../src/overview');
    const { LwEvent } = await import('@lw/contracts');
    const s = createProjectState('px');
    Object.assign(s, {
      name: 'Pixel site',
      initials: 'PX',
      status: 'running',
      timezone: 'America/New_York',
      budgets: { tokens: 1_000_000, usd: 1_000, hours: 100 },
      spent: { tokens: 0, usd: 160, hours: 1 },
      toolLabels: { hosting: 'Vercel' },
      hosting: { provider: 'vercel', project: 'px-web', url: null },
    });
    // Wednesday, November 4, 2026, noon in New York.
    const now = Date.parse('2026-11-04T17:00:00Z');
    let seq = 0;
    const ev = (ts: string, body: object, severity = 'routine') =>
      LwEvent.parse({
        id: `e${++seq}`,
        projectId: 'px',
        seq,
        ts,
        actor: { kind: 'agent', id: 'head-integrator' },
        subject: { kind: 'project', id: 'px' },
        severity,
        ...body,
      });
    const spent = (usd: number) => ({
      type: 'budget.updated',
      data: { spent: { tokens: 0, usd, hours: 0 } },
    });
    const step = (operation: string, resultCode: number, outcome: string | null = null) => ({
      type: 'step.recorded',
      data: {
        stepId: `s${seq}`,
        agentId: 'head-integrator',
        taskId: 't1',
        toolServer: 'hosting',
        operation,
        resultCode,
        durationMs: 1000,
        summary: operation,
        outcome,
        note: resultCode >= 400 ? 'Token expired. Rotate it.' : null,
      },
    });
    const log = [
      ev('2026-10-30T15:00:00Z', spent(40)), // last week: the baseline
      ev('2026-11-02T15:00:00Z', spent(100)), // Monday
      ev('2026-11-03T15:00:00Z', spent(120)), // Tuesday
      ev('2026-11-04T13:00:00Z', step('deploy preview 3', 200, 'ready')),
      ev('2026-11-04T14:00:00Z', spent(160)), // Wednesday
      ev('2026-11-04T16:00:00Z', step('deploy preview 4', 500), 'failure'),
    ];
    const read = async (_id: string, before: number | undefined, limit: number) =>
      log
        .filter((e) => before === undefined || e.seq < before)
        .reverse()
        .slice(0, limit);
    const o = PortfolioOverview.parse(await portfolioOverview([s], read, now));
    expect(o.spendByDay.days).toEqual([
      { label: 'Mon', date: '2026-11-02', usd: 60 },
      { label: 'Tue', date: '2026-11-03', usd: 20 },
      { label: 'Wed', date: '2026-11-04', usd: 40 },
      { label: 'Thu', date: '2026-11-05', usd: null },
      { label: 'Fri', date: '2026-11-06', usd: null },
    ]);
    expect(o.spendByDay).toMatchObject({ weekUsd: 120, budgetUsd: 1_000 });
    expect(o.kpis[2]).toMatchObject({ value: '$120', note: '$160 of $1,000 overall' });
    expect(o.deploys).toEqual([
      {
        projectId: 'px',
        id: 'PX-4',
        what: 'preview failed, token expired',
        at: '2026-11-04T16:00:00Z',
        state: 'failed',
      },
      {
        projectId: 'px',
        id: 'PX-3',
        what: 'px-web preview',
        at: '2026-11-04T13:00:00Z',
        state: 'ok',
      },
    ]);
    expect(o.kpis[3]).toMatchObject({ value: '2', note: '0 running · 1 failure' });
    expect(o.voice).toEqual({
      text: 'Nothing needs you.',
      emphasis: null,
      closing: "Everyone is on pace. I'll say nothing until five.",
    });

    // With a cache, a project whose log hasn't moved isn't read again; a new event reads it.
    let reads = 0;
    const counted: typeof read = (...a) => {
      reads++;
      return read(...a);
    };
    const cache = new Map() as Parameters<typeof portfolioOverview>[3] & object;
    await portfolioOverview([s], counted, now, cache);
    const first = reads;
    expect(first).toBeGreaterThan(0);
    await portfolioOverview([s], counted, now + 10_000, cache);
    expect(reads).toBe(first);
    s.seq = 99;
    await portfolioOverview([s], counted, now + 20_000, cache);
    expect(reads).toBeGreaterThan(first);
  });
});
