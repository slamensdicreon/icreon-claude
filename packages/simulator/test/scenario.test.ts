import { fileURLToPath } from 'node:url';
import { canTransition, missionControl, plan, team } from '@lw/domain';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { describe, expect, it } from 'vitest';
import { Simulation, sitecoreScenario } from '../src';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));

async function runToEnd() {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const sim = new Simulation(store, await loadPlaybook(PLAYBOOK), {
    projectId: 'p1',
    name: 'Acme corporate site',
    client: 'Acme',
    speed: 200_000,
    autopilot: true,
  });
  await sim.run(sitecoreScenario);
  sim.stop();
  return { store, state: projections.get('p1')! };
}

describe('sitecore scenario', () => {
  it('runs all ten phases to completion on autopilot', async () => {
    const { state } = await runToEnd();
    const mc = missionControl(state);
    expect(mc.project.status).toBe('completed');
    expect(mc.phases.every((p) => p.status === 'done')).toBe(true);
    expect(mc.waitingOnYou.filter((x) => x.status === 'open')).toHaveLength(0);
    expect(mc.metrics.find((m) => m.key === 'components_registered')).toMatchObject({
      value: 16,
      total: 16,
    });
    expect(plan(state).tasks.every((t) => t.state === 'done')).toBe(true);
    expect(team(state).agents).toHaveLength(24);
  }, 60_000);

  it('only emits legal task transitions and gap-free seqs', async () => {
    const { store } = await runToEnd();
    const events = await store.read('p1');
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    for (const e of events) {
      if (e.type === 'task.state') expect(canTransition(e.data.from, e.data.to)).toBe(true);
    }
    // Hero goes through two retries, then a Decision that expires to its default.
    const hero = events.filter((e) => e.type === 'task.state' && e.data.taskId === 'p4-port-Hero');
    expect(hero.some((e) => e.type === 'task.state' && e.data.attempt === 3)).toBe(true);
    const expired = events.filter(
      (e) => e.type === 'escalation.updated' && e.data.status === 'expired',
    );
    expect(expired.length).toBeGreaterThan(0);
  }, 60_000);
});
