import { fileURLToPath } from 'node:url';
import {
  PortfolioActivity,
  PortfolioScorecard,
  PortfolioTeam,
  PortfolioWorkbench,
} from '@lw/contracts';
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

describe('the portfolio sections', () => {
  it('GET /portfolio/team: every project with its Leads in Cypher’s words and everyone', async () => {
    const t = PortfolioTeam.parse(await get('/portfolio/team'));
    inVoice(t.voice);
    expect(t.projects.map((p) => p.projectId).sort()).toEqual(['p1', 'prj-ansell']);
    const ansell = t.projects.find((p) => p.projectId === 'prj-ansell')!;
    expect(ansell.archived).toBe(false);
    expect(ansell.leads.length).toBeGreaterThan(0);
    expect(ansell.leads.every((l) => typeof l.read === 'string' && l.read.length > 0)).toBe(true);
    expect(ansell.agents.length).toBeGreaterThan(10);
    // The count is of live projects only: the finished engagement has nobody working.
    const working = ansell.agents.filter((a) => a.state === 'active').length;
    expect(t.working).toBe(working);
  });

  it('GET /portfolio/workbench: every document, newest first, with its project', async () => {
    const w = PortfolioWorkbench.parse(await get('/portfolio/workbench'));
    inVoice(w.voice);
    expect(w.documents.length).toBeGreaterThan(0);
    expect(new Set(w.documents.map((d) => d.projectId)).size).toBe(2);
    const times = w.documents.map((d) => d.updatedAt ?? '');
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('GET /portfolio/activity: the newest rows across projects, merged by time and filtered', async () => {
    const a = PortfolioActivity.parse(await get('/portfolio/activity?limit=40'));
    inVoice(a.voice);
    expect(a.items.length).toBeGreaterThan(0);
    expect(a.items.length).toBeLessThanOrEqual(40);
    const times = a.items.map((i) => i.ts);
    expect([...times].sort().reverse()).toEqual(times);
    expect(a.items.every((i) => i.toolLabel !== null && i.who.length > 0)).toBe(true);
    const one = PortfolioActivity.parse(
      await get('/portfolio/activity?project=prj-ansell&limit=10'),
    );
    expect(one.items.every((i) => i.projectId === 'prj-ansell' && i.project === 'Ansell')).toBe(
      true,
    );
    const bad = PortfolioActivity.parse(await get('/portfolio/activity?severity=failure,warning'));
    expect(bad.items.every((i) => i.severity !== 'routine')).toBe(true);
  });

  it('GET /portfolio/scorecard: the projects as one, with each side by side', async () => {
    const sc = PortfolioScorecard.parse(await get('/portfolio/scorecard'));
    inVoice(sc.voice);
    expect(sc.projects).toHaveLength(2);
    const sum = (k: 'tasks' | 'cards' | 'settledWithoutDirector') =>
      sc.projects.reduce((n, p) => n + p.totals[k], 0);
    expect(sc.totals.tasks).toBe(sum('tasks'));
    expect(sc.totals.cards).toBe(sum('cards'));
    expect(sc.totals.settledWithoutDirector).toBe(sum('settledWithoutDirector'));
    expect(sc.totals.settledWithoutDirectorPct).toBeGreaterThanOrEqual(0);
    expect(sc.totals.settledWithoutDirectorPct).toBeLessThanOrEqual(100);
    const raised = sc.categories.reduce((n, c) => n + c.raised, 0);
    expect(raised).toBe(sc.totals.cards);
  });
});
