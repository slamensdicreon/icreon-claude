import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NewEvent } from '@lw/contracts';
import type { EventStore } from '@lw/events';
import { Blueprint, type BlueprintItem } from '@lw/plan';
import type { Playbook } from '@lw/playbook-sdk';
import { ApplicationFailure } from '@temporalio/activity';
import { parse } from 'yaml';
import type { Activities } from './activities';
import { ACCESS_DENIED, type AgentRequest, type AgentResult } from './types';

export interface StubScript {
  /** Lead rejects these tasks' output this many times before it passes. */
  rejectTimes?: Record<string, number>;
  /** These tasks hit a 403 on their first attempt. */
  accessDenied?: string[];
}

export interface StubDeps {
  store: EventStore;
  playbook: Playbook;
  blueprint: Blueprint;
  /** Metrics and artifacts each template reports, keyed by template id. */
  outputs?: Record<string, Pick<AgentResult, 'metrics' | 'artifacts'>>;
  script?: StubScript;
}

/** Rough blended price per million tokens by model tier, for budget burn in demos. */
const PRICE_PER_MTOK: Record<string, number> = {
  'claude-opus-5-5': 6,
  'claude-sonnet-5-5': 3,
  'claude-haiku-5-5': 0.2,
};

/**
 * Stand-in agents: deterministic, instant, and scriptable (rejections, access failures). They
 * record tool-call steps exactly the way real agents will, through the same event log.
 */
export function createStubActivities(deps: StubDeps): Activities {
  const { store, playbook } = deps;
  const roles = new Map(playbook.roles.map((r) => [r.role, r]));
  const script = deps.script ?? {};

  const step = (
    req: AgentRequest,
    server: string,
    op: string,
    summary: string,
    code = 200,
  ): NewEvent => ({
    type: 'step.recorded',
    actor: { kind: 'agent', id: req.task.role },
    subject: { kind: 'step', id: randomUUID() },
    severity: code >= 400 ? 'failure' : 'routine',
    data: {
      stepId: randomUUID(),
      agentId: req.task.role,
      taskId: req.task.taskId,
      toolServer: server,
      operation: op,
      resultCode: code,
      durationMs: 200 + (hash(req.task.taskId + op) % 3000),
      tokens: 300 + (hash(req.task.taskId + server) % 2000),
      summary,
    },
  });

  return {
    async emit(projectId, events) {
      const stored = await store.append(projectId, events);
      return stored.at(-1)?.seq ?? (await store.head(projectId));
    },

    async runAgent(req) {
      const role = roles.get(req.task.role);
      const grants = Object.entries(role?.tools ?? {});
      const [server, grant] = grants[0] ?? ['model', { ops: ['reason'] }];
      if (script.accessDenied?.includes(req.task.taskId) && req.attempt === 1) {
        await store.append(req.projectId, [
          step(req, server, grant.ops[0]!, `${server} returned 403`, 403),
        ]);
        throw ApplicationFailure.create({
          type: ACCESS_DENIED,
          message: `${server} returned 403 for ${grant.ops[0]}. Re-verify the credential's scope in Settings.`,
          nonRetryable: true,
        });
      }
      const ops = grant.ops.slice(0, 2);
      await store.append(
        req.projectId,
        ops.map((op, i) =>
          step(
            req,
            server,
            op,
            `${req.task.title}${req.feedback ? ' (reworked)' : ''}: step ${i + 1} of ${ops.length}`,
          ),
        ),
      );
      const tokens = 5_000 + (hash(req.task.taskId) % 40_000);
      const usd = (tokens / 1_000_000) * (PRICE_PER_MTOK[role?.model.id ?? ''] ?? 3);
      return { tokens, usd, ...(deps.outputs?.[req.task.templateId] ?? {}) };
    },

    async validate(req) {
      const rejections = script.rejectTimes?.[req.task.taskId] ?? 0;
      return req.attempt <= rejections
        ? {
            pass: false,
            reason: 'Hard-coded copy left in the component; move it to datasource fields',
          }
        : { pass: true, reason: null };
    },

    async loadBlueprint() {
      return deps.blueprint;
    },

    // Stub projects have no Leads to ask: every question reaches the Director, as before.
    async triage() {
      return { level: 'ask', tokens: 0, usd: 0 };
    },
    async interpretDirective({ text, blueprint }) {
      if (/^\/?status\b/i.test(text) || /\b(status|where are we)\b/i.test(text))
        return { kind: 'status' };
      const m = /\b(?:skip|drop|remove|exclude)\s+(?:the\s+|all\s+)?(.+?)\.?$/i.exec(text);
      if (!m || !blueprint) return { kind: 'note', interpretation: text.replace(/\.$/, '') };
      const words = m[1]!
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w && !STOPWORDS.has(w))
        .map((w) => w.replace(/s$/, ''));
      const matches = (i: BlueprintItem) =>
        words.every((w) => `${i.key} ${i.name}`.toLowerCase().includes(w));
      let count = 0;
      const collections = Object.fromEntries(
        Object.entries(blueprint.collections).map(([name, items]) => [
          name,
          items.map((i) => {
            if (i.status === 'drop' || !matches(i)) return i;
            count++;
            return { ...i, status: 'drop' as const };
          }),
        ]),
      );
      if (!count)
        return { kind: 'note', interpretation: `nothing in the Blueprint matches "${m[1]}"` };
      return {
        kind: 'replan',
        interpretation: `skip everything matching "${words.join(' ')}"`,
        blueprint: { version: blueprint.version, collections },
      };
    },

    async rollbackTask({ projectId, task }) {
      await store.append(projectId, [
        {
          type: 'step.recorded',
          actor: { kind: 'agent', id: task.role },
          subject: { kind: 'step', id: randomUUID() },
          severity: 'notable',
          data: {
            stepId: randomUUID(),
            agentId: task.role,
            taskId: task.taskId,
            toolServer: 'rollback',
            operation: 'recipe.run',
            resultCode: 200,
            durationMs: 400,
            tokens: 0,
            summary: `Rolled back ${task.title}`,
          },
        },
      ]);
    },
  };
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'all',
  'and',
  'of',
  'page',
  'pages',
  'template',
  'templates',
  'component',
  'components',
]);

function hash(s: string): number {
  return createHash('sha1').update(s).digest().readUInt32BE(0);
}

/** Loads a playbook's demo fixtures (example Blueprint and stub outputs) from `fixtures/`. */
export async function loadFixtures(playbookDir: string) {
  const blueprint = Blueprint.parse(
    parse(await readFile(join(playbookDir, 'fixtures/blueprint.example.yaml'), 'utf8')),
  );
  const outputs = parse(
    await readFile(join(playbookDir, 'fixtures/stub-outputs.yaml'), 'utf8'),
  ) as StubDeps['outputs'];
  return { blueprint, outputs };
}
