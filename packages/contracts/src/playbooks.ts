import { z } from 'zod';

/**
 * What the New Project wizard shows about each playbook: what the team delivers (the charter),
 * and what intake collects. Field and credential specs come from the playbook's platform pack;
 * the playbook chooses which ones, in which steps.
 */

export const OutcomeSpec = z.object({
  id: z.string(),
  title: z.string(),
  /** How the outcome is judged: the evidence Gate 2 or the cycle review looks for. */
  measure: z.string(),
});
export type OutcomeSpec = z.infer<typeof OutcomeSpec>;

export const Charter = z.object({
  /** What the team is for, in one or two sentences. */
  mission: z.string(),
  outcomes: z.array(OutcomeSpec).min(1),
});
export type Charter = z.infer<typeof Charter>;

export const IntakeFieldSpec = z.object({
  key: z.string(),
  label: z.string(),
  /** `list`: comma-separated values. `slug`: lowercase letters, digits and dashes. */
  kind: z.enum(['text', 'list', 'slug']),
  required: z.boolean(),
  placeholder: z.string().nullable(),
  hint: z.string().nullable(),
  /** A JavaScript regular expression the whole value must match. */
  pattern: z.string().nullable(),
  defaultValue: z.string().nullable(),
  /** Prefilled from another wizard value, slugged (a hosting project from the project name). */
  defaultFrom: z.enum(['name']).nullable(),
});
export type IntakeFieldSpec = z.infer<typeof IntakeFieldSpec>;

export const IntakeCredentialSpec = z.object({
  credentialId: z.string(),
  /** What Settings calls it ("SitecoreAI environment client"). */
  system: z.string(),
  /** Where to get it, for the wizard. */
  description: z.string().nullable(),
  required: z.boolean(),
  fields: z.array(z.object({ key: z.string(), label: z.string(), secret: z.boolean() })),
  /** Target fields its check needs; editing one clears the check. */
  uses: z.array(z.string()),
});
export type IntakeCredentialSpec = z.infer<typeof IntakeCredentialSpec>;

export const Presence = z.enum(['required', 'optional', 'none']);

/**
 * A brief question: what the client wants beyond access (rights, editorial needs, integrations,
 * budgets). Every agent sees the answers; a `feature` question switches plan tasks on.
 */
export const BriefQuestion = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['text', 'yesno', 'choice']),
  options: z.array(z.string()).default([]),
  required: z.boolean().default(false),
  hint: z.string().nullable().default(null),
  placeholder: z.string().nullable().default(null),
  /** A yes switches this project feature on (plan templates with `when` need it). */
  feature: z.string().nullable().default(null),
});
export type BriefQuestion = z.infer<typeof BriefQuestion>;

export const IntakeSpec = z.object({
  source: z.object({
    repo: Presence,
    url: Presence,
    intro: z.string().nullable(),
  }),
  steps: z.array(
    z.object({
      title: z.string(),
      intro: z.string().nullable(),
      fields: z.array(IntakeFieldSpec),
      credentials: z.array(IntakeCredentialSpec),
    }),
  ),
  brief: z.array(BriefQuestion).default([]),
});
export type IntakeSpec = z.infer<typeof IntakeSpec>;

/** GET /playbooks — one entry per playbook a new project can run. */
export const PlaybookSummary = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  platform: z.object({ id: z.string(), name: z.string() }),
  charter: Charter,
  intake: IntakeSpec,
  /** The engagement's phases in order, with the Director's gates. */
  phases: z
    .array(z.object({ number: z.number().int(), name: z.string(), gate: z.string().nullable() }))
    .default([]),
  /** The team: each role's name and what it does. */
  roles: z
    .array(
      z.object({ role: z.string(), name: z.string(), tier: z.string(), description: z.string() }),
    )
    .default([]),
});
export type PlaybookSummary = z.infer<typeof PlaybookSummary>;
