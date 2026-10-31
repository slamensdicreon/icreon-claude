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

describe('project workflow', () => {
  it('runs an engagement end to end through both gates, a Lead escalation and an access failure', async () => {
    const p = await launch(h, {
      script: { rejectTimes: { 'port-header': 3 }, accessDenied: ['upload-media-media-2'] },
    });
    const bot = directorBot(p);
    await p.handle.result();
    await bot.stop();

    const s = p.state()!;
    const mc = missionControl(s);
    expect(mc.project.status).toBe('completed');
    expect(mc.phases.every((ph) => ph.status === 'done')).toBe(true);
    const tasks = plan(s).tasks;
    expect(tasks.some((t) => t.kind === 'placeholder')).toBe(false);
    expect(tasks.every((t) => t.state === 'done')).toBe(true);
    expect(tasks.find((t) => t.taskId === 'port-header')!.attempt).toBe(4);
    expect(mc.metrics.find((m) => m.key === 'components_registered')).toMatchObject({
      value: 5,
      total: 5,
    });
    expect(mc.metrics.find((m) => m.key === 'pages_migrated')).toMatchObject({
      value: 10,
      total: 10,
    });
    // From the phase 6 parity audit: acceptance is the Director's, with no final agent re-audit.
    expect(mc.metrics.find((m) => m.key === 'parity')?.value).toBe(98.6);

    const types = Object.values(s.escalations)
      .map((x) => x.type)
      .sort();
    // Both phase gates, the approval of each release (hosting, the site's editing host, code
    // deploy, publish), and the two Page builder steps the Director does by hand.
    expect(types).toEqual([
      'access',
      'decision',
      'decision',
      'decision',
      'gate',
      'gate',
      'gate',
      'gate',
      'gate',
      'gate',
    ]);
    expect(
      Object.values(s.escalations)
        .filter((x) => x.title.startsWith('By hand'))
        .map((x) => x.sourceTaskId)
        .sort(),
    ).toEqual(['prove-pilot-slice', 'smoke-test']);
    expect(
      Object.values(s.escalations)
        .filter((x) => x.title.startsWith('Approve release'))
        .map((x) => x.context.split('. ')[0])
        .sort(),
    ).toEqual([
      'Deploy the head to Vercel and register it as the editing host',
      'Deploy the reviewed commit to the editing and delivery hosts',
      'Point the site at its own editing host',
      'Publish to Experience Edge and verify every route',
    ]);
    expect(s.decisions.filter((d) => d.decidedBy === 'director').length).toBeGreaterThanOrEqual(3);

    const events = await h.store.read(p.projectId);
    assertLegalLog(events);
    expect(
      events.filter((e) => e.type === 'artifact.versioned' && e.data.artifactId === 'blueprint'),
    ).toHaveLength(1);
  }, 120_000);

  it('holds at Gate 1; send back re-runs the Blueprint and asks again with v2', async () => {
    const p = await launch(h);
    const gate1 = await until(() => openEscalations(p.state()).find((x) => x.type === 'gate'));
    expect(gate1.gate).toMatchObject({ phase: 2, artifactId: 'blueprint', artifactVersion: 1 });
    await expect(p.commands.resolve(gate1.escalationId, 'send_back')).rejects.toMatchObject({
      status: 422,
    });
    await p.commands.resolve(gate1.escalationId, 'send_back', 'Split Header and Navigation');

    const gate1b = await until(() =>
      openEscalations(p.state()).find((x) => x.type === 'gate' && x.gate?.artifactVersion === 2),
    );
    expect(gate1b.title).toBe('Approve Implementation Blueprint v2');
    await p.commands.resolve(gate1b.escalationId, 'approve');
    await until(() => p.state()!.phases[3]!.status === 'current');
    expect(plan(p.state()!).tasks.filter((t) => t.group === 'port-{key}')).toHaveLength(5);
    await p.handle.terminate();
  }, 60_000);

  it('requires the project name to accept at Gate 2, and rejects bad commands with named errors', async () => {
    const p = await launch(h);
    const bot = directorBot(p, (x) => (x.gate?.requiresConfirmation ? 'leave' : null));
    const gate2 = await until(
      () => openEscalations(p.state()).find((x) => x.gate?.requiresConfirmation),
      60_000,
    );
    await bot.stop();
    await expect(p.commands.resolve(gate2.escalationId, 'approve')).rejects.toMatchObject({
      status: 422,
      code: 'invalid',
    });
    await expect(
      p.commands.defer(gate2.escalationId, new Date(Date.now() + 60_000)),
    ).rejects.toMatchObject({ status: 422 });
    await expect(p.commands.resolve('esc-nope', 'approve')).rejects.toMatchObject({ status: 404 });
    await p.commands.resolve(gate2.escalationId, 'approve', null, p.name);
    await p.handle.result();
    expect(p.state()!.status).toBe('completed');
  }, 120_000);

  it('pauses dispatch at the project level and resumes', async () => {
    const p = await launch(h);
    await until(() => p.state()?.phases[1]?.status === 'current');
    await p.commands.control({ verb: 'pause', scope: { kind: 'project', id: p.projectId } });
    expect(p.state()!.status).toBe('paused');
    await expect(
      p.commands.control({ verb: 'pause', scope: { kind: 'project', id: p.projectId } }),
    ).rejects.toMatchObject({ status: 409 });
    const seqAtPause = p.state()!.seq;
    await new Promise((r) => setTimeout(r, 300));
    const startedSince = (await h.store.read(p.projectId, { after: seqAtPause })).filter(
      (e) => e.type === 'task.state' && e.data.to === 'ready',
    );
    expect(startedSince).toHaveLength(0);
    await p.commands.control({ verb: 'resume', scope: { kind: 'project', id: p.projectId } });
    await until(() => p.state()!.phases[2]!.status !== 'future');
    await p.handle.terminate();
  }, 60_000);

  it('re-runs a finished task, even one whose phase has exited', async () => {
    const p = await launch(h);
    await until(() => (p.state()?.phases[0]?.status === 'done' ? true : undefined));
    await expect(p.commands.rerunTask('nope', 'x')).rejects.toMatchObject({ status: 404 });
    await expect(p.commands.rerunTask('design-system', 'x')).rejects.toMatchObject({
      status: 409,
    });
    const seq = p.state()!.seq;
    await p.commands.rerunTask('verify-access', 'Check the Experience Edge token too');
    const moves = async () =>
      (await h.store.read(p.projectId, { after: seq }))
        .filter((e) => e.type === 'task.state' && e.subject.id === 'verify-access')
        .map((e) => (e.data as { to: string }).to);
    for (let i = 0; i < 300 && (await moves()).at(-1) !== 'done'; i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(await moves()).toEqual(['rolled_back', 'ready', 'running', 'validating', 'done']);
    expect(
      p
        .state()!
        .decisions.some((d) => d.question === 'Re-run Verify credentials and record tenant facts'),
    ).toBe(true);
    await p.handle.terminate();
  }, 60_000);

  it('acknowledges a directive with its impact, then applies it after the stop window', async () => {
    const p = await launch(h, { policy: { directiveWindowMs: 1_500 } });
    const gate1 = await until(() => openEscalations(p.state()).find((x) => x.type === 'gate'));
    await p.commands.control({ verb: 'pause', scope: { kind: 'project', id: p.projectId } });
    await p.commands.resolve(gate1.escalationId, 'approve');
    await until(() => plan(p.state()!).tasks.some((t) => t.taskId === 'migrate-pages-blog-1'));
    await p.commands.postMessage('Skip the blog');
    const ack = p.state()!.conversation.findLast((m) => m.kind === 'directive_ack')!;
    expect(ack.body).toBe(
      'Understood: skip everything matching "blog". Impact: Removes 3 pages and 1 template in scope. Proceeding in 2 seconds unless you stop me.',
    );
    await until(() => p.state()!.conversation.some((m) => m.body.startsWith('Applied:')));
    const ids = Object.keys(p.state()!.tasks);
    expect(p.state()!.tasks['migrate-pages-blog-1']!.state).toBe('cancelled');
    expect(p.state()!.tasks['template-blog-post']!.state).toBe('cancelled');
    expect(ids).toContain('migrate-pages-page-1');
    expect(p.state()!.metrics.pages_migrated).toMatchObject({ value: 0, total: 7 });

    // A second directive, stopped inside its window, changes nothing.
    await p.commands.postMessage('Skip the tabs component');
    const ack2 = p.state()!.conversation.findLast((m) => m.kind === 'directive_ack')!;
    await p.commands.stopDirective(ack2.directiveId!);
    await expect(p.commands.stopDirective(ack2.directiveId!)).rejects.toMatchObject({
      status: 409,
    });
    await until(() => p.state()!.conversation.at(-1)!.body === 'Stopped. Nothing changed.');
    expect(p.state()!.tasks['port-tabs']!.state).toBe('planned');
    expect(p.state()!.conversation.at(-1)!.body).toBe('Stopped. Nothing changed.');

    await p.commands.postMessage('status');
    expect(p.state()!.conversation.at(-1)!.kind).toBe('status');
    // It says who is working, or that nobody is and why.
    expect(p.state()!.conversation.at(-1)!.body).toMatch(/Working now \(\d+\)|Nobody is working/);
    assertLegalLog(await h.store.read(p.projectId));
    await p.handle.terminate();
  }, 60_000);

  it('holds new work at the soft budget limit until acknowledged', async () => {
    const p = await launch(h, {
      policy: { budgets: { tokens: 120_000, usd: 10_000, hours: 10_000 } },
    });
    const budget = await until(
      () => openEscalations(p.state()).find((x) => x.type === 'budget'),
      30_000,
    );
    expect(budget.title).toMatch(/^Budget at \d+%$/);
    await p.handle.terminate();
  }, 60_000);

  it('pauses at the hard limit, and resumes when the Director raises the budget', async () => {
    const p = await launch(h, {
      policy: { budgets: { tokens: 60_000, usd: 10_000, hours: 10_000 } },
    });
    await until(() => (p.state()?.status === 'paused' ? true : undefined), 30_000);
    expect(p.state()!.conversation.some((m) => m.title === 'Budget exhausted')).toBe(true);
    await expect(
      p.commands.changeBudgets({ tokens: 0, usd: 10_000, hours: 10_000 }),
    ).rejects.toMatchObject({ status: 422 });

    await p.commands.changeBudgets({ tokens: 50_000_000, usd: 10_000, hours: 10_000 });
    await until(() => (p.state()?.status === 'running' ? true : undefined), 10_000);
    expect(p.state()!.budgets.tokens).toBe(50_000_000);
    // The 80% card raised on the way is answered by the new budget.
    expect(openEscalations(p.state()).some((x) => x.type === 'budget')).toBe(false);
    expect(p.state()!.decisions.at(-1)).toMatchObject({
      question: 'Change the project budgets',
      decidedBy: 'director',
    });
    assertLegalLog(await h.store.read(p.projectId));
    await p.handle.terminate();
  }, 60_000);
});
