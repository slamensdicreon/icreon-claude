import type { RunRequest } from '@lw/agent-runtime';
import { missionControl, plan } from '@lw/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const gate1 = (p: Awaited<ReturnType<typeof launch>>) =>
  until(() => openEscalations(p.state()).find((x) => x.type === 'gate'));

describe('undo', () => {
  it('holds a send-back for the undo window; Undo re-opens the gate with nothing changed', async () => {
    const p = await launch(h, { policy: { undoWindowMs: 1_500 } });
    const g = await gate1(p);
    await p.commands.resolve(g.escalationId, 'send_back', 'Split Header and Navigation');
    const pending = p.state()!.escalations[g.escalationId]!;
    expect(pending).toMatchObject({ status: 'resolved', resolution: { optionId: 'send_back' } });
    expect(pending.undoUntil).not.toBeNull();
    const decisionsBefore = p.state()!.decisions.length;

    await p.commands.undo(g.escalationId);
    const reopened = p.state()!.escalations[g.escalationId]!;
    expect(reopened).toMatchObject({
      status: 'open',
      resolution: null,
      undoUntil: null,
      resolvedAt: null,
    });
    await expect(p.commands.undo(g.escalationId)).rejects.toMatchObject({ status: 409 });
    await new Promise((r) => setTimeout(r, 2_000));
    expect(p.state()!.decisions).toHaveLength(decisionsBefore);
    expect(p.state()!.tasks['draft-blueprint']!.state).toBe('done');

    // Without Undo, the send-back takes effect after the window: the Blueprint is redone.
    await p.commands.resolve(g.escalationId, 'send_back', 'Split Header and Navigation');
    await until(() => openEscalations(p.state()).find((x) => x.gate?.artifactVersion === 2));
    expect(p.state()!.decisions.at(-1)).toMatchObject({
      answer: 'Send back with notes',
      decidedBy: 'director',
    });

    // Approving a gate is not reversible, so it has no undo window.
    const g2 = openEscalations(p.state()).find((x) => x.gate?.artifactVersion === 2)!;
    await p.commands.resolve(g2.escalationId, 'approve');
    expect(p.state()!.escalations[g2.escalationId]!.undoUntil).toBeNull();
    await expect(p.commands.undo(g2.escalationId)).rejects.toMatchObject({
      status: 409,
      message: 'This choice can no longer be undone.',
    });
    await p.handle.terminate();
  }, 60_000);
});

