import { fileURLToPath } from 'node:url';
import {
  PlaybookScorecard,
  PortfolioDiagnostics,
  PortfolioItem,
  Scorecard,
  RuleDraftView,
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

async function start(
  heartbeat?: () => Promise<WorkerHeartbeat | null>,
  ruleDrafter?: Parameters<typeof buildApp>[0]['ruleDrafter'],
  operatorTestEmail?: Parameters<typeof buildApp>[0]['operatorTestEmail'],
  triageReplay?: Parameters<typeof buildApp>[0]['triageReplay'],
) {
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
    ruleDrafter,
    operatorTestEmail,
    triageReplay,
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
    operator: { emailTo: 1, emailFrom: 'Operator <ops@example.com>', webhook: false },
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
  expect(by.operator).toMatchObject({
    status: 'ok',
    detail:
      "In the project's conversation, and by email to 1 recipient from Operator <ops@example.com>",
  });
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
  // An older worker that doesn't report it: no row, rather than a wrong one.
  expect(s.services.find((x) => x.key === 'operator')).toBeUndefined();

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

it('drafts a rule from an answered card, with the scopes it could have and its evidence', async () => {
  const app = await start(undefined, async (input) => ({
    when: `the agent asks "${input.card.title}" again`,
    then: `answer: ${input.answer}`,
  }));
  const decisions = (await app.inject({ method: 'GET', url: '/projects/p1/decisions' })).json() as {
    escalationId: string | null;
    scopeKey: string;
    answer: string;
  }[];
  const answered = decisions.find((d) => d.escalationId && !d.scopeKey.startsWith('gate:'))!;
  const gate = decisions.find((d) => d.escalationId && d.scopeKey.startsWith('gate:'));
  const r = await app.inject({
    method: 'POST',
    url: `/projects/p1/escalations/${answered.escalationId}/rule-draft`,
  });
  expect(r.statusCode).toBe(200);
  const draft = RuleDraftView.parse(r.json());
  expect(draft).toMatchObject({
    draftedBy: 'cypher',
    then: `answer: ${answered.answer}`,
    sources: [
      expect.objectContaining({ escalationId: answered.escalationId, answer: answered.answer }),
    ],
  });
  expect(draft.when).toMatch(/^the agent asks/);
  expect(draft.scopes.map((x) => x.kind)).toEqual(['project', 'playbook']);
  if (gate) {
    const g = await app.inject({
      method: 'POST',
      url: `/projects/p1/escalations/${gate.escalationId}/rule-draft`,
    });
    expect(g.statusCode).toBe(409);
  }
  expect(
    (await app.inject({ method: 'POST', url: '/projects/p1/escalations/nope/rule-draft' }))
      .statusCode,
  ).toBe(404);
});

it('takes a capability gap key as long as the capability is written out', async () => {
  const app = await start();
  const key = encodeURIComponent(
    "read items under /sitecore/media library/project/brands/lambert-cable (to get the logo's media id) so logo can be set on site header and site footer",
  );
  const r = await app.inject({
    method: 'POST',
    url: `/projects/p1/capability-gaps/${key}/close`,
    payload: {},
  });
  // Not 414: the route is reached and answers for the gap itself.
  expect(r.statusCode).toBe(404);
  expect(r.json()).toMatchObject({ error: { code: 'not_found' } });
});

it("sends a test of the Operator's email, and says why when it can't", async () => {
  const off = await start();
  const r = await off.inject({ method: 'POST', url: '/projects/p1/operator/test-email' });
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toBe('email_not_configured');

  const sent: { title: string; needs: number; test: boolean }[] = [];
  const on = await start(undefined, undefined, async (n, opts) => {
    sent.push({ title: n.title, needs: n.needs?.length ?? 0, test: opts.test });
    return { id: 'em_1' };
  });
  const ok = await on.inject({ method: 'POST', url: '/projects/p1/operator/test-email' });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual({ sent: true, id: 'em_1' });
  expect(sent).toEqual([{ title: 'The Operator can reach you', needs: 0, test: true }]);

  const refused = await start(undefined, undefined, async () => {
    throw new Error('Resend refused the email (403): The example.com domain is not verified.');
  });
  const no = await refused.inject({ method: 'POST', url: '/projects/p1/operator/test-email' });
  expect(no.statusCode).toBe(502);
  expect(no.json().message).toContain('domain is not verified');
  expect(
    (await refused.inject({ method: 'POST', url: '/projects/nope/operator/test-email' }))
      .statusCode,
  ).toBe(404);
});

it("replays a project's answered cards in batches, and says when it can't", async () => {
  const off = await start();
  expect((await off.inject({ method: 'POST', url: '/projects/p1/triage/replay' })).statusCode).toBe(
    409,
  );

  const runs: { limit: number; fresh?: boolean }[] = [];
  const on = await start(undefined, undefined, undefined, {
    run: async (_id, opts) => {
      runs.push(opts);
      return { replayed: [], remaining: 0, summary: { cases: 0 } };
    },
    results: async () => ({ cases: [], summary: { cases: 0 } }),
  });
  const r = await on.inject({
    method: 'POST',
    url: '/projects/p1/triage/replay',
    payload: { limit: 500, fresh: true },
  });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ replayed: [], remaining: 0, summary: { cases: 0 } });
  await on.inject({ method: 'POST', url: '/projects/p1/triage/replay' });
  expect(runs).toEqual([
    { limit: 25, fresh: true },
    { limit: 8, fresh: false },
  ]);
  expect((await on.inject({ method: 'GET', url: '/projects/p1/triage/replay' })).json()).toEqual({
    cases: [],
    summary: { cases: 0 },
  });
  expect((await on.inject({ method: 'GET', url: '/projects/nope/triage/replay' })).statusCode).toBe(
    404,
  );
});
