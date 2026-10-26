import type { Budgets, Control, EscalationType } from '@lw/contracts';
import { CommandError } from '@lw/domain';
import type { Playbook } from '@lw/playbook-sdk';
import { ApplicationFailure } from '@temporalio/common';
import { WorkflowNotFoundError, WorkflowUpdateFailedError, type Client } from '@temporalio/client';
import {
  changeBudgets,
  control,
  deferEscalation,
  postMessage,
  resolveEscalation,
  stopDirective,
  undoResolution,
} from './definitions';
import { taskQueueFor, type ProjectInput, type ProjectPolicy } from './types';

export const projectWorkflowId = (projectId: string) => `project:${projectId}`;

/** Policy from the playbook's defaults; Settings overrides land here later. */
export function defaultPolicy(
  playbook: Playbook,
  overrides: Partial<ProjectPolicy> = {},
): ProjectPolicy {
  const { defaults } = playbook.manifest;
  const deadlines: Partial<Record<EscalationType, number>> = {};
  for (const [type, d] of Object.entries(defaults.escalationDeadlines)) {
    deadlines[type as EscalationType] = durationMs(d);
  }
  return {
    concurrency: defaults.concurrency,
    budgets: defaults.budgets,
    enabledGates: [],
    escalationDeadlinesMs: deadlines,
    directiveWindowMs: 30_000,
    undoWindowMs: 10_000,
    ...overrides,
  };
}

export function durationMs(d: string): number {
  const m = /^(\d+)([mh])$/.exec(d);
  if (!m) throw new Error(`Bad duration "${d}"`);
  return Number(m[1]) * (m[2] === 'h' ? 3_600_000 : 60_000);
}

export async function startProject(
  client: Client,
  input: ProjectInput,
  taskQueue = taskQueueFor(input.playbook.manifest.id),
) {
  return client.workflow.start('projectWorkflow', {
    taskQueue,
    workflowId: projectWorkflowId(input.projectId),
    args: [input],
  });
}

/**
 * Stops a project's workflow and its running tasks for good (a reset). A workflow that already
 * ended, or never started, is fine.
 */
export async function stopProject(client: Client, projectId: string, reason: string) {
  try {
    await client.workflow.getHandle(projectWorkflowId(projectId)).terminate(reason);
  } catch (err) {
    if (err instanceof WorkflowNotFoundError) return;
    throw err;
  }
}

const STATUS: Record<string, 404 | 409 | 422> = {
  not_found: 404,
  conflict: 409,
  invalid: 422,
  not_supported: 422,
};

/**
 * Director commands for one project, sent as Temporal updates. A validator's refusal becomes a
 * CommandError with the workflow's own message, so the API answers with the same words.
 */
export class ProjectCommandsClient {
  constructor(
    private readonly client: Client,
    readonly projectId: string,
  ) {}

  private get handle() {
    return this.client.workflow.getHandle(projectWorkflowId(this.projectId));
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const cause = err instanceof WorkflowUpdateFailedError ? err.cause : null;
      if (cause instanceof ApplicationFailure && cause.type && STATUS[cause.type]) {
        throw new CommandError(STATUS[cause.type]!, cause.type, cause.message);
      }
      throw err;
    }
  }

  resolve(
    escalationId: string,
    optionId: string,
    notes: string | null = null,
    confirmation?: string,
  ) {
    return this.run(() =>
      this.handle.executeUpdate(resolveEscalation, {
        args: [{ escalationId, optionId, notes, confirmation }],
      }),
    );
  }

  defer(escalationId: string, until: Date) {
    return this.run(() =>
      this.handle.executeUpdate(deferEscalation, {
        args: [{ escalationId, until: until.toISOString() }],
      }),
    );
  }

  undo(escalationId: string) {
    return this.run(() => this.handle.executeUpdate(undoResolution, { args: [{ escalationId }] }));
  }

  postMessage(body: string) {
    return this.run(() => this.handle.executeUpdate(postMessage, { args: [{ body }] }));
  }

  stopDirective(directiveId: string) {
    return this.run(() => this.handle.executeUpdate(stopDirective, { args: [{ directiveId }] }));
  }

  control(cmd: Control) {
    return this.run(() => this.handle.executeUpdate(control, { args: [cmd] }));
  }

  changeBudgets(budgets: Budgets) {
    return this.run(() => this.handle.executeUpdate(changeBudgets, { args: [budgets] }));
  }
}