describe('pause and cancel below the project', () => {
  it('holds one phase while its sibling runs, and shows the hold', async () => {
    const p = await launch(h);
    const g = await gate1(p);
    // The Director approves releases (phase 3's hosting) as they come; the test answers the rest.
    const bot = directorBot(p, (x) => (x.title.startsWith('Approve release') ? null : 'leave'));
    const project = { kind: 'project' as const, id: p.projectId };
    await p.commands.control({ verb: 'pause', scope: project });
    await p.commands.resolve(g.escalationId, 'approve');
    // Phase 5's designs wait on phase 4's renderings, so phase 5 is the one held.
    await p.commands.control({ verb: 'pause', scope: { kind: 'phase', id: '5' } });
    await expect(
      p.commands.control({ verb: 'pause', scope: { kind: 'phase', id: '5' } }),
    ).rejects.toMatchObject({ status: 409 });
    await p.commands.control({ verb: 'resume', scope: project });

    await until(() => p.state()!.phases[4]!.status === 'done', 30_000);
    const s = p.state()!;
    expect(missionControl(s).project.holds).toEqual([
      { kind: 'phase', id: '5', label: 'Phase 5: Templates, layouts, and designs' },
    ]);
    expect(plan(s).tasks.filter((t) => t.phase === 5 && t.state !== 'planned')).toEqual([]);

    await p.commands.control({ verb: 'resume', scope: { kind: 'phase', id: '5' } });
    await until(() => p.state()!.phases[5]!.status === 'done', 30_000);
    expect(missionControl(p.state()!).project.holds).toEqual([]);
    await bot.stop();
    await p.handle.terminate();
  }, 90_000);

  it('cancels a task with its same-item dependents; cross-cutting work carries on', async () => {
    const p = await launch(h);
    const g = await gate1(p);
    await p.commands.control({ verb: 'pause', scope: { kind: 'project', id: p.projectId } });
    await p.commands.resolve(g.escalationId, 'approve');
    await p.commands.control({ verb: 'cancel', scope: { kind: 'task', id: 'port-tabs' } });

    const s = p.state()!;
    expect(s.tasks['port-tabs']!.state).toBe('cancelled');
    expect(s.tasks['register-tabs']!.state).toBe('cancelled');
    expect(s.tasks['validate-components']!.state).toBe('planned');
    expect(s.metrics.components_registered).toMatchObject({ value: 0, total: 4 });
    expect(s.decisions.at(-1)).toMatchObject({
      question: 'Cancel Port Tabs to Content SDK',
      decidedBy: 'director',
    });

    await expect(
      p.commands.control({ verb: 'cancel', scope: { kind: 'task', id: 'port-tabs' } }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      p.commands.control({ verb: 'cancel', scope: { kind: 'workstream', id: 'engineering' } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      p.commands.control({ verb: 'pause', scope: { kind: 'task', id: 'port-hero' } }),
    ).rejects.toMatchObject({
      status: 409,
      message:
        'Only a running task can be paused; pause its phase or workstream to hold queued work.',
    });

    const finish = directorBot(p);
    await p.commands.control({ verb: 'resume', scope: { kind: 'project', id: p.projectId } });
    await p.handle.result();
    await finish.stop();
    const end = p.state()!;
    expect(end.status).toBe('completed');
    expect(end.tasks['validate-components']!.state).toBe('done');
    expect(end.metrics.components_registered).toMatchObject({ value: 4, total: 4 });
    assertLegalLog(await h.store.read(p.projectId));
  }, 90_000);

  it('pauses a running task at its next step boundary and resumes it', async () => {
    let release: () => void = () => {};
    const gateOpen = new Promise<void>((r) => (release = r));
    const runner = {
      async run(req: RunRequest) {
        if (req.task.taskId === 'inventory-repo') await gateOpen;
        return {
          kind: 'done' as const,
          summary: 'ok',
          metrics: {},
          spent: { tokens: 1_000, usd: 0.01 },
        };
      },
    };
    const p = await launch(h, { runner });
    await until(() => p.state()?.tasks['inventory-repo']?.state === 'running');
    await p.commands.control({ verb: 'pause', scope: { kind: 'task', id: 'inventory-repo' } });
    expect(missionControl(p.state()!).project.holds).toEqual([
      { kind: 'task', id: 'inventory-repo', label: 'Inventory components, routes and assets' },
    ]);
    release();
    await until(() => p.state()!.tasks['inventory-repo']!.state === 'paused');
    await new Promise((r) => setTimeout(r, 300));
    expect(p.state()!.tasks['inventory-repo']!.state).toBe('paused');
    await p.commands.control({ verb: 'resume', scope: { kind: 'task', id: 'inventory-repo' } });
    await until(() => p.state()!.tasks['inventory-repo']!.state === 'done');
    await p.handle.terminate();
  }, 60_000);

  it('cancels the whole project and ends its workflow', async () => {
    const p = await launch(h);
    await gate1(p);
    await p.commands.control({ verb: 'cancel', scope: { kind: 'project', id: p.projectId } });
    await p.handle.result();
    const s = p.state()!;
    expect(s.status).toBe('cancelled');
    expect(Object.values(s.escalations).every((x) => x.status !== 'open')).toBe(true);
    expect(plan(s).tasks.filter((t) => t.state === 'planned')).toEqual([]);
    assertLegalLog(await h.store.read(p.projectId));
  }, 60_000);
});
