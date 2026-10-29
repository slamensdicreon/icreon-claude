import { randomUUID } from 'node:crypto';
import type {
  BetaContentBlock,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { EventStore } from '@lw/events';
import type { PlannedTask } from '@lw/plan';
import type { Playbook, RoleDef } from '@lw/playbook-sdk';
import type { ToolGateway } from '@lw/tool-gateway';
import {
  emptyContext,
  promptVersion,
  rolePrompt,
  systemBlocks,
  taskBrief,
  type ContextProvider,
} from './context';
import type { ModelClient } from './model';
import { costOf, type Spend } from './pricing';
import { SUBMIT, SubmitInput, toolsFor } from './tools';

export interface RunRequest {
  projectId: string;
  task: PlannedTask;
  attempt: number;
  feedback: string | null;
  instructions: string | null;
}

export type RunOutcome =
  | { kind: 'done'; summary: string; metrics: Record<string, number>; spent: Spend }
  | {
      kind: 'needs_decision';
      summary: string;
      decision: NonNullable<SubmitInput['decision']>;
      spent: Spend;
    }
  | {
      kind: 'waiting';
      summary: string;
      waitingOn: {
        taskIds: string[];
        sendBack?: { taskId: string; fixes: string }[];
        what: string;
      };
      spent: Spend;
    }
  | { kind: 'capability_gap'; summary: string; capability: string; spent: Spend }
  | { kind: 'access_denied'; message: string; spent: Spend }
  | { kind: 'failed'; reason: string; spent: Spend };

export interface RuntimeDeps {
  model: ModelClient;
  gateway: ToolGateway;
  playbook: Playbook;
  store: EventStore;
  context?: ContextProvider;
  /** The team plan for a task's brief: the other unfinished tasks, so it can name what it waits on. */
  board?(projectId: string, task: PlannedTask): Promise<string | null>;
  /** The approved Blueprint's entries for the task's items (a page's URL, a media file's source). */
  items?(projectId: string, task: PlannedTask): Promise<string | null>;
  /** System prompt text for a role, from the playbook's prompts folder; null to derive one. */
  prompt?: (role: RoleDef) => string | null;
  /**
   * Tool servers with nothing behind them on this project (no source repository: github). Their
   * operations are left out of the agent's tools, so it never reaches for them.
   */
  unavailable?(projectId: string): Promise<string[]>;
  maxTurns?: number;
  maxTokensPerTurn?: number;
}

const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_TOKENS = 16_000;
const CEILING_MAX_TOKENS = 64_000;

/** Server-side refusal fallback. Haiku 5.5 has none; the others take the "default" router. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const supportsFallback = (model: string) => model !== 'claude-haiku-5-5';

/**
 * The `messages` agent runtime: one agent session for one task. A manual loop over the Messages
 * API so every turn is visible to us: each model turn and each tool call is a Step in the log,
 * tool calls go through the gateway (never directly to a system), and the role's token budget
 * is enforced between turns. Ends when the agent calls submit_result, or on refusal, access
 * failure, budget or turn limit.
 */
export class AgentRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  async run(req: RunRequest): Promise<RunOutcome> {
    const { deps } = this;
    const role = deps.playbook.roles.find((r) => r.role === req.task.role);
    const zero = { tokens: 0, usd: 0 };
    if (!role)
      return { kind: 'failed', reason: `No role "${req.task.role}" in the playbook.`, spent: zero };

    const system = systemBlocks(
      rolePrompt(role, deps.prompt?.(role) ?? null, deps.playbook.manifest.charter),
      await (deps.context ?? emptyContext).forTask(req.projectId, req.task),
    );
    const version = promptVersion(system);
    const { tools, route } = toolsFor(
      role.role,
      deps.gateway,
      new Set((await deps.unavailable?.(req.projectId)) ?? []),
    );
    const model = role.model.id;
    const budget = role.budget?.tokens ?? Infinity;
    const spent: Spend = { tokens: 0, usd: 0 };
    const board = (await deps.board?.(req.projectId, req.task)) ?? null;
    const items = (await deps.items?.(req.projectId, req.task)) ?? null;
    const messages: BetaMessageParam[] = [
      { role: 'user', content: taskBrief({ ...req, board, items }) },
    ];
    let stepIndex = 0;
    let maxTokens = deps.maxTokensPerTurn ?? DEFAULT_MAX_TOKENS;

    for (let turn = 1; turn <= (deps.maxTurns ?? DEFAULT_MAX_TURNS); turn++) {
      if (spent.tokens >= budget) {
        return {
          kind: 'failed',
          reason: `Token budget of ${budget.toLocaleString('en-US')} exhausted.`,
          spent,
        };
      }
      const params: MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        system,
        tools,
        messages,
        output_config: { effort: role.model.effort },
        // Caches the conversation so far; the system breakpoint above covers cross-task reuse.
        cache_control: { type: 'ephemeral' },
        ...(supportsFallback(model)
          ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const }
          : {}),
      };
      const response = await deps.model.create(params);
      const cost = costOf(response.model || model, response.usage);
      spent.tokens += cost.tokens;
      spent.usd += cost.usd;
      await this.recordTurn(
        req,
        role,
        turn,
        response.stop_reason,
        cost.tokens,
        response.usage.cache_read_input_tokens ?? 0,
        version,
      );

      switch (response.stop_reason) {
        case 'refusal':
          return {
            kind: 'failed',
            reason: 'The model declined this request; it needs a person to look at it.',
            spent,
          };
        case 'model_context_window_exceeded':
          return { kind: 'failed', reason: 'The task outgrew the context window.', spent };
        case 'max_tokens':
          // A tool input cut off mid-way must not run. Retry the same turn with more room.
          if (maxTokens >= CEILING_MAX_TOKENS) {
            return { kind: 'failed', reason: 'Responses keep hitting the output limit.', spent };
          }
          maxTokens = Math.min(CEILING_MAX_TOKENS, maxTokens * 2);
          continue;
        case 'pause_turn':
          messages.push({ role: 'assistant', content: response.content });
          continue;
      }

      const uses = response.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
      if (!uses.length) {
        // Ended without submit_result: take the final text as the summary.
        return {
          kind: 'done',
          summary: finalText(response.content) || 'Finished without a summary.',
          metrics: {},
          spent,
        };
      }
      messages.push({ role: 'assistant', content: response.content });

      const results: BetaToolResultBlockParam[] = [];
      let submitted: SubmitInput | null = null;
      for (const use of uses) {
        if (use.name === SUBMIT) {
          const parsed = SubmitInput.safeParse(use.input);
          if (
            !parsed.success ||
            (parsed.data.status === 'needs_decision' && !parsed.data.decision) ||
            (parsed.data.status === 'waiting' && !parsed.data.waitingOn) ||
            (parsed.data.status === 'capability_gap' && !parsed.data.gap)
          ) {
            results.push({
              type: 'tool_result',
              tool_use_id: use.id,
              is_error: true,
              content:
                'Invalid submit_result: needs status and summary, a decision when status is needs_decision, waitingOn when status is waiting, and gap when status is capability_gap.',
            });
          } else {
            submitted = parsed.data;
            results.push({ type: 'tool_result', tool_use_id: use.id, content: 'Received.' });
          }
          continue;
        }
        const target = route.get(use.name);
        if (!target) {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: `Unknown tool ${use.name}.`,
          });
          continue;
        }
        const r = await deps.gateway.call({
          projectId: req.projectId,
          taskId: req.task.taskId,
          stepIndex: ++stepIndex,
          attempt: req.attempt,
          role: role.role,
          server: target.server,
          op: target.op,
          args: (use.input ?? {}) as Record<string, unknown>,
        });
        if (!r.ok && 'code' in r && (r.code === 401 || r.code === 403)) {
          return { kind: 'access_denied', message: r.message, spent };
        }
        results.push(
          r.ok
            ? { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(r.body) }
            : { type: 'tool_result', tool_use_id: use.id, is_error: true, content: r.message },
        );
      }

      if (submitted) {
        if (submitted.status === 'done')
          return {
            kind: 'done',
            summary: submitted.summary,
            metrics: submitted.metrics ?? {},
            spent,
          };
        if (submitted.status === 'capability_gap')
          return {
            kind: 'capability_gap',
            summary: submitted.summary,
            capability: submitted.gap!.capability,
            spent,
          };
        if (submitted.status === 'waiting')
          return {
            kind: 'waiting',
            summary: submitted.summary,
            waitingOn: submitted.waitingOn!,
            spent,
          };
        return {
          kind: 'needs_decision',
          summary: submitted.summary,
          decision: submitted.decision!,
          spent,
        };
      }
      // Every tool_use gets its result, all in one user message.
      messages.push({ role: 'user', content: results });
    }
    return {
      kind: 'failed',
      reason: `Stopped after ${deps.maxTurns ?? DEFAULT_MAX_TURNS} turns without finishing.`,
      spent,
    };
  }

  private async recordTurn(
    req: RunRequest,
    role: RoleDef,
    turn: number,
    stop: string | null,
    tokens: number,
    cacheRead: number,
    version: string,
  ) {
    await this.deps.store.append(req.projectId, [
      {
        type: 'step.recorded',
        actor: { kind: 'agent', id: role.role },
        subject: { kind: 'step', id: randomUUID() },
        severity: stop === 'refusal' ? 'warning' : 'routine',
        data: {
          stepId: randomUUID(),
          agentId: role.role,
          taskId: req.task.taskId,
          toolServer: 'model',
          operation: role.model.id,
          resultCode: 200,
          durationMs: 0,
          tokens,
          summary: `Turn ${turn}: ${stop ?? 'no stop reason'} · ${cacheRead.toLocaleString('en-US')} cached tokens · prompt ${version}`,
          requestHash: version,
        },
      },
    ]);
  }
}

function finalText(content: BetaContentBlock[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text: string }).text)
    .join('\n')
    .trim();
}
