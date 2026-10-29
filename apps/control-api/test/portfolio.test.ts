import { fileURLToPath } from 'node:url';
import {
  PlaybookScorecard,
  PortfolioDiagnostics,
  PortfolioItem,
  Scorecard,
  SettingsSnapshot,
} from '@lw/contracts';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { Simulation, sitecoreScenario } from '@lw/simulator';
import { afterEach, expect, it } from 'vitest';
import { buildApp, type WorkerHeartbeat } from '../src/app';
import { simulationCommands } from '../src/commands';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const NOW = Date.parse('2026-10-29T12:00:00Z');
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function start(heartbeat?: () => Promise<WorkerHeartbeat | null>) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const sim = new Simulation(store, await loadPlaybook(PLAYBOOK), {
    projectId: 'p1',
    name: 'Acme corporate site',
    client: 'Acme Corp',
    speed: 200_000,
    autopilot: true,
  });
  await sim.run(sitecoreScenario);
  sim.stop();
  const app = await buildApp({
    store,
    projections,
    commands: (id) => (id === 'p1' ? simulationCommands(sim) : undefined),
    now: () => NOW,
    heartbeat,
  });
  closers.push(() => app.close());
  return app;
}

it('lists every project with where it stands, what it cost and where it lives', async () => {
  const app = await start();
  const r = await app.inject({ method: 'GET', url: '/portfolio' });
  expect(r.statusCode).toBe(200);
  const [p] = PortfolioItem.array().parse(r.json());
  expect(p).toMatchObject({
    id: 'p1',
    name: 'Acme corporate site',
    status: 'completed',
    playbook: { id: 'sitecoreai-migration' },
    phases: { total: 10, done: 10 },
    capabilityGaps: 0,
  });
  expect(p!.spent.usd).toBeGreaterThan(0);
  expect(p!.lastActivityAt).not.toBeNull();
});

it("reports the services and says plainly when the worker hasn't been seen", async () => {
  const fresh = await start(async () => ({
    at: new Date(NOW - 20_000).toISOString(),
    version: 'abc1234def',
    servers: ['github', 'sitecore-authoring'],
    liveRoles: ['content-analyst'],
    temporal: true,
  }));
  const d = PortfolioDiagnostics.parse(
    (await fresh.inject({ method: 'GET', url: '/portfolio/diagnostics' })).json(),
  );
  const by = Object.fromEntries(d.services.map((s) => [s.key, s]));
  expect(by.api!.status).toBe('ok');
  expect(by.database!.status).toBe('ok');
  expect(by.worker).toMatchObject({ status: 'ok' });
  expect(by.worker!.detail).toContain('20 s ago on abc1234: 2 tool servers, 1 roles on Claude');
  expect(by.temporal!.status).toBe('ok');
  // Demo projects aren't orchestrated: only live ones are listed.
  expect(d.projects).toEqual([]);

  const stale = await start(async () => ({
    at: new Date(NOW - 30 * 60_000).toISOString(),
    version: null,
    servers: [],
    liveRoles: [],
    temporal: true,
  }));
  const s = PortfolioDiagnostics.parse(
    (await stale.inject({ method: 'GET', url: '/portfolio/diagnostics' })).json(),
  );
  expect(s.services.find((x) => x.key === 'worker')!.status).toBe('down');

  const none = await start();
  const n = PortfolioDiagnostics.parse(
    (await none.inject({ method: 'GET', url: '/portfolio/diagnostics' })).json(),
  );
  expect(n.services.find((x) => x.key === 'worker')).toMatchObject({
    status: 'unknown',
    detail: 'Not reported in this mode',
  });
});

it("scores a project's work from its log, and compares only real projects on a playbook", async () => {
  const app = await start();
  const r = await app.inject({ method: 'GET', url: '/projects/p1/scorecard' });
  expect(r.statusCode).toBe(200);
  const card = Scorecard.parse(r.json());
  expect(card.totals.tasks).toBeGreaterThan(0);
  expect(card.totals.done).toBe(card.totals.tasks);
  expect(card.totals.cards).toBe(card.categories.reduce((n, c) => n + c.raised, 0));
  expect(card.categories.find((c) => c.category === 'release')?.raised).toBeGreaterThan(0);
  expect(card.phases.map((p) => p.phase)).toEqual([...new Set(card.phases.map((p) => p.phase))]);
  expect((await app.inject({ method: 'GET', url: '/projects/nope/scorecard' })).statusCode).toBe(
    404,
  );
  // The simulated project is a demo: comparisons leave it out.
  const pb = PlaybookScorecard.parse(
    (await app.inject({ method: 'GET', url: '/playbooks/sitecoreai-migration/scorecard' })).json(),
  );
  expect(pb).toEqual({ playbookId: 'sitecoreai-migration', projects: [] });
});

it('shows who may settle each kind of card, and keeps releases and scope with the Director', async () => {
  const app = await start();
  const settings = SettingsSnapshot.parse(
    (await app.inject({ method: 'GET', url: '/projects/p1/settings' })).json(),
  );
  const row = (c: string) => settings.autonomy.find((r) => r.category === c);
  expect(row('media')).toMatchObject({ level: 'shadow', default: 'shadow', locked: false });
  expect(row('release')).toMatchObject({ level: 'ask', locked: true });
  expect(row('scope')).toMatchObject({ level: 'ask', locked: true });
  const r = await app.inject({
    method: 'PUT',
    url: '/projects/p1/settings/autonomy',
    payload: { value: { media: 'lead', release: 'lead' } },
  });
  expect(r.statusCode).toBe(422);
  expect(r.json().error.message).toMatch(/Releases, gates and budget always come to you/);
  const bad = await app.inject({
    method: 'PUT',
    url: '/projects/p1/settings/autonomy',
    payload: { value: { media: 'sometimes' } },
  });
  expect(bad.statusCode).toBe(400);
  // A valid change is recorded at once; the next card reads it.
  const ok = await app.inject({
    method: 'PUT',
    url: '/projects/p1/settings/autonomy',
    payload: { value: { media: 'lead', access: 'shadow' } },
  });
  expect(ok.statusCode).toBe(200);
  const after = SettingsSnapshot.parse(
    (await app.inject({ method: 'GET', url: '/projects/p1/settings' })).json(),
  );
  expect(after.autonomy.find((r) => r.category === 'media')).toMatchObject({
    level: 'lead',
    default: 'shadow',
  });
  expect(after.autonomy.find((r) => r.category === 'access')?.level).toBe('shadow');
});
