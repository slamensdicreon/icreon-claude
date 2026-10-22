import type { NewEvent, TaskState } from '@lw/contracts';
import {
  ActivityFailure,
  ApplicationFailure,
  condition,
  proxyActivities,
  setHandler,
} from '@temporalio/workflow';
import type { Activities } from '../activities';
import { cancelTask, pauseTask, resumeTask } from '../definitions';
import {
  ACCESS_DENIED,
  AGENT_FAILED,
  NEEDS_DECISION,
  type AgentDecision,
  type AgentRequest,
  type AgentResult,
  type TaskInput,
  type TaskOutcome,
  type ValidationResult,
} from '../types';

/** A Lead rejects a specialist's output at most twice before the task escalates (requirements §3). */
const MAX_REJECTIONS = 2;

const { emit } = proxyActivities<Activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 10 },
});

const agents = proxyActivities<Activities>({
  startToCloseTimeout: '2 hours',
  heartbeatTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    nonRetryableErrorTypes: [ACCESS_DENIED, NEEDS_DECISION, AGENT_FAILED],
  },
});

/**
 * One task: agent → validate → done, or rejected back to the agent with the Lead's feedback, at
 * most twice; then the parent escalates. Holds at step boundaries while paused. The parent owns
 * planned/ready/blocked/cancelled/rolled_back; this workflow owns the transitions in between.
 */
export async function taskWorkflow(input: TaskInput): Promise<TaskOutcome> {
  const { projectId, task } = input;
  let paused = input.paused;
  let cancelled = false;
  setHandler(pauseTask, () => void (paused = true));
  setHandler(resumeTask, () => void (paused = false));
  setHandler(cancelTask, () => void (cancelled = true));

  let state: TaskState = input.from;
  let attempt = input.attempt;
  const spent: AgentResult = { tokens: 0, usd: 0 };

  const move = async (to: TaskState, reason: string | null = null) => {
    const event: NewEvent = {
      type: 'task.state',
      actor: { kind: 'system', id: 'orchestrator' },
      subject: { kind: 'task', id: task.taskId },
      severity: to === 'rejected' ? 'warning' : to === 'done' ? 'notable' : 'routine',
      data: { taskId: task.taskId, from: state, to, attempt, reason },
    };
    state = to;
    await emit(projectId, [event]);
  };

  /** Step boundary: honour cancel and pause before doing more work. */
  const checkpoint = async (): Promise<boolean> => {
    if (cancelled) return false;
    if (paused) {
      if (state === 'running') await move('paused', 'Paused by the Director');
      await condition(() => !paused || cancelled);
      if (cancelled) return false;
      if (state === 'paused') await move('running', 'Resumed');
    }
    return true;
  };

  let feedback: string | null = null;
  let rejections = 0;
  attempt += 1;
  await move('running', input.from === 'blocked' ? 'Escalation resolved' : null);

  for (;;) {
    if (!(await checkpoint())) return { outcome: 'cancelled', state, attempt, spent };
    const request: AgentRequest = {
      projectId,
      task,
      attempt,
      feedback,
      instructions: input.instructions,
    };
    let result: AgentResult;
    try {
      result = await agents.runAgent(request);
    } catch (err) {
      const cause = err instanceof ActivityFailure ? err.cause : err;
      const message = cause instanceof Error ? cause.message : String(cause);
      const app = cause instanceof ApplicationFailure ? cause : null;
      // Agent failures carry what the session spent, so the budget still counts it.
      const detail = (app?.details?.[0] ?? {}) as { spent?: AgentResult } & Partial<AgentDecision>;
      if (detail.spent) {
        spent.tokens += detail.spent.tokens;
        spent.usd += detail.spent.usd;
      }
      if (app?.type === ACCESS_DENIED) {
        return { outcome: 'access_denied', state, attempt, reason: message, spent };
      }
      if (app?.type === NEEDS_DECISION && detail.question && detail.options && detail.recommended) {
        const decision: AgentDecision = {
          summary: detail.summary ?? message,
          question: detail.question,
          options: detail.options,
          recommended: detail.recommended,
        };
        return { outcome: 'needs_decision', state, attempt, decision, spent };
      }
      return {
        outcome: 'escalate',
        state,
        attempt,
        reason: app?.type === AGENT_FAILED ? message : `Retries exhausted: ${message}`,
        spent,
      };
    }
    spent.tokens += result.tokens;
    spent.usd += result.usd;

    if (!(await checkpoint())) return { outcome: 'cancelled', state, attempt, spent };
    await move('validating');
    const verdict: ValidationResult = await agents.validate({ ...request, result });
    if (verdict.pass) {
      await move('done');
      return {
        outcome: 'done',
        state,
        attempt,
        result: { ...result, tokens: spent.tokens, usd: spent.usd },
      };
    }

    rejections += 1;
    feedback = verdict.reason ?? 'Acceptance criteria not met';
    await move('rejected', `Lead review: ${feedback}`);
    if (rejections > MAX_REJECTIONS) {
      return {
        outcome: 'escalate',
        state,
        attempt,
        reason: `Rejected ${rejections} times: ${feedback}`,
        spent,
      };
    }
    attempt += 1;
    await move('running', `Retry ${rejections} with Lead feedback`);
  }
}
