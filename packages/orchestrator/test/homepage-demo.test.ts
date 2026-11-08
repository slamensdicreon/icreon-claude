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

const DEMO = fileURLToPath(new URL('../../../playbooks/sitecoreai-homepage-demo', import.meta.url));

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ playbookDir: DEMO });
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

describe('homepage demo', () => {
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
    // Only the slice is built: 7 components, the homepage (no 404 page from 0.2.4), 3 media.
    expect(mc.metrics.find((m) => m.key === 'components_registered')).toMatchObject({
      value: 7,
      total: 7,
    });
    expect(mc.metrics.find((m) => m.key === 'pages_migrated')).toMatchObject({
      value: 1,
      total: 1,
    });
    expect(tasks.map((t) => t.taskId)).not.toContain('migrate-pages-about');
    expect(tasks.map((t) => t.taskId)).toEqual(
      expect.arrayContaining(['audit-parity', 'deploy-code', 'publish-edge']),
    );

    // The Director's cards: Gate 1, the drag-and-drop check by hand, and Gate 2. Deploy and
    // publish are standing approvals: always our demo tenant.
    const cards = Object.values(s.escalations);
    expect(cards.filter((x) => x.type === 'gate')).toHaveLength(2);
    expect(cards.find((x) => x.sourceTaskId === 'drag-and-drop-check')).toBeDefined();
    expect(cards.some((x) => /release/i.test(x.title))).toBe(false);
    assertLegalLog(await h.store.read(p.projectId));
  }, 60_000);
});
