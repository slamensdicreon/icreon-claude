// Workflow messages. Imported by the workflows and by the client, so it must stay workflow-safe.
import type { Budgets, Control } from '@lw/contracts';
import { defineSignal, defineUpdate } from '@temporalio/workflow';

export interface CommandAck {
  accepted: true;
}

export const resolveEscalation = defineUpdate<
  CommandAck,
  [{ escalationId: string; optionId: string; notes?: string | null; confirmation?: string }]
>('resolveEscalation');

export const deferEscalation = defineUpdate<CommandAck, [{ escalationId: string; until: string }]>(
  'deferEscalation',
);

export const postMessage = defineUpdate<CommandAck, [{ body: string }]>('postMessage');

export const stopDirective = defineUpdate<CommandAck, [{ directiveId: string }]>('stopDirective');

export const control = defineUpdate<CommandAck, [Control]>('control');

/** New limits for the project's spend; a project the hard stop paused resumes if they cover it. */
export const changeBudgets = defineUpdate<CommandAck, [Budgets]>('changeBudgets');

/** Takes back a reversible choice while its undo window is open; the card re-opens. */
export const undoResolution = defineUpdate<CommandAck, [{ escalationId: string }]>(
  'undoResolution',
);

/** Parent → task child: hold at the next step boundary, carry on, or stop. */
export const pauseTask = defineSignal('pauseTask');
export const resumeTask = defineSignal('resumeTask');
/** With a task id, cancels that task in a batch; without, the whole child. */
export const cancelTask = defineSignal<[taskId?: string]>('cancelTask');
