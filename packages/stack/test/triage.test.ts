import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TriageInput } from '@lw/agent-runtime';
import type { NewEvent } from '@lw/contracts';
import { SITECORE_DEFAULTS } from '@lw/connectors';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { createPlatforms } from '@lw/platforms';
import { afterAll, expect, it } from 'vitest';
import { composeStack, type Stack } from '../src';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const sys = { actor: { kind: 'system', id: 'sys' }, severity: 'routine' } as const;

let stack: Stack | undefined;
afterAll(async () => {
  await stack?.close();
});

function created(projectId: string, mode: 'live' | 'demo'): NewEvent[] {
  return [
    {
      ...sys,
      type: 'project.created',
      subject: { kind: 'project', id: projectId },
      data: {
        name: 'Globex',
        client: 'Globex',
        playbook: { id: 'sitecoreai-migration', version: '0.6.0' },
        budgets: { tokens: 1, usd: 1, hours: 1 },
        phases: [{ number: 4, name: 'Components', gate: 'none', exitCriteria: '' }],
        roster: [],
        timezone: 'UTC',
        mode,
        intake:
          mode === 'live'
            ? { platform: 'sitecoreai', repo: null, branch: null, target: {}, connectionId: null }
            : null,
      },
    } as NewEvent,
    {
      ...sys,
      type: 'task.planned',
      subject: { kind: 'task', id: 'port-hero' },
      data: {
        taskId: 'port-hero',
        phase: 4,
        workstream: 'engineering',
        role: 'component-engineer',
        title: 'Port Hero to Content SDK',
        dependsOn: [],
        group: 'port-{key}',
        itemKeys: ['hero'],
      },
    } as NewEvent,
  ];
}

const question = (projectId: string, category: 'naming' | 'access') => ({
  projectId,
  taskId: 'port-hero',
  role: 'component-engineer',
  category,
  card: {
    title: 'Hero: one rendering with variants, or five renderings?',
    context: 'Five layouts driven by props.',
    impact: '',
    options: [
      { id: 'opt-1', label: 'One rendering with variants', recommended: true },
      { id: 'opt-2', label: 'Five renderings', recommended: false },
    ],
  },
  previous: [],
});

it('asks the task’s Lead on live projects, by the category’s autonomy level', async () => {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  await store.append('live', created('live', 'live'));
  await store.append('demo', created('demo', 'demo'));
  const asked: TriageInput[] = [];
  stack = await composeStack({
    store,
    projections,
    playbook: await loadPlaybook(PLAYBOOK),
    playbookDir: PLAYBOOK,
    platform: createPlatforms({ sitecore: SITECORE_DEFAULTS }).get('sitecoreai')!,
    dataDir: await mkdtemp(join(tmpdir(), 'lw-triage-')),
    triage: async (input) => {
      asked.push(input);
      return {
        decision: 'answer',
        optionId: 'opt-1',
        reasoning: 'Variants, per the Blueprint.',
        ruleIds: [],
        tokens: 300,
        usd: 0.001,
      };
    },
  });
  const triage = stack.activities.triage;

  // Naming is a Lead's to settle; this playbook starts it in shadow.
  expect(await triage(question('live', 'naming'))).toEqual({
    level: 'shadow',
    leadId: 'engineering-lead',
    leadName: 'Marcus Reyes',
    decision: 'answer',
    optionId: 'opt-1',
    reasoning: 'Variants, per the Blueprint.',
    ruleIds: [],
    tokens: 300,
    usd: 0.001,
  });
  expect(asked[0]).toMatchObject({
    lead: { name: 'Marcus Reyes, Engineering Lead', effort: 'low' },
    specialist: 'Component Engineer',
    category: 'Naming and structure',
    task: { title: 'Port Hero to Content SDK' },
    rules: [],
  });
  expect(asked[0]!.permissions.some((p) => p.startsWith('sandbox: '))).toBe(true);

  // Access is always asked; demo projects have no Lead to ask.
  expect(await triage(question('live', 'access'))).toEqual({ level: 'ask', tokens: 0, usd: 0 });
  expect(await triage(question('demo', 'naming'))).toEqual({ level: 'ask', tokens: 0, usd: 0 });
  expect(asked).toHaveLength(1);

  // The Director hands naming to the agents: no Lead call, the recommendation stands.
  await store.append('live', [
    {
      ...sys,
      type: 'settings.changed',
      subject: { kind: 'project', id: 'live' },
      data: { key: 'autonomy', value: { naming: 'agents' } },
    } as NewEvent,
  ]);
  expect(await triage(question('live', 'naming'))).toEqual({ level: 'agents', tokens: 0, usd: 0 });
  expect(asked).toHaveLength(1);
}, 60_000);
