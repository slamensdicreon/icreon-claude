import type { NewEvent } from '@lw/contracts';
import type { Blueprint, PlannedTask } from '@lw/plan';
import type { AgentRequest, AgentResult, DirectiveInterpretation, ValidationResult } from './types';

/**
 * Everything a workflow needs from the outside world. Workflows import this type only; the worker
 * binds an implementation (stub agents today, the agent runtime and tool gateway later).
 */
export interface Activities {
  /** Appends events to the project's log. Returns the seq of the last one. */
  emit(projectId: string, events: NewEvent[]): Promise<number>;
  /** Runs one agent session for a task. Records its own steps. Throws `AccessDenied` on 401/403. */
  runAgent(req: AgentRequest): Promise<AgentResult>;
  /** The task's acceptance validators plus Lead review. */
  validate(req: AgentRequest & { result: AgentResult }): Promise<ValidationResult>;
  /** The Blueprint the Solution Architect wrote, as of now. */
  loadBlueprint(projectId: string): Promise<Blueprint>;
  /** Chief of Staff: turns a Director message into a status request, a note, or a re-plan. */
  interpretDirective(req: {
    projectId: string;
    text: string;
    blueprint: Blueprint | null;
  }): Promise<DirectiveInterpretation>;
  /** Runs the task's rollback recipe (delete created items, revert its commit). */
  rollbackTask(req: { projectId: string; task: PlannedTask }): Promise<void>;
}
