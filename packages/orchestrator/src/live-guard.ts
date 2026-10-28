import { randomUUID } from 'node:crypto';
import type { EventStore } from '@lw/events';
import { ApplicationFailure } from '@temporalio/activity';
import type { Activities } from './activities';
import type { AgentRequest } from './types';
import { NOT_CONNECTED } from './types';

export interface LiveGuardOptions {
  store: EventStore;
  /** True for a real engagement (from the New Project wizard); false for demos and simulations. */
  isLive(projectId: string): Promise<boolean>;
  /**
   * Operations the task's role is granted that no connected tool server provides
   * ("github.repo.read"), limited to the servers the task uses.
   */
  missing(task: AgentRequest['task']): string[];
  /** Display name of a role, for the Activity line. */
  roleName(role: string): string;
}

/**
 * Real engagements never fall back to stand-ins. A task whose role isn't fully connected does not
 * run: it blocks with a "not connected" card naming what is missing, and a rollback with no recipe
 * says that nothing was undone. Demo and simulated projects keep the base activities.
 */
export function withLiveGuard(base: Activities, opts: LiveGuardOptions): Activities {
  return {
    ...base,
    async runAgent(req) {
      const missing = opts.missing(req.task);
      if (!missing.length || !(await opts.isLive(req.projectId))) return base.runAgent(req);
      const reason = `${opts.roleName(req.task.role)} needs tools that aren't connected yet (${missing.join(', ')}). Nothing was run.`;
      await opts.store.append(req.projectId, [
        {
          type: 'step.recorded',
          actor: { kind: 'agent', id: req.task.role },
          subject: { kind: 'step', id: randomUUID() },
          severity: 'warning',
          data: {
            stepId: randomUUID(),
            agentId: req.task.role,
            taskId: req.task.taskId,
            toolServer: 'gateway',
            operation: 'connect',
            resultCode: 503,
            durationMs: 0,
            tokens: 0,
            summary: `Not run: ${missing.join(', ')} not connected`,
          },
        },
      ]);
      throw ApplicationFailure.create({
        type: NOT_CONNECTED,
        message: reason,
        nonRetryable: true,
        details: [{ spent: { tokens: 0, usd: 0 } }],
      });
    },

    async rollbackTask(req) {
      if (!(await opts.isLive(req.projectId))) return base.rollbackTask(req);
      await opts.store.append(req.projectId, [
        {
          type: 'step.recorded',
          actor: { kind: 'agent', id: req.task.role },
          subject: { kind: 'step', id: randomUUID() },
          severity: 'warning',
          data: {
            stepId: randomUUID(),
            agentId: req.task.role,
            taskId: req.task.taskId,
            toolServer: 'rollback',
            operation: 'recipe.run',
            resultCode: 501,
            durationMs: 0,
            tokens: 0,
            summary: `No rollback recipe is connected for ${req.task.title}: nothing was undone`,
          },
        },
      ]);
    },
  };
}
