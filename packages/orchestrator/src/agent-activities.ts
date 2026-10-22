import type { RunOutcome, RunRequest } from '@lw/agent-runtime';
import { MetricKey } from '@lw/contracts';
import { ApplicationFailure } from '@temporalio/activity';
import type { Activities } from './activities';
import { ACCESS_DENIED, AGENT_FAILED, NEEDS_DECISION, type AgentResult } from './types';

/** Anything that runs one agent session for a task: the AgentRuntime, or a test double. */
export interface AgentRunner {
  run(req: RunRequest): Promise<RunOutcome>;
}

/**
 * Swaps the stub agents for real ones: runAgent goes to the agent runtime; the other activities
 * stay as given. Outcomes the workflow must act on travel as typed, non-retryable failures that
 * carry what the session spent.
 */
export function withAgentRunner(
  base: Activities,
  runner: AgentRunner,
  /** Roles that run on the real runtime; everyone else keeps the base (stub) agents. */
  only: (role: string) => boolean = () => true,
): Activities {
  return {
    ...base,
    async runAgent(req): Promise<AgentResult> {
      if (!only(req.task.role)) return base.runAgent(req);
      const out = await runner.run(req);
      const spent = { tokens: out.spent.tokens, usd: out.spent.usd };
      switch (out.kind) {
        case 'done': {
          const metrics: AgentResult['metrics'] = {};
          for (const [k, v] of Object.entries(out.metrics)) {
            const key = MetricKey.safeParse(k);
            if (key.success) metrics[key.data] = v;
          }
          return { ...spent, metrics };
        }
        case 'needs_decision':
          throw ApplicationFailure.create({
            type: NEEDS_DECISION,
            message: out.decision.question,
            nonRetryable: true,
            details: [{ spent, summary: out.summary, ...out.decision }],
          });
        case 'access_denied':
          throw ApplicationFailure.create({
            type: ACCESS_DENIED,
            message: out.message,
            nonRetryable: true,
            details: [{ spent }],
          });
        case 'failed':
          throw ApplicationFailure.create({
            type: AGENT_FAILED,
            message: out.reason,
            nonRetryable: true,
            details: [{ spent }],
          });
      }
    },
  };
}
