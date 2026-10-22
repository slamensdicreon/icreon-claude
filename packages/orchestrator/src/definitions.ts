// Workflow messages. Imported by the workflows and by the client, so it must stay workflow-safe.
import type { Control } from '@lw/contracts';
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

/** Parent → task child: hold at the next step boundary, carry on, or stop. */
export const pauseTask = defineSignal('pauseTask');
export const resumeTask = defineSignal('resumeTask');
export const cancelTask = defineSignal('cancelTask');
