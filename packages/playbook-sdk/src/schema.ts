import { AgentTier, Workstream } from '@lw/contracts';
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
  gate: z.enum(['none', 'director']).default('none'),
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
  }),
  phases: z.array(PhaseSpec).min(1),
});
export type PlaybookManifest = z.infer<typeof PlaybookManifest>;
