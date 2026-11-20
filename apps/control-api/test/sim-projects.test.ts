import { fileURLToPath } from 'node:url';
import { missionControl } from '@lw/domain';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadCatalog } from '@lw/playbook-sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { SIM_SEEDS, simProjectId, startSimProjects, type SimProjects } from '../src/sim-projects';

const PLAYBOOKS = fileURLToPath(new URL('../../../playbooks', import.meta.url));

let running: SimProjects | null = null;
afterEach(() => {
  running?.stop();
  running = null;
  vi.restoreAllMocks();
});

async function start(count: number, without: string[] = []) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const catalog = await loadCatalog(PLAYBOOKS);
  for (const id of without) catalog.delete(id);
  running = startSimProjects({ store, catalog, count, speed: 200_000, projectId: simProjectId });
  return { projections, sims: running };
}

const until = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

it('seeds an Optimizely engagement beside the two SitecoreAI ones, each on its own playbook', async () => {
  expect(SIM_SEEDS.map((s) => [s.name, s.playbook])).toEqual([
    ['Acme corporate site', 'sitecoreai-migration'],
    ['Northwind marketing site', 'sitecoreai-migration'],
    ['Globex website', 'optimizely-saas-migration'],
  ]);
  const { projections, sims } = await start(3);
  const ids = SIM_SEEDS.map(simProjectId);
  expect(ids).toEqual([
    'prj-sim-acme-corporate-site',
    'prj-sim-northwind-marketing-site',
    'prj-sim-globex-website',
  ]);
  expect([...sims.commands.keys()]).toEqual(ids);
  await until(() => ids.every((id) => projections.get(id)?.playbook));
  expect(ids.map((id) => projections.get(id)!.playbook!.id)).toEqual(
    SIM_SEEDS.map((s) => s.playbook),
  );
  const [acme, northwind, globex] = ids.map((id) => () => projections.get(id)!);

  // Each plays its playbook's scenario: the Optimizely one talks to the CMS REST API and waits
  // for its Director at the step only they can do.
  await until(() =>
    Object.values(globex!().escalations).some((x) => x.status === 'open' && !x.defaultOptionId),
  );
  const card = Object.values(globex!().escalations).find((x) => x.status === 'open')!;
  expect(card.title).toBe('By hand: Give the API key content rights in the CMS');
  expect(missionControl(globex!()).project).toMatchObject({
    name: 'Globex website',
    client: 'Globex',
    demo: true,
  });
  await sims.commands.get(ids[2]!)!.resolve(card.escalationId, 'accept');
  // Marked done, discovery starts with the playbook's own tasks.
  await until(() => 'crawl-site' in globex!().tasks);
  expect(globex!().tasks['confirm-content-rights']!.state).toBe('done');
  // Acme waits at Gate 1; Northwind runs on autopilot to the end.
  await until(() =>
    Object.values(acme!().escalations).some((x) => x.type === 'gate' && x.status === 'open'),
  );
  await until(() => missionControl(northwind!()).project.status === 'completed', 30_000);
  expect(Object.keys(acme!().tasks)).toContain('p0-verify');
}, 60_000);

it('keeps what SIM_PROJECTS=2 has always started', async () => {
  const { sims } = await start(2);
  expect([...sims.commands.keys()]).toEqual(SIM_SEEDS.slice(0, 2).map(simProjectId));
});

it('skips an engagement whose playbook is not in the catalog, and says so', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { sims } = await start(3, ['optimizely-saas-migration']);
  expect([...sims.commands.keys()]).toEqual(SIM_SEEDS.slice(0, 2).map(simProjectId));
  expect(warn).toHaveBeenCalledWith(
    'Simulated project "Globex website" not started: no playbook optimizely-saas-migration in the catalog.',
  );
});
