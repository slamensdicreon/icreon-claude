import { fileURLToPath } from 'node:url';
import { missionControl, plan } from '@lw/domain';
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

const DEMO = fileURLToPath(new URL('../../../playbooks/optimizely-homepage-demo', import.meta.url));

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ playbookDir: DEMO });
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

describe('homepage demo on Optimizely', () => {
  it('audits the whole site, builds only the slice through deploy, and closes at Gate 2', async () => {
    const { blueprint } = await loadFixtures(DEMO);
    const p = await launch(h, { blueprint });
    const bot = directorBot(p);
    await p.handle.result();
    await bot.stop();

    const s = p.state()!;
    const mc = missionControl(s);
    expect(mc.project.status).toBe('completed');
    expect(mc.phases.every((ph) => ph.status === 'done')).toBe(true);

    const tasks = plan(s).tasks;
    expect(tasks.every((t) => t.state === 'done')).toBe(true);
    // Only the slice is built: 11 components, the homepage, 5 media.
    expect(mc.metrics.find((m) => m.key === 'components_registered')).toMatchObject({
      value: 11,
      total: 11,
    });
    expect(mc.metrics.find((m) => m.key === 'pages_migrated')).toMatchObject({
      value: 1,
      total: 1,
    });
    expect(tasks.map((t) => t.taskId)).toEqual(
      expect.arrayContaining([
        'provision-application',
        'migrate-shared-chrome',
        'audit-parity',
        'replay-model',
        'deploy-code',
        'publish-site',
      ]),
    );

    // The Director's cards: Gate 1 and Gate 2, and the two steps by hand (the API key's content
    // rights before Gate 1, the Visual Builder check before Gate 2). Every release is a standing
    // approval: always our demo instance and the demo's own application.
    const cards = Object.values(s.escalations);
    expect(cards.filter((x) => x.type === 'gate')).toHaveLength(2);
    expect(cards.find((x) => x.sourceTaskId === 'confirm-content-rights')).toBeDefined();
    expect(cards.find((x) => x.sourceTaskId === 'visual-builder-check')).toBeDefined();
    expect(cards.some((x) => /release/i.test(x.title))).toBe(false);
    assertLegalLog(await h.store.read(p.projectId));
  }, 60_000);
});
