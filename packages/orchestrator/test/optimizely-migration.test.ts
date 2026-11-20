import { fileURLToPath } from 'node:url';
import { missionControl, plan } from '@lw/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertLegalLog,
  directorBot,
  launch,
  SMALL_BLUEPRINT,
  startHarness,
  stopHarness,
  type Harness,
} from './harness';

const DIR = fileURLToPath(new URL('../../../playbooks/optimizely-saas-migration', import.meta.url));

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ playbookDir: DIR });
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

const releases = (s: NonNullable<ReturnType<Awaited<ReturnType<typeof launch>>['state']>>) =>
  Object.values(s.escalations)
    .filter((x) => x.title.startsWith('Approve release: '))
    .map((x) => x.title.slice('Approve release: '.length));

describe('Optimizely website playbook', () => {
  it('runs a whole project: content types, then the application, the pilot, and content published as it is built', async () => {
    const p = await launch(h, { blueprint: SMALL_BLUEPRINT });
    const bot = directorBot(p);
    await p.handle.result();
    await bot.stop();

    const s = p.state()!;
    const mc = missionControl(s);
    expect(mc.project.status).toBe('completed');
    expect(mc.phases.every((ph) => ph.status === 'done')).toBe(true);
    const tasks = plan(s).tasks;
    expect(tasks.every((t) => t.state === 'done')).toBe(true);
    expect(mc.metrics.find((m) => m.key === 'components_registered')).toMatchObject({
      value: 5,
      total: 5,
    });
    expect(mc.metrics.find((m) => m.key === 'pages_migrated')).toMatchObject({
      value: 10,
      total: 10,
    });

    // On a client's instance every release asks, in the order the platform sets: the head, the
    // application (after the page types), the pilot's publish, the shell, each page, then the
    // final code and content releases.
    const asked = releases(s);
    expect(asked.slice(0, 4)).toEqual([
      'Deploy the head to Vercel',
      'Create the application, with its hosts and live preview',
      'Compose the pilot experience and publish it',
      'Create the shared header, footer and site settings content',
    ]);
    expect(asked.filter((t) => t.startsWith('Migrate '))).toHaveLength(10);
    expect(asked.slice(-2)).toEqual([
      'Deploy the reviewed commit to the editing and delivery hosts',
      'Publish the final versions and verify every route in Graph',
    ]);
    // By hand: the API key's content rights before Gate 1, Visual Builder at the end.
    const byHand = Object.values(s.escalations)
      .filter((x) => x.title.startsWith('By hand: '))
      .map((x) => x.sourceTaskId);
    expect(byHand).toEqual(['confirm-content-rights', 'smoke-test']);
    assertLegalLog(await h.store.read(p.projectId));
  }, 120_000);

  it('asks once for the pages when the Director approves that step in advance', async () => {
    const p = await launch(h, {
      blueprint: SMALL_BLUEPRINT,
      standingApproval: async ({ release }) => release === 'migrate-pages-{key}',
    });
    const bot = directorBot(p);
    await p.handle.result();
    await bot.stop();

    const s = p.state()!;
    expect(plan(s).tasks.every((t) => t.state === 'done')).toBe(true);
    expect(releases(s).filter((t) => t.startsWith('Migrate '))).toEqual([]);
    expect(s.decisions.filter((d) => d.answer === 'Approved in advance')).toHaveLength(10);
    // Every other release still comes to the Director.
    expect(releases(s)).toHaveLength(6);
  }, 120_000);
});
