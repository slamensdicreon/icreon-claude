import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { Client } from '@temporalio/client';
import { historyFromJSON } from '@temporalio/common/lib/proto-utils';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { describe, expect, it } from 'vitest';
import {
  createStubActivities,
  defaultPolicy,
  loadFixtures,
  startProject,
  WORKFLOWS_PATH,
} from '../../src';
import { PLAYBOOK_DIR, SMALL_BLUEPRINT } from '../harness';

const HISTORIES = fileURLToPath(new URL('./histories/', import.meta.url));
const BASE = fileURLToPath(new URL('./base/workflows/index.ts', import.meta.url));

/**
 * Projects run for weeks; workflow code changes under them. Every recorded production-era history
 * must replay on the current code without a nondeterminism error, or a deploy strands them.
 */
describe('workflow replay', () => {
  it('replays histories recorded on earlier code', async () => {
    const files = (await readdir(HISTORIES)).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    const histories = await Promise.all(
      files.map(async (f) => ({
        workflowId: f,
        history: historyFromJSON(JSON.parse(await readFile(`${HISTORIES}${f}`, 'utf8'))),
      })),
    );
    for await (const r of Worker.runReplayHistories({ workflowsPath: WORKFLOWS_PATH }, histories)) {
      expect(r.error, `${r.workflowId}: ${r.error?.message}`).toBeUndefined();
    }
  }, 120_000);

  it('replays an earlier history past the continue-as-new threshold as it ran', async () => {
    // The earlier code ignored the threshold; a run it started must not hand over on replay.
    const history = historyFromJSON(
      JSON.parse(await readFile(`${HISTORIES}base.project.json`, 'utf8')),
    );
    const started = history.events![0]!.workflowExecutionStartedEventAttributes!;
    const payload = started.input!.payloads![0]!;
    const input = JSON.parse(Buffer.from(payload.data!).toString('utf8'));
    input.policy.continueAsNewAt = 150;
    payload.data = Buffer.from(JSON.stringify(input));
    expect(history.events!.length).toBeGreaterThan(150);
    await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, 'base-threshold');
  }, 120_000);

  it('switches a running project from the earlier code to the current code', async () => {
    const env = await TestWorkflowEnvironment.createLocal();
    try {
      const store = new InMemoryEventStore();
      const projections = new Projections(store);
      await projections.start();
      const playbook = await loadPlaybook(PLAYBOOK_DIR);
      const { outputs } = await loadFixtures(PLAYBOOK_DIR);
      const activities = createStubActivities({
        store,
        playbook,
        blueprint: SMALL_BLUEPRINT,
        outputs,
      });
      const client = new Client({ connection: env.connection, namespace: env.namespace });
      const queue = 'replay-switch';
      const worker = (workflowsPath: string) =>
        Worker.create({
          connection: env.nativeConnection,
          taskQueue: queue,
          workflowsPath,
          activities,
        });
      const projectId = 'switch';
      const handle = await startProject(
        client,
        {
          projectId,
          name: 'Switch',
          client: 'Acme',
          playbook,
          policy: defaultPolicy(playbook, {
            budgets: { tokens: 50_000_000, usd: 10_000, hours: 10_000 },
            undoWindowMs: 0,
            // The current code hands over to new runs on the way.
            continueAsNewAt: 300,
          }),
        },
        queue,
      );
      const answered = new Set<string>();
      const director = async () => {
        await projections.catchUp(projectId);
        for (const e of Object.values(projections.get(projectId)?.escalations ?? {})) {
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
                  confirmation: e.gate?.requiresConfirmation ? 'Switch' : undefined,
                },
              ],
            })
            .catch(() => undefined);
        }
      };

      // The earlier code runs the project through its first gates, then the deploy lands.
      const old = await worker(BASE);
      await old.runUntil(async () => {
        while (answered.size < 2) {
          await director();
          await new Promise((r) => setTimeout(r, 100));
        }
      });
      const midway = (await handle.describe()).historyLength;

      const current = await worker(WORKFLOWS_PATH);
      await current.runUntil(async () => {
        while ((await handle.describe()).status.name === 'RUNNING') {
          await director();
          await new Promise((r) => setTimeout(r, 100));
        }
      });
      expect((await handle.describe()).status.name).toBe('COMPLETED');
      expect(projections.get(projectId)?.status).toBe('completed');

      // Every run replays on the current code: the mixed first one and those it handed over to.
      const runs = [];
      for await (const r of client.workflow.list({ query: `WorkflowId = "${handle.workflowId}"` }))
        runs.push(r);
      expect(runs.length).toBeGreaterThan(1);
      const first = runs.find((r) => r.runId === handle.firstExecutionRunId)!;
      expect(first.status.name).toBe('CONTINUED_AS_NEW');
      for (const r of runs) {
        const history = await client.workflow.getHandle(r.workflowId, r.runId).fetchHistory();
        if (r.runId === first.runId) expect(history.events!.length).toBeGreaterThan(midway);
        await Worker.runReplayHistory({ workflowsPath: WORKFLOWS_PATH }, history, r.runId);
      }
    } finally {
      await env.teardown();
    }
  }, 300_000);
});
