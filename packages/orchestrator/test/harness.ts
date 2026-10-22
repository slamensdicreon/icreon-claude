import { fileURLToPath } from 'node:url';
import type { LwEvent } from '@lw/contracts';
import { canTransition, CommandError, type ProjectState } from '@lw/domain';
import { InMemoryEventStore, Projections } from '@lw/events';
import { Blueprint } from '@lw/plan';
import { loadPlaybook, type Playbook } from '@lw/playbook-sdk';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { Worker } from '@temporalio/worker';
import { expect } from 'vitest';
import {
  createStubActivities,
  createWorker,
  defaultPolicy,
  loadFixtures,
  ProjectCommandsClient,
  startProject,
  type Activities,
  type ProjectPolicy,
  type StubScript,
} from '../src';

export const PLAYBOOK_DIR = fileURLToPath(
  new URL('../../../playbooks/sitecoreai-migration', import.meta.url),
);
const TASK_QUEUE = 'test-orchestration';

/** A small site so a full engagement runs in seconds: 5 components, 3 templates, 10 pages, 6 media. */
export const SMALL_BLUEPRINT = Blueprint.parse({
  version: 1,
  collections: {
    components: [
      { key: 'hero', name: 'Hero', pilot: true },
      { key: 'promo-card', name: 'PromoCard', pilot: true },
      { key: 'header', name: 'Header' },
      { key: 'footer', name: 'Footer' },
      { key: 'tabs', name: 'Tabs' },
    ],
    templates: [
      { key: 'home', name: 'Home Page' },
      { key: 'article', name: 'Article Page' },
      { key: 'blog-post', name: 'Blog Post' },
    ],
    pages: [
      ...Array.from({ length: 7 }, (_, i) => ({ key: `page-${i + 1}`, name: `Page ${i + 1}` })),
      ...Array.from({ length: 3 }, (_, i) => ({
        key: `blog-${i + 1}`,
        name: `Blog post ${i + 1}`,
      })),
    ],
    media: Array.from({ length: 6 }, (_, i) => ({
      key: `media-${i + 1}`,
      name: `Media item ${i + 1}`,
    })),
  },
});

export interface Harness {
  env: TestWorkflowEnvironment;
  worker: Worker;
  store: InMemoryEventStore;
  projections: Projections;
  playbook: Playbook;
  projects: Map<string, Activities>;
  run: Promise<void>;
}

/** One Temporal test server + worker per test file; projects route to their own stub activities. */
export async function startHarness(): Promise<Harness> {
  const env = await TestWorkflowEnvironment.createTimeSkipping();
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const playbook = await loadPlaybook(PLAYBOOK_DIR);
  const projects = new Map<string, Activities>();
  const route = (projectId: string) => projects.get(projectId)!;
  const activities: Activities = {
    emit: (projectId, events) => route(projectId).emit(projectId, events),
    runAgent: (req) => route(req.projectId).runAgent(req),
    validate: (req) => route(req.projectId).validate(req),
    loadBlueprint: (projectId) => route(projectId).loadBlueprint(projectId),
    interpretDirective: (req) => route(req.projectId).interpretDirective(req),
    rollbackTask: (req) => route(req.projectId).rollbackTask(req),
  };
  const worker = await createWorker({
    connection: env.nativeConnection,
    activities,
    taskQueue: TASK_QUEUE,
  });
  const run = worker.run();
  return { env, worker, store, projections, playbook, projects, run };
}

export async function stopHarness(h: Harness) {
  h.worker.shutdown();
  await h.run;
  await h.env.teardown();
}

let counter = 0;

export async function launch(
  h: Harness,
  opts: { script?: StubScript; policy?: Partial<ProjectPolicy>; blueprint?: Blueprint } = {},
) {
  const projectId = `p${++counter}`;
  const { outputs } = await loadFixtures(PLAYBOOK_DIR);
  h.projects.set(
    projectId,
    createStubActivities({
      store: h.store,
      playbook: h.playbook,
      blueprint: opts.blueprint ?? SMALL_BLUEPRINT,
      outputs,
      script: opts.script,
    }),
  );
  const policy = defaultPolicy(h.playbook, {
    budgets: { tokens: 50_000_000, usd: 10_000, hours: 10_000 },
    ...opts.policy,
  });
  const handle = await startProject(
    h.env.client,
    { projectId, name: `Project ${projectId}`, client: 'Acme Corp', playbook: h.playbook, policy },
    TASK_QUEUE,
  );
  const commands = new ProjectCommandsClient(h.env.client, projectId);
  const state = () => h.projections.get(projectId);
  return { projectId, name: `Project ${projectId}`, handle, commands, state };
}

export async function until<T>(
  fn: () => T | null | undefined | false,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const openEscalations = (s: ProjectState | undefined) =>
  Object.values(s?.escalations ?? {}).filter((x) => x.status === 'open');

/**
 * Plays the Director: approves gates (typing the project name where required) and picks the
 * recommended option on every other card. `decide` can override per card.
 */
export function directorBot(
  p: Awaited<ReturnType<typeof launch>>,
  /** Return a choice, null for the recommended option, or 'leave' to let the test answer it. */
  decide: (
    x: ReturnType<typeof openEscalations>[number],
  ) => { optionId: string; notes?: string } | 'leave' | null = () => null,
) {
  let stopped = false;
  const handled = new Set<string>();
  const loop = (async () => {
    while (!stopped) {
      for (const x of openEscalations(p.state())) {
        if (handled.has(x.escalationId)) continue;
        handled.add(x.escalationId);
        const decided = decide(x);
        if (decided === 'leave') continue;
        const choice = decided ?? {
          optionId: x.options.find((o) => o.recommended)?.id ?? x.options[0]!.id,
        };
        await p.commands
          .resolve(
            x.escalationId,
            choice.optionId,
            choice.notes ?? null,
            x.gate?.requiresConfirmation ? p.name : undefined,
          )
          .catch((e) => {
            // The default may have applied first; anything else is a real failure.
            if (!(e instanceof CommandError && e.status === 409)) throw e;
          });
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

/** Gap-free seqs; every task transition legal and starting from the state the log last put it in. */
export function assertLegalLog(events: LwEvent[]) {
  events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  const last = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'task.planned') last.set(e.data.taskId, 'planned');
    if (e.type === 'task.state') {
      const where = `${e.data.taskId}: ${e.data.from} → ${e.data.to} (seq ${e.seq})`;
      expect(last.get(e.data.taskId), where).toBe(e.data.from);
      expect(canTransition(e.data.from, e.data.to), where).toBe(true);
      last.set(e.data.taskId, e.data.to);
    }
  }
}
