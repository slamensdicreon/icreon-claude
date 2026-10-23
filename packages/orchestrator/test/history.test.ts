import { plan } from '@lw/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { loadFixtures } from '../src';
import {
  assertLegalLog,
  directorBot,
  launch,
  PLAYBOOK_DIR,
  startHarness,
  stopHarness,
  type Harness,
} from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

/**
 * Temporal caps a workflow's history (50,000 events; it warns at 10,000). Pages and media run as
 * batches, one child per agent session, so the parent grows per session, not per page.
 */
it('keeps the project workflow history small on a full-size example site', async () => {
  const { blueprint } = await loadFixtures(PLAYBOOK_DIR);
  const p = await launch(h, { blueprint });
  const bot = directorBot(p);
  await p.handle.result();
  await bot.stop();

  const tasks = plan(p.state()!).tasks;
  expect(tasks).toHaveLength(235);
  expect(tasks.every((t) => t.state === 'done')).toBe(true);
  const { historyLength } = await p.handle.describe();
  // Measured: about 2,200 events (≈10 per task) against about 6,000 before batching.
  expect(historyLength).toBeLessThan(3_000);
  assertLegalLog(await h.store.read(p.projectId));
  console.log(`history: ${historyLength} events for ${tasks.length} tasks`);
}, 300_000);
