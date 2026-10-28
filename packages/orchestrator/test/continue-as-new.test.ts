import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { missionControl, plan } from '@lw/domain';
import {
  assertLegalLog,
  directorBot,
  launch,
  openEscalations,
  startHarness,
  stopHarness,
  until,
  type Harness,
} from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

/** The run the project's workflow is on now. */
const currentRun = async (p: Awaited<ReturnType<typeof launch>>) =>
  (await p.handle.describe()).runId;

describe('continue-as-new', () => {
  it('runs an engagement to the end across several runs', async () => {
    const p = await launch(h, {
      policy: { continueAsNewAt: 150 },
      script: { rejectTimes: { 'port-header': 3 }, accessDenied: ['upload-media-media-2'] },
    });
    const bot = directorBot(p);
    await p.handle.result();
    await bot.stop();

    expect(await currentRun(p)).not.toBe(p.handle.firstExecutionRunId);
    const s = p.state()!;
    expect(missionControl(s).project.status).toBe('completed');
    const tasks = plan(s).tasks;
    expect(tasks.every((t) => t.state === 'done')).toBe(true);
    // Attempts and the Lead's rejections carry over between runs.
    expect(tasks.find((t) => t.taskId === 'port-header')!.attempt).toBe(4);
    expect(missionControl(s).metrics.find((m) => m.key === 'pages_migrated')).toMatchObject({
      value: 10,
      total: 10,
    });
    const events = await h.store.read(p.projectId);
    assertLegalLog(events);
    // The project is announced once, not once per run.
    expect(events.filter((e) => e.type === 'project.created')).toHaveLength(1);
    expect(
      events.filter((e) => e.type === 'artifact.versioned' && e.data.artifactId === 'blueprint'),
    ).toHaveLength(1);
  }, 180_000);

  it('carries an open card to the next run, which takes its answer', async () => {
    const p = await launch(h, { policy: { continueAsNewAt: 150 } });
    const gate1 = await until(() => openEscalations(p.state()).find((x) => x.type === 'gate'));
    // Nothing runs while the gate waits, so the run hands over with the card open.
    const firstRun = p.handle.firstExecutionRunId;
    for (let i = 0; (await currentRun(p)) === firstRun; i++) {
      if (i > 300) throw new Error('the run never handed over');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(openEscalations(p.state()).map((x) => x.escalationId)).toContain(gate1.escalationId);

    await p.commands.resolve(gate1.escalationId, 'approve');
    await until(() => p.state()!.phases[3]!.status === 'current', 30_000);
    await p.handle.terminate();
  }, 90_000);
});
