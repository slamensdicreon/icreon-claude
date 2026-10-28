import type { Budgets, Control, EscalationType } from '@lw/contracts';
import { CommandError } from '@lw/domain';
import type { Playbook } from '@lw/playbook-sdk';
import { ApplicationFailure } from '@temporalio/common';
import { WorkflowNotFoundError, WorkflowUpdateFailedError, type Client } from '@temporalio/client';
import {
  changeBudgets,
  rerunTask,
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
      // The workflow can't take commands while its last step failed: say so, not "unexpected".
      if (
        String((err as Error)?.message ?? '').includes('Workflow Task in failed state') ||
        String((err as { cause?: Error })?.cause?.message ?? '').includes(
          'Workflow Task in failed state',
        )
      )
        throw new CommandError(
          503,
          'orchestrator_stalled',
          `This project's orchestrator is stuck on a failed step, so it can't take commands. Details: /projects/${this.projectId}/diagnostics`,
        );
      throw err;
    }
  }

  /**
   * The project workflow's health, read-only: its status, the last failed steps (with their error
   * and stack) and the latest events, for diagnosing a stuck project.
   */
  async diagnose() {
    const d = await this.handle.describe();
    const res = await this.client.workflowService.getWorkflowExecutionHistoryReverse({
      namespace: this.client.options.namespace,
      execution: { workflowId: d.workflowId, runId: d.runId },
      maximumPageSize: 300,
    });
    const events = res.history?.events ?? [];
    const time = (t?: { seconds?: unknown; nanos?: number | null } | null) =>
      t?.seconds != null ? new Date(Number(t.seconds) * 1000).toISOString() : null;
    const kind = (e: (typeof events)[number]) =>
      Object.keys(e).find(
        (k) => k.endsWith('EventAttributes') && (e as Record<string, unknown>)[k],
      ) ?? '';
    return {
      workflowId: d.workflowId,
      status: d.status.name,
      historyLength: d.historyLength,
      failures: events
        .filter((e) => e.workflowTaskFailedEventAttributes)
        .slice(0, 3)
        .map((e) => ({
          event: String(e.eventId),
          at: time(e.eventTime),
          cause: e.workflowTaskFailedEventAttributes!.cause,
          message: e.workflowTaskFailedEventAttributes!.failure?.message ?? null,
          stack: (e.workflowTaskFailedEventAttributes!.failure?.stackTrace ?? '').slice(0, 4000),
        })),
      recent: events.slice(0, 40).map((e) => ({
        event: String(e.eventId),
        at: time(e.eventTime),
        type: kind(e).replace(/EventAttributes$/, ''),
        detail:
          e.activityTaskScheduledEventAttributes?.activityType?.name ??
          e.workflowExecutionUpdateAcceptedEventAttributes?.acceptedRequest?.input?.name ??
          e.markerRecordedEventAttributes?.markerName ??
          e.startChildWorkflowExecutionInitiatedEventAttributes?.workflowId ??
          null,
      })),
    };
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

  rerunTask(taskId: string, instructions: string) {
    return this.run(() =>
      this.handle.executeUpdate(rerunTask, { args: [{ taskId, instructions }] }),
    );
  }
}
