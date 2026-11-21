import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { canTransition, missionControl, plan, team, workbench } from '@lw/domain';
import { InMemoryEventStore, Projections } from '@lw/events';
import { Blueprint, compilePlan } from '@lw/plan';
import { loadPlaybook } from '@lw/playbook-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { optimizelyScenario, scenarioFor, Simulation, sitecoreScenario } from '../src';
import { OPTIMIZELY_SITE } from '../src/optimizely';

const dir = (id: string) => fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));
const PLAYBOOK = dir('optimizely-saas-migration');
// The playbook SDK's own YAML parser: this package has none of its own.
const { parse } = createRequire(new URL('../../playbook-sdk/package.json', import.meta.url))(
  'yaml',
) as { parse: (text: string) => unknown };

type Run = Awaited<ReturnType<typeof runToEnd>>;

async function runToEnd() {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const playbook = await loadPlaybook(PLAYBOOK);
  const sim = new Simulation(store, playbook, {
    projectId: 'p1',
    name: 'Globex website',
    client: 'Globex',
    speed: 200_000,
    autopilot: true,
  });
  await sim.run(optimizelyScenario);
  sim.stop();
  return { playbook, events: await store.read('p1'), state: projections.get('p1')! };
}

type Step = Extract<Run['events'][number], { type: 'step.recorded' }>;
const stepsOf = (run: Run) => run.events.filter((e): e is Step => e.type === 'step.recorded');
/** Where the first step matching this is in the log; fails the test when there is none. */
const at = (run: Run, server: string, operation: string, summary: RegExp = /./) => {
  const i = run.events.findIndex(
    (e) =>
      e.type === 'step.recorded' &&
      e.data.toolServer === server &&
      e.data.operation === operation &&
      summary.test(e.data.summary),
  );
  expect(i, `${server}.${operation} ${summary}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe('optimizely scenario', () => {
  let run: Run;
  beforeAll(async () => {
    run = await runToEnd();
  }, 60_000);

  it('runs all ten phases to completion on autopilot', async () => {
    const mc = missionControl(run.state);
    expect(mc.project.status).toBe('completed');
    expect(mc.project.playbook).toMatchObject({ id: 'optimizely-saas-migration' });
    expect(mc.phases.every((p) => p.status === 'done')).toBe(true);
    expect(mc.waitingOnYou.filter((x) => x.status === 'open')).toHaveLength(0);
    for (const [key, total] of [
      ['components_registered', 16],
      ['pages_migrated', 48],
      ['media_uploaded', 120],
    ] as const)
      expect(mc.metrics.find((m) => m.key === key)).toMatchObject({ value: total, total });
    expect(mc.metrics.find((m) => m.key === 'parity')?.value).toBe(98.6);
    // Mission Control counts in the platform's words: the playbook's stat cards.
    expect(mc.stats.map((s) => `${s.label} ${s.value}`)).toEqual([
      'Content types 16',
      'Experiences 48',
      'Media 120',
      'QA pass null',
    ]);
    expect(plan(run.state).tasks.every((t) => t.state === 'done')).toBe(true);
    // The Optimizely team is twenty roles: the content model is code.
    expect(team(run.state).agents).toHaveLength(20);
    // The documents the playbook's stub outputs name, no more.
    const outputs = parse(
      await readFile(`${PLAYBOOK}/fixtures/stub-outputs.yaml`, 'utf8'),
    ) as Record<string, { artifacts?: { artifactId: string }[] }>;
    expect(
      workbench(run.state)
        .artifacts.map((a) => a.artifactId)
        .sort(),
    ).toEqual(
      [
        ...new Set(
          Object.values(outputs).flatMap((o) => (o.artifacts ?? []).map((a) => a.artifactId)),
        ),
      ].sort(),
    );
  });

  it('only emits legal task transitions and gap-free seqs', () => {
    run.events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    for (const e of run.events) {
      if (e.type === 'task.state') expect(canTransition(e.data.from, e.data.to)).toBe(true);
    }
    // Hero goes through two retries, then a Decision that expires to its default.
    const hero = run.events.filter((e) => e.type === 'task.state' && e.data.taskId === 'port-hero');
    expect(hero.some((e) => e.type === 'task.state' && e.data.attempt === 3)).toBe(true);
    const expired = run.events.filter(
      (e) => e.type === 'escalation.updated' && e.data.status === 'expired',
    );
    expect(expired.length).toBeGreaterThan(0);
    // An agent does one task at a time: once it moves on, it doesn't come back to a task.
    const turns = new Map<string, string[]>();
    for (const s of stepsOf(run)) {
      const tasks = turns.get(s.data.agentId) ?? [];
      if (tasks.at(-1) !== s.data.taskId) tasks.push(s.data.taskId);
      turns.set(s.data.agentId, tasks);
    }
    for (const [agent, tasks] of turns) expect(new Set(tasks).size, agent).toBe(tasks.length);
  });

  it("plans the playbook's own tasks: the compiled plan's ids, roles, titles and phases", async () => {
    // The site it builds is the playbook's example Blueprint.
    const example = Blueprint.parse(
      parse(await readFile(`${PLAYBOOK}/fixtures/blueprint.example.yaml`, 'utf8')),
    );
    const site = Blueprint.parse({ version: 1, collections: OPTIMIZELY_SITE });
    // Item for item, by key, name, status and pilot. The example also carries each item's model
    // contract (attrs) and the 404 page it records as dropped, which the simulation doesn't
    // narrate: nothing is built for either.
    const built = (collections: Blueprint['collections']) =>
      Object.fromEntries(
        Object.entries(collections).map(([name, items]) => [
          name,
          items
            .filter((i) => i.status !== 'drop')
            .map(({ key, name: itemName, status, pilot }) => ({
              key,
              name: itemName,
              status,
              pilot,
            })),
        ]),
      );
    expect(built(site.collections)).toEqual(built(example.collections));

    // A project with a source repository and no Experimentation licence.
    const compiled = compilePlan(run.playbook, example, { features: ['source-repo'] });
    const work = compiled.tasks.filter((t) => t.kind === 'work');
    const simulated = plan(run.state).tasks;
    expect(simulated.map((t) => t.taskId).sort()).toEqual(work.map((t) => t.taskId).sort());
    const byId = new Map(compiled.tasks.map((t) => [t.taskId, t]));
    /** Everything a task waits on in the real plan, through approvals and the pilot checkpoint. */
    const upstream = (id: string, seen = new Set<string>()) => {
      for (const d of byId.get(id)!.dependsOn)
        if (!seen.has(d)) {
          seen.add(d);
          upstream(d, seen);
        }
      return seen;
    };
    for (const t of simulated) {
      const real = byId.get(t.taskId)!;
      expect(
        { role: t.role, title: t.title, phase: t.phase, workstream: t.workstream },
        t.taskId,
      ).toEqual({
        role: real.role,
        title: real.title,
        phase: real.phase,
        workstream: real.workstream,
      });
      const waitsOn = upstream(t.taskId);
      for (const d of t.dependsOn) expect(waitsOn.has(d), `${t.taskId} waits on ${d}`).toBe(true);
    }
    // And each task is done by the role the plan gives it.
    for (const s of stepsOf(run))
      expect(s.data.agentId, s.data.taskId).toBe(byId.get(s.data.taskId)!.role);
  });

  it('calls only what its role is granted, in the platform’s own words', () => {
    const roles = new Map(run.playbook.roles.map((r) => [r.role, r]));
    const refused = stepsOf(run)
      // `model` is the agent's own thinking, not a tool server.
      .filter((s) => s.data.toolServer !== 'model')
      .filter(
        (s) => !roles.get(s.data.agentId)?.tools[s.data.toolServer]?.ops.includes(s.data.operation),
      )
      .map((s) => `${s.data.agentId}: ${s.data.toolServer}.${s.data.operation}`);
    expect([...new Set(refused)]).toEqual([]);
    const servers = new Set(stepsOf(run).map((s) => s.data.toolServer));
    expect(servers).toContain('optimizely-cms');
    expect(servers).toContain('optimizely-graph');
    // Activity names them as the playbook does.
    expect(run.state.toolLabels).toMatchObject({
      'optimizely-cms': 'CMS REST API',
      'optimizely-graph': 'Optimizely Graph',
    });
    for (const command of ['push-dry-run', 'push'])
      at(run, 'sandbox', 'exec.optimizely-cli', new RegExp(`^${command}: `));

    // Nothing the Director reads names another platform.
    const said = run.events.flatMap((e) =>
      e.type === 'step.recorded'
        ? [e.data.summary]
        : e.type === 'cos.message'
          ? [e.data.title ?? '', e.data.body]
          : e.type === 'escalation.raised'
            ? [e.data.title, e.data.context, e.data.impact, ...e.data.options.map((o) => o.label)]
            : e.type === 'task.planned'
              ? [e.data.title]
              : e.type === 'agent.state'
                ? [e.data.now ?? '']
                : [],
    );
    const foreign = /sitecore|page builder|experience edge|\brenderings?\b|datasource|content sdk/i;
    expect(said.filter((text) => foreign.test(text))).toEqual([]);
    expect(said.join('\n')).toMatch(/Visual Builder/);
  });

  it('follows the order the platform sets: content types, the application, then content published as written', () => {
    // Content types are pushed first, the page types among them.
    const firstPush = at(run, 'sandbox', 'exec.optimizely-cli', /^push: /);
    const startPageType = at(run, 'sandbox', 'exec.optimizely-cli', /^push: GlobexHomePage /);
    // Then the application, on a start page of a type already pushed, with its hosts and preview.
    const application = at(run, 'optimizely-cms', 'application.create', /GlobexHomePage, draft/);
    const primary = at(run, 'optimizely-cms', 'hostname.add', /primary host of Globex_Website/);
    const preview = at(run, 'optimizely-cms', 'hostname.add', /preview host of Globex_Website/);
    const livePreview = at(run, 'optimizely-cms', 'preview.configure');
    expect([firstPush, startPageType, application, primary, preview, livePreview]).toEqual(
      [firstPush, startPageType, application, primary, preview, livePreview].sort((a, b) => a - b),
    );
    // Nothing is written to the CMS as content before the application exists.
    const writes = ['content.create', 'content.update', 'composition.write', 'content.publish'];
    const firstWrite = run.events.findIndex(
      (e) => e.type === 'step.recorded' && writes.includes(e.data.operation),
    );
    expect(firstWrite).toBeGreaterThan(livePreview);
    // The pilot is published and read back from Graph before the shell and the pages.
    const pilot = at(run, 'optimizely-graph', 'graph.item', /in Graph: Published/);
    const shell = at(run, 'optimizely-cms', 'content.create', /\/shared\/Globex_Website\//);
    const pages = at(run, 'optimizely-cms', 'content.create', /\/content\/Globex_Website\//);
    expect(pilot).toBeLessThan(shell);
    expect(shell).toBeLessThan(pages);

    // Every page is composed and published in its own task: the head shows published content.
    for (const page of OPTIMIZELY_SITE.pages) {
      const ops = stepsOf(run)
        .filter((s) => s.data.taskId === `migrate-pages-${page.key}`)
        .map((s) => s.data.operation);
      expect(ops.slice(-2), page.key).toEqual(['composition.write', 'content.publish']);
    }
    // Every path is inside the project's own application.
    const paths = stepsOf(run).flatMap(
      (s) => s.data.summary.match(/\/(content|shared|media)\/[A-Za-z0-9_]+/g) ?? [],
    );
    expect(new Set(paths)).toEqual(
      new Set(['/content/Globex_Website', '/shared/Globex_Website', '/media/Globex_Website']),
    );
  });

  it('asks the Director what only they can do: two steps by hand, a Blocker and the two gates', () => {
    const noDefault = run.events
      .filter((e) => e.type === 'escalation.raised')
      .filter((e) => e.type === 'escalation.raised' && !e.data.defaultOptionId)
      .map((e) => (e.type === 'escalation.raised' ? `${e.data.type}: ${e.data.title}` : ''));
    expect(noDefault).toEqual([
      'decision: By hand: Give the API key content rights in the CMS',
      'gate: Approve Implementation Blueprint v1',
      'blocker: Blueprint creation 403',
      'decision: By hand: Smoke test Visual Builder on production',
      'gate: Accept the implementation',
    ]);
    // The checklist of a step by hand is the plan's own.
    const rights = run.events.find(
      (e) => e.type === 'escalation.raised' && e.data.sourceTaskId === 'confirm-content-rights',
    );
    expect(rights?.type === 'escalation.raised' && rights.data.context).toContain(
      'Set Access Rights',
    );
  });
});

describe('a simulated Optimizely project that waits for its Director', () => {
  it('holds phase 0 until the content rights are confirmed by hand', async () => {
    const store = new InMemoryEventStore();
    const projections = new Projections(store);
    await projections.start();
    const sim = new Simulation(store, await loadPlaybook(PLAYBOOK), {
      projectId: 'p2',
      name: 'Globex website',
      client: 'Globex',
      speed: 200_000,
    });
    const running = sim.run(optimizelyScenario);
    const until = async (fn: () => boolean) => {
      const end = Date.now() + 5000;
      while (!fn()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    const state = () => projections.get('p2');
    await until(() => state()?.tasks['verify-access']?.state === 'done');
    // The probe is done; the phase still waits on the Director's own step.
    await new Promise((r) => setTimeout(r, 50));
    expect(state()!.tasks['confirm-content-rights']!.state).toBe('blocked');
    expect(missionControl(state()!).phases[0]!.status).toBe('current');
    const card = Object.values(state()!.escalations).find(
      (x) => x.sourceTaskId === 'confirm-content-rights',
    )!;
    expect(card).toMatchObject({ status: 'open', type: 'decision', defaultOptionId: null });
    await sim.resolve(card.escalationId, 'accept', 'director', 'The key is listed on the Root');
    // Marked done, the engagement goes on to the next thing that is the Director's: Gate 1.
    await until(() =>
      Object.values(state()!.escalations).some((x) => x.type === 'gate' && x.status === 'open'),
    );
    expect(state()!.tasks['confirm-content-rights']!.state).toBe('done');
    expect(missionControl(state()!).phases[0]!.status).toBe('done');
    sim.stop();
    await running;
  }, 30_000);
});

describe('scenarios by playbook', () => {
  it('gives each simulated project the scenario of the playbook it runs', async () => {
    expect(scenarioFor(await loadPlaybook(dir('sitecoreai-migration')))).toBe(sitecoreScenario);
    expect(scenarioFor(await loadPlaybook(PLAYBOOK))).toBe(optimizelyScenario);
    // A playbook without a scripted engagement has none, rather than another playbook's.
    expect(scenarioFor(await loadPlaybook(dir('optimizely-homepage-demo')))).toBeUndefined();
    expect(scenarioFor(await loadPlaybook(dir('optimizely-customer-portal')))).toBeUndefined();
    expect(scenarioFor(await loadPlaybook(dir('sitecoreai-homepage-demo')))).toBeUndefined();
  });

  it('stops with the reason when a scenario is played on another playbook', async () => {
    const sim = new Simulation(
      new InMemoryEventStore(),
      await loadPlaybook(dir('sitecoreai-migration')),
      { projectId: 'p3', name: 'Acme corporate site', client: 'Acme', speed: 200_000 },
    );
    await expect(sim.run(optimizelyScenario)).rejects.toThrow(
      'confirm-content-rights is not in the plan of sitecoreai-migration',
    );
    sim.stop();
  });
});
