import { fileURLToPath } from 'node:url';
import {
  ActivityPage,
  AgentDetail,
  ConversationSnapshot,
  LwEvent,
  MissionControlSnapshot,
  PlanSnapshot,
  TeamSnapshot,
  type EscalationView,
} from '@lw/contracts';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { Simulation, sitecoreScenario } from '@lw/simulator';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { simulationCommands } from '../src/commands';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const NAME = 'Acme corporate site';

interface Harness {
  app: FastifyInstance;
  sim: Simulation;
  store: InMemoryEventStore;
  base: string;
}

let current: Harness | null = null;

async function start(speed = 300): Promise<Harness> {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const sim = new Simulation(store, await loadPlaybook(PLAYBOOK), {
    projectId: 'p1',
    name: NAME,
    client: 'Acme Corp',
    speed,
    directiveWindowSec: 0.05,
  });
  const cmds = simulationCommands(sim);
  const app = await buildApp({
    store,
    projections,
    commands: (id) => (id === 'p1' ? cmds : undefined),
    corsOrigin: '*',
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  void sim.run(sitecoreScenario);
  current = { app, sim, store, base };
  return current;
}

afterEach(async () => {
  current?.sim.stop();
  await current?.app.close();
  current = null;
});

const get = async (h: Harness, path: string) => {
  const r = await fetch(h.base + path);
  return { status: r.status, body: (await r.json()) as any };
};
const post = async (h: Harness, path: string, body: unknown = {}) => {
  const r = await fetch(h.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};

async function until<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const openEscalation = (h: Harness, pred: (x: EscalationView) => boolean) =>
  until(async () => {
    const mc = MissionControlSnapshot.parse((await get(h, '/projects/p1/mission-control')).body);
    return mc.waitingOnYou.find((x) => x.status === 'open' && pred(x));
  });

/** Reads SSE frames until `count` events arrive. */
async function readEvents(
  h: Harness,
  path: string,
  count: number,
  headers: Record<string, string> = {},
) {
  const ctrl = new AbortController();
  const res = await fetch(h.base + path, { headers, signal: ctrl.signal });
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: LwEvent[] = [];
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data: '));
      if (data) events.push(LwEvent.parse(JSON.parse(data.slice(6))) as LwEvent);
    }
  }
  ctrl.abort();
  return events.slice(0, count);
}

describe('control-api', () => {
  it('serves every snapshot in the contract shape', async () => {
    const h = await start();
    await until(async () => (await get(h, '/projects/p1/plan')).body.tasks?.length > 0);
    MissionControlSnapshot.parse((await get(h, '/projects/p1/mission-control')).body);
    TeamSnapshot.parse((await get(h, '/projects/p1/team')).body);
    PlanSnapshot.parse((await get(h, '/projects/p1/plan')).body);
    ConversationSnapshot.parse((await get(h, '/projects/p1/conversation')).body);
    ActivityPage.parse((await get(h, '/projects/p1/activity?limit=5')).body);
    AgentDetail.parse((await get(h, '/projects/p1/agents/chief-of-staff')).body);
    const list = (await get(h, '/projects')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'p1', name: NAME });
  });

  it('answers unknown resources with a named error', async () => {
    const h = await start();
    const r = await get(h, '/projects/nope/mission-control');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('unknown_project');
  });

  it('streams from a snapshot seq without gaps, and resumes from Last-Event-ID', async () => {
    const h = await start();
    const snap = await until(async () => {
      const mc = (await get(h, '/projects/p1/mission-control')).body;
      return mc.seq > 5 ? mc : null;
    });
    const first = await readEvents(h, `/projects/p1/stream?after=${snap.seq}`, 5);
    expect(first.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5].map((n) => snap.seq + n));

    // Reconnect as EventSource would after a drop: Last-Event-ID wins over ?after.
    const resumed = await readEvents(h, '/projects/p1/stream?after=0', 3, {
      'last-event-id': String(first.at(-1)!.seq),
    });
    expect(resumed[0]!.seq).toBe(first.at(-1)!.seq + 1);
  });

  it('pages the activity log newest first', async () => {
    const h = await start();
    await until(async () => (await get(h, '/projects/p1/mission-control')).body.seq > 40);
    const page1 = ActivityPage.parse((await get(h, '/projects/p1/activity?limit=10')).body);
    expect(page1.items).toHaveLength(10);
    const seqs = page1.items.map((i) => i.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs);
    const page2 = ActivityPage.parse(
      (await get(h, `/projects/p1/activity?limit=10&before=${page1.nextBefore}`)).body,
    );
    expect(page2.items[0]!.seq).toBeLessThan(seqs.at(-1)!);
    const steps = ActivityPage.parse(
      (await get(h, '/projects/p1/activity?type=step.recorded&limit=5')).body,
    );
    expect(steps.items.every((i) => i.type === 'step.recorded' && i.toolServer)).toBe(true);
  });

  it('exports the activity log as CSV, oldest first, with full text', async () => {
    const h = await start();
    await until(async () => (await get(h, '/projects/p1/mission-control')).body.seq > 40);
    const r = await fetch(`${h.base}/projects/p1/activity.csv?view=all`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toMatch(
      /^attachment; filename=".+-activity-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const text = (await r.text()).replace(/^\uFEFF/, '');
    const lines = text.trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'seq,time,phase,who,role,task,tool,server,operation,result,code,duration_ms,tokens,severity,event,summary,note',
    );
    const seqs = lines.slice(1).map((l) => Number(l.split(',')[0]));
    expect(seqs.length).toBeGreaterThan(40);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect((await fetch(`${h.base}/projects/nope/activity.csv`)).status).toBe(404);
  });

  it('exports what waits on the Director as CSV', async () => {
    const h = await start(100);
    const card = await openEscalation(h, (x) => x.type === 'decision');
    const r = await fetch(`${h.base}/projects/p1/escalations.csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/-needs-you-\d{4}-\d{2}-\d{2}\.csv"$/);
    const text = (await r.text()).replace(/^\uFEFF/, '');
    expect(text.split('\r\n')[0]).toBe(
      'escalation,raised,status,type,title,from,task,task_title,phase,context,impact,options,recommended,default_at,deferred_until,resolution,notes,resolved_at',
    );
    expect(text).toContain(card.escalationId);
    expect(text).toContain(`A: ${card.options[0]!.label}`);
  });

  it('resolves a Decision and records it in the Decision Log', async () => {
    const h = await start(100);
    const sot = await openEscalation(h, (x) => x.type === 'decision');
    const r = await post(h, `/projects/p1/escalations/${sot.escalationId}/resolve`, {
      optionId: 'repo',
    });
    expect(r.status).toBe(200);
    const log = (await get(h, '/projects/p1/decisions')).body;
    expect(log.at(-1)).toMatchObject({
      decidedBy: 'director',
      answer: 'Repository content where it exists',
    });
    const again = await post(h, `/projects/p1/escalations/${sot.escalationId}/resolve`, {
      optionId: 'repo',
    });
    expect(again.status).toBe(409);
  });

  it('holds at Gate 1 until approved, and sending back produces a new Blueprint version', async () => {
    const h = await start();
    const gate = await openEscalation(h, (x) => x.type === 'gate');
    expect(gate.gate).toMatchObject({ phase: 2, artifactVersion: 1 });
    expect(
      (
        await post(h, `/projects/p1/escalations/${gate.escalationId}/resolve`, {
          optionId: 'approve',
        })
      ).status,
    ).toBe(422);
    expect((await post(h, `/projects/p1/gates/${gate.escalationId}/send-back`, {})).status).toBe(
      400,
    );
    expect(
      (
        await post(h, `/projects/p1/gates/${gate.escalationId}/send-back`, {
          notes: 'Split Header and Navigation',
        })
      ).status,
    ).toBe(200);

    const gate2 = await openEscalation(
      h,
      (x) => x.type === 'gate' && x.gate?.artifactVersion === 2,
    );
    expect((await post(h, `/projects/p1/gates/${gate2.escalationId}/approve`)).status).toBe(200);
    await until(async () => {
      const mc = MissionControlSnapshot.parse((await get(h, '/projects/p1/mission-control')).body);
      return mc.phases.find((p) => p.number === 3)?.status === 'current';
    });
  });

  it('pauses and resumes the project', async () => {
    const h = await start();
    await until(async () => (await get(h, '/projects/p1/mission-control')).body.seq > 5);
    const scope = { kind: 'project', id: 'p1' };
    expect((await post(h, '/projects/p1/control', { verb: 'pause', scope })).status).toBe(200);
    expect((await get(h, '/projects/p1/mission-control')).body.project.status).toBe('paused');
    expect((await post(h, '/projects/p1/control', { verb: 'pause', scope })).status).toBe(409);
    expect((await post(h, '/projects/p1/control', { verb: 'resume', scope })).status).toBe(200);
    expect((await get(h, '/projects/p1/mission-control')).body.project.status).toBe('running');
  });

  it('acknowledges a directive with a stop window, and Stop cancels it', async () => {
    const h = await start();
    await until(async () => (await get(h, '/projects/p1/mission-control')).body.seq > 3);
    const status = await post(h, '/projects/p1/messages', { body: 'status' });
    expect(status.status).toBe(200);
    await post(h, '/projects/p1/control', { verb: 'pause', scope: { kind: 'project', id: 'p1' } });
    await post(h, '/projects/p1/messages', { body: 'Skip the blog templates' });
    const ack = ConversationSnapshot.parse(
      (await get(h, '/projects/p1/conversation')).body,
    ).items.findLast((m) => m.kind === 'directive_ack')!;
    expect(ack.proceedsAt).not.toBeNull();
    const stop = await post(h, `/projects/p1/directives/${ack.directiveId}/stop`);
    // The window is 50 ms in tests; either we stopped it or it already applied.
    expect([200, 409]).toContain(stop.status);
  });

  it('drives a whole engagement to completion through the HTTP API', async () => {
    const h = await start(3_000);
    for (;;) {
      const mc = MissionControlSnapshot.parse((await get(h, '/projects/p1/mission-control')).body);
      if (mc.project.status === 'completed') break;
      const x = mc.waitingOnYou.find(
        (e) => e.status === 'open' && (e.type === 'gate' || !e.defaultOptionId),
      );
      if (x?.type === 'gate') {
        const r = await post(h, `/projects/p1/gates/${x.escalationId}/approve`, {});
        if (x.gate?.requiresConfirmation) {
          expect(r.status).toBe(422);
          expect(
            (await post(h, `/projects/p1/gates/${x.escalationId}/approve`, { confirmation: NAME }))
              .status,
          ).toBe(200);
        }
      } else if (x) {
        await post(h, `/projects/p1/escalations/${x.escalationId}/resolve`, {
          optionId: x.options.find((o) => o.recommended)!.id,
        });
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    const mc = MissionControlSnapshot.parse((await get(h, '/projects/p1/mission-control')).body);
    expect(mc.phases.every((p) => p.status === 'done')).toBe(true);
    expect(mc.metrics.find((m) => m.key === 'parity')?.value).toBe(98.6);
  }, 60_000);
});
