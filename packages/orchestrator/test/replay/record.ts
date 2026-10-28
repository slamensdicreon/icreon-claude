/**
 * Records project and task workflow histories as a given workflow code base runs them, for the
 * replay test. Run it against the code that is in production before changing the workflows:
 *
 *   tsx test/replay/record.ts <workflows dir> <out name>
 *
 * The histories land in test/replay/histories/<name>.*.json; commit them with the change.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@temporalio/client';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { createStubActivities, defaultPolicy, loadFixtures, startProject } from '../../src';
import { PLAYBOOK_DIR, SMALL_BLUEPRINT } from '../harness';

const [workflowsPath, name] = process.argv.slice(2);
if (!workflowsPath || !name) throw new Error('usage: record.ts <workflows/index.ts> <name>');
const OUT = fileURLToPath(new URL('./histories/', import.meta.url));
const QUEUE = 'replay-record';

const env = await TestWorkflowEnvironment.createLocal();
const store = new InMemoryEventStore();
const projections = new Projections(store);
await projections.start();
const playbook = await loadPlaybook(PLAYBOOK_DIR);
const { outputs } = await loadFixtures(PLAYBOOK_DIR);
const activities = createStubActivities({ store, playbook, blueprint: SMALL_BLUEPRINT, outputs });
const worker = await Worker.create({
  connection: env.nativeConnection,
  taskQueue: QUEUE,
  workflowsPath,
  activities,
});
const run = worker.run();
const client = new Client({ connection: env.connection, namespace: env.namespace });
const projectId = `replay-${name}`;
const policy = defaultPolicy(playbook, {
  budgets: { tokens: 50_000_000, usd: 10_000, hours: 10_000 },
  undoWindowMs: 0,
});
const handle = await startProject(
  client,
  { projectId, name: 'Replay', client: 'Acme', playbook, policy },
  QUEUE,
);

// Play the Director: approve every gate, take every card's recommended option.
const answered = new Set<string>();
for (;;) {
  const d = await handle.describe();
  if (d.status.name !== 'RUNNING') break;
  await projections.catchUp(projectId);
  const s = projections.get(projectId);
  for (const e of Object.values(s?.escalations ?? {})) {
    if (e.status !== 'open' || answered.has(e.escalationId)) continue;
    answered.add(e.escalationId);
    const option = e.options.find((o) => o.recommended) ?? e.options[0]!;
    await handle
      .executeUpdate('resolveEscalation', {
        args: [
          {
            escalationId: e.escalationId,
            optionId: option.id,
            notes: null,
            confirmation: e.gate?.requiresConfirmation ? 'Replay' : undefined,
          },
        ],
      })
      .catch(() => undefined);
  }
  await new Promise((r) => setTimeout(r, 100));
}

await mkdir(OUT, { recursive: true });
const history = await handle.fetchHistory();
await writeFile(`${OUT}${name}.project.json`, historyToJSON(history));
// One child of each kind of session: the first and the last task workflow.
const children = (history.events ?? []).flatMap((e) => {
  const id = e.childWorkflowExecutionStartedEventAttributes?.workflowExecution?.workflowId;
  return id ? [id] : [];
});
for (const id of [children[0], children.at(-1)].filter(Boolean) as string[]) {
  const h = await client.workflow.getHandle(id).fetchHistory();
  await writeFile(`${OUT}${name}.task-${children.indexOf(id)}.json`, historyToJSON(h));
}
console.log(`recorded ${projectId}: ${history.events?.length} events, ${children.length} tasks`);
worker.shutdown();
await run;
await env.teardown();
