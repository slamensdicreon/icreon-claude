import { fileURLToPath } from 'node:url';
import { missionControl, plan, type ProjectState } from '@lw/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixtures } from '../src';
import {
  assertLegalLog,
  directorBot,
  launch,
  startHarness,
  stopHarness,
  type Harness,
} from './harness';

const PORTAL = fileURLToPath(
  new URL('../../../playbooks/optimizely-customer-portal', import.meta.url),
);

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ playbookDir: PORTAL });
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

const releases = (s: ProjectState) =>
  Object.values(s.escalations)
    .filter((x) => x.title.startsWith('Approve release: '))
    .map((x) => x.title.slice('Approve release: '.length));
const byHand = (s: ProjectState) =>
  Object.values(s.escalations)
    .filter((x) => x.title.startsWith('By hand: '))
    .map((x) => x.sourceTaskId);

describe('customer portal on Optimizely', () => {
  it('runs a whole project: the shell, the pilot behind the sign-in, pages published as composed, each persona walked', async () => {
    const { blueprint } = await loadFixtures(PORTAL);
    // A prototype with a repository, and a brief that asks for content by role.
    const p = await launch(h, {
      blueprint,
      policy: { features: ['source-repo', 'personalization'] },
    });
    const bot = directorBot(p);
    await p.handle.result();
    await bot.stop();

    const s = p.state()!;
    const mc = missionControl(s);
    expect(mc.project.status).toBe('completed');
    expect(mc.phases).toHaveLength(8);
    expect(mc.phases.every((ph) => ph.status === 'done')).toBe(true);

    const tasks = plan(s).tasks;
    expect(tasks.every((t) => t.state === 'done')).toBe(true);
    // The example portal: 8 components, 5 pages (the sign-in screen among them), 2 media.
    expect(mc.metrics.find((m) => m.key === 'components_registered')).toMatchObject({
      value: 8,
      total: 8,
    });
    expect(mc.metrics.find((m) => m.key === 'pages_migrated')).toMatchObject({
      value: 5,
      total: 5,
    });
    expect(mc.metrics.find((m) => m.key === 'media_uploaded')).toMatchObject({
      value: 2,
      total: 2,
    });
    const ids = tasks.map((t) => t.taskId);
    expect(ids).toEqual(
      expect.arrayContaining([
        'inventory-prototype',
        'portal-shell',
        'define-type-portal-page',
        'provision-application',
        'compose-pilot',
        'prove-pilot-slice',
        'pilot-checkpoint',
        'compose-sign-in',
        'role-content',
        'replay-model',
        'deploy-code',
        'publish-site',
        'handover-pack',
      ]),
    );
    expect(ids).not.toContain('inventory-prototype-live');

    // The Director's cards. The two gates (the pilot's review is off unless switched on).
    const cards = Object.values(s.escalations);
    expect(
      cards.filter((x) => x.type === 'gate' && !x.title.startsWith('Approve release: ')),
    ).toHaveLength(2);
    // Three releases ask: the application (the first write on the instance), then code and
    // content in phase 6. The head's first deployment and every page's publish are approved
    // once, in the playbook: the portal's own application and the project's own hosts.
    expect(releases(s)).toEqual([
      "Create the portal's application, with its hosts and live preview",
      'Deploy the reviewed commit to production and the editing address',
      'Publish the final versions and verify the portal on production',
    ]);
    // By hand: the API key's content rights before Gate 1, each persona's walk, then the UAT in
    // Visual Builder. Content by role needs no step by hand on this platform.
    expect(byHand(s)).toEqual([
      'confirm-content-rights',
      'walk-business-manager',
      'walk-finance-contact',
      'director-uat',
    ]);
    assertLegalLog(await h.store.read(p.projectId));
  }, 120_000);

  it('leaves out the role content proof when the brief says content does not change by role', async () => {
    const { blueprint } = await loadFixtures(PORTAL);
    const p = await launch(h, { blueprint });
    const bot = directorBot(p);
    await p.handle.result();
    await bot.stop();

    const s = p.state()!;
    const tasks = plan(s).tasks;
    expect(tasks.every((t) => t.state === 'done')).toBe(true);
    const ids = tasks.map((t) => t.taskId);
    expect(ids).not.toContain('role-content');
    // No repository given: the running prototype is the source.
    expect(ids).toContain('inventory-prototype-live');
    expect(ids).not.toContain('inventory-prototype');
    expect(byHand(s)).toEqual([
      'confirm-content-rights',
      'walk-business-manager',
      'walk-finance-contact',
      'director-uat',
    ]);
  }, 120_000);
});
