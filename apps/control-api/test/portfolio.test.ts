import { fileURLToPath } from 'node:url';
import { PortfolioDiagnostics, PortfolioItem } from '@lw/contracts';
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
