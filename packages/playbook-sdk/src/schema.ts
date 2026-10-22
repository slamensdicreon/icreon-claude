import { AgentTier, MetricKey, Workstream } from '@lw/contracts';
import { z } from 'zod';

const Kebab = z.string().regex(/^[a-z][a-z0-9-]*$/, 'kebab-case');

export const ToolGrant = z.object({
  /** Operations from the tool server's catalog, e.g. `item.create`. */
  ops: z.array(z.string().min(1)).min(1),
  /** Resource scope enforced by the tool gateway. `{module}`, `{project}`, `{sitePath}` are bound per project. */
  scope: z.object({ paths: z.array(z.string()).min(1) }).optional(),
});
export type ToolGrant = z.infer<typeof ToolGrant>;

export const RoleDef = z.object({
  role: Kebab,
  name: z.string(),
  /** The person the role is shown as in the Control Center. */
  persona: z.string().optional(),
  /** What the role does, in plain words for the Director. */
  description: z.string().optional(),
  tier: AgentTier,
  /** Role id of the manager; null only for the Chief of Staff. */
  reportsTo: Kebab.nullable(),
  workstream: Workstream.nullable(),
  runtime: z.enum(['messages', 'agent-sdk']).default('messages'),
  model: z.object({
    id: z.string(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  }),
  /** Path relative to the playbook root. Prompts land with the agent runtime (M3). */
  systemPrompt: z.string().optional(),
  mandate: z.string(),
  produces: z.array(z.string()).default([]),
  skills: z.array(Kebab).default([]),
  tools: z.record(Kebab, ToolGrant).default({}),
  acceptance: z.array(z.string()).default([]),
  escalateWhen: z.array(z.string()).default([]),
  budget: z
    .object({ tokens: z.number().int().positive(), wallclock: z.string().regex(/^\d+[mh]$/) })
    .optional(),
  /** Phases in which the role is instantiated. Chief of Staff and Leads are always resident. */
  activePhases: z.union([z.literal('all'), z.array(z.number().int().min(0))]),
});
export type RoleDef = z.infer<typeof RoleDef>;

export const PhaseSpec = z.object({
  number: z.number().int().min(0),
  name: z.string(),
  /** One word for the status strip and stepper ("Components"). */
  shortName: z.string().optional(),
  gate: z.enum(['none', 'director']).default('none'),
  /** How the gate reads on the plan ("Gate 1: Director approves the Blueprint"). */
  gateLabel: z.string().optional(),
  /** Optional gates the Director may switch on in Settings (e.g. review after the pilot slice). */
  optionalGates: z.array(z.string()).default([]),
  /** Phases that must be done before this one starts. Defaults to the previous phase. */
  dependsOn: z.array(z.number().int()).optional(),
  exitCriteria: z.string(),
});
export type PhaseSpec = z.infer<typeof PhaseSpec>;

export const PlaybookManifest = z.object({
  id: Kebab,
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/, 'semver'),
  name: z.string(),
  description: z.string(),
  defaults: z.object({
    concurrency: z.number().int().positive(),
    budgets: z.object({
      tokens: z.number().int().positive(),
      usd: z.number().positive(),
      hours: z.number().positive(),
    }),
    escalationDeadlines: z.record(z.string(), z.string().regex(/^\d+[mh]$/)),
    /** How each escalation type behaves without an answer, and who hears about it. */
    escalationPolicy: z
      .record(
        z.string(),
        z.object({
          default: z.boolean(),
          behaviour: z.string(),
          notifies: z.string(),
        }),
      )
      .default({}),
    /** Mission Control stat cards when a project doesn't set its own. */
    stats: z
      .array(z.object({ metric: MetricKey, label: z.string(), icon: z.string(), note: z.string() }))
      .default([]),
    /** Tool server display names for Activity. */
    toolLabels: z.record(z.string(), z.string()).default({}),
  }),
  phases: z.array(PhaseSpec).min(1),
});
export type PlaybookManifest = z.infer<typeof PlaybookManifest>;

/**
 * A task template in `plan.yaml`. The plan compiler expands it into concrete tasks: once, or once per
 * item of a Blueprint collection (`forEach`). Ids interpolate `{key}`, titles interpolate `{name}`;
 * both stay stable across re-plans so task history survives a directive.
 */
export const TaskTemplate = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(\{key\}[a-z0-9-]*)?$/, 'kebab-case, optionally with {key}'),
  phase: z.number().int().min(0),
  role: Kebab,
  title: z.string(),
  /** Name of a Blueprint collection. Without it the template yields exactly one task. */
  forEach: Kebab.optional(),
  /**
   * Dispatch hint: up to this many ready tasks from the template may run in one agent session.
   * Planning stays per item, so dropping one page changes exactly one task.
   */
  batchSize: z.number().int().positive().optional(),
  /**
   * Task ids this task waits on. `{key}` binds to the same item; a trailing `*` matches every task
   * whose id starts with the prefix (e.g. `register-*`).
   */
  dependsOn: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
  /** Count metric this template's completed tasks drive, against the template's task total. */
  metric: MetricKey.optional(),
  /** Working hours one task takes, for the forecast. */
  estimate: z.number().positive().optional(),
  /** Engagement-view row the template's tasks roll up into. Defaults to the title, sans item. */
  activity: z.string().optional(),
  /** The task contract the inspector shows; `{name}` interpolates the item name. */
  contract: z
    .object({
      inputs: z.string(),
      outputs: z.string(),
      acceptance: z.string().optional(),
      rollback: z.string(),
      maxAttempts: z.number().int().positive().default(3),
    })
    .optional(),
});
export type TaskTemplate = z.infer<typeof TaskTemplate>;

export const PlanSpec = z.object({
  templates: z.array(TaskTemplate).min(1),
  /**
   * Pilot slice: tasks for the collection's non-pilot items in `phase` wait on a checkpoint that
   * waits on every pilot item's tasks. With `optionalGate` switched on, the checkpoint is a
   * Director gate.
   */
  pilot: z
    .object({ phase: z.number().int(), collection: Kebab, optionalGate: z.string().optional() })
    .optional(),
});
export type PlanSpec = z.infer<typeof PlanSpec>;
