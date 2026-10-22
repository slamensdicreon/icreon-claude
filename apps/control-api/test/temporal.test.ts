import { fileURLToPath } from 'node:url';
import { MissionControlSnapshot } from '@lw/contracts';
import { InMemoryEventStore, Projections } from '@lw/events';
import {
  createStubActivities,
  createWorker,
  defaultPolicy,
  loadFixtures,
  ProjectCommandsClient,
  startProject,
} from '@lw/orchestrator';
import { loadPlaybook } from '@lw/playbook-sdk';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const NAME = 'Acme corporate site';

let env: TestWorkflowEnvironment;
let app: FastifyInstance;
let stopWorker: () => Promise<void>;
let projections: Projections;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  const store = new InMemoryEventStore();
  projections = new Projections(store);
  await projections.start();
  const playbook = await loadPlaybook(PLAYBOOK);
  const { blueprint, outputs } = await loadFixtures(PLAYBOOK);
  const worker = await createWorker({
    connection: env.nativeConnection,
    taskQueue: 'api-test',
    activities: createStubActivities({ store, playbook, blueprint, outputs }),
  });
  const run = worker.run();
  stopWorker = async () => {
    worker.shutdown();
    await run;
  };
  app = await buildApp({
    store,
    projections,
    commands: (id) => (projections.get(id) ? new ProjectCommandsClient(env.client, id) : undefined),
  });
  await startProject(
    env.client,
    {
      projectId: 'p1',
      name: NAME,
      client: 'Acme Corp',
      playbook,
      policy: defaultPolicy(playbook, { budgets: { tokens: 1e9, usd: 1e6, hours: 1e6 } }),
    },
    'api-test',
  );
  while (!projections.get('p1')) await new Promise((r) => setTimeout(r, 10));
}, 120_000);

afterAll(async () => {
  await app.close();
  await stopWorker();
  await env.teardown();
});

const mc = async () =>
  MissionControlSnapshot.parse((await app.inject({ url: '/projects/p1/mission-control' })).json());

async function openGate() {
  for (let i = 0; i < 2000; i++) {
    const s = projections.get('p1');
    const gate = Object.values(s?.escalations ?? {}).find(
      (x) => x.type === 'gate' && x.status === 'open',
    );
    if (gate) return gate;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no gate');
}

describe('control-api on the Temporal orchestrator', () => {
  it('answers workflow refusals with the right status and the workflow’s own words', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/projects/p1/escalations/esc-nope/resolve',
      payload: { optionId: 'x' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({
      code: 'not_found',
      message: 'No escalation "esc-nope".',
    });

    const noProject = await app.inject({
      method: 'POST',
      url: '/projects/nope/messages',
      payload: { body: 'hi' },
    });
    expect(noProject.statusCode).toBe(404);
  }, 60_000);

  it('approves Gate 1 over HTTP; the next snapshot already reflects it', async () => {
    const gate = await openGate();
    const r = await app.inject({
      method: 'POST',
      url: `/projects/p1/gates/${gate.escalationId}/approve`,
      payload: {},
    });
    expect(r.statusCode).toBe(200);
    const { seq } = r.json();
    const snap = await mc();
    expect(snap.seq).toBeGreaterThanOrEqual(seq);
    expect(snap.waitingOnYou.find((x) => x.escalationId === gate.escalationId)).toBeUndefined();
    expect(snap.metrics.find((m) => m.key === 'components_registered')?.total).toBe(16);
  }, 60_000);

  it('pauses with a 200, refuses a second pause with a 409', async () => {
    const pause = { verb: 'pause', scope: { kind: 'project', id: 'p1' } };
    expect(
      (await app.inject({ method: 'POST', url: '/projects/p1/control', payload: pause }))
        .statusCode,
    ).toBe(200);
    expect((await mc()).project.status).toBe('paused');
    const again = await app.inject({ method: 'POST', url: '/projects/p1/control', payload: pause });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toBe('The project is already paused.');
  }, 60_000);
});
