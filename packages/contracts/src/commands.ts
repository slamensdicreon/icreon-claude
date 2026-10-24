import { z } from 'zod';
import { ControlVerb, ScopeKind } from './enums';

/**
 * POST /projects — intake. `sourceUrl` is the live site being migrated; the crawl tools may only
 * reach its host.
 */
export const CreateProject = z.object({
  name: z.string().min(1).max(120),
  client: z.string().min(1).max(120),
  sourceUrl: z.url({ protocol: /^https?$/ }).optional(),
  /** The source repository, "owner/name", when the source is code rather than a live site. */
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name')
    .optional(),
});
export type CreateProject = z.infer<typeof CreateProject>;

const Repo = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name');
const Branch = z.string().trim().min(1).max(200);
const Secret = z.record(z.string().max(60), z.string().trim().max(2000));
const TargetValues = z.record(
  z.string().max(60),
  z.union([z.string().trim().max(500), z.array(z.string().trim().max(100)).max(50)]),
);

/**
 * POST /intake/verify — checks one credential against the live service before anything is stored:
 * a credential the playbook's platform declares (with the target values its check needs), or
 * GitHub access to the source repository.
 */
export const VerifyIntakeCredential = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('credential'),
    playbookId: z.string(),
    credentialId: z.string(),
    secret: Secret,
    target: TargetValues.default({}),
  }),
  z.object({ kind: z.literal('github.repo'), repo: Repo, branch: Branch.default('main') }),
]);
export type VerifyIntakeCredential = z.infer<typeof VerifyIntakeCredential>;

export const VerifyIntakeResult = z.object({
  ok: z.boolean(),
  detail: z.string(),
  sites: z.array(z.string()).default([]),
  expiresAt: z.iso.datetime().nullable().default(null),
});
export type VerifyIntakeResult = z.infer<typeof VerifyIntakeResult>;

/**
 * POST /projects — the New Project wizard. The playbook decides what else is collected: whether
 * there is a source repository and site, which target values, and which credentials (all
 * declared by its platform pack and checked against it on the server). Secrets are sealed in the
 * vault on arrival; the event log only ever records references.
 */
export const ProjectIntake = z.object({
  playbookId: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  client: z.string().trim().min(1).max(120),
  timezone: z.string().min(1).max(64).default('America/New_York'),
  budgets: z.object({
    usd: z.number().positive().max(1_000_000),
    tokens: z.number().int().positive(),
    hours: z.number().positive().max(10_000),
  }),
  source: z
    .object({
      repo: Repo.nullable().default(null),
      branch: Branch.default('main'),
      url: z
        .url({ protocol: /^https?$/ })
        .nullable()
        .default(null),
    })
    .default({ repo: null, branch: 'main', url: null }),
  target: TargetValues.default({}),
  /** Keyed by the platform's credential id; values are that credential's fields. */
  credentials: z.record(z.string().max(60), Secret).default({}),
  /** Answers to the playbook's brief, by question key ("yes"/"no" for yes-no questions). */
  brief: z.record(z.string().max(60), z.string().trim().max(2000)).default({}),
});
export type ProjectIntake = z.infer<typeof ProjectIntake>;
export type ProjectIntakeInput = z.input<typeof ProjectIntake>;

/** POST /projects/:id/messages — a directive or a question for Cypher. */
export const PostMessage = z.object({
  body: z.string().min(1).max(8000),
  /** Escalation id when asked from a card ("Ask a question"). */
  about: z.string().optional(),
});
export type PostMessage = z.infer<typeof PostMessage>;

/** POST /projects/:id/escalations/:escalationId/resolve */
export const ResolveEscalation = z.object({
  optionId: z.string(),
  /** What the agent needs beyond the option: a URL, a name, a correction. */
  notes: z.string().trim().max(2000).optional(),
});
export type ResolveEscalation = z.infer<typeof ResolveEscalation>;

/**
 * PUT /projects/:id/source — the live site being migrated, set after intake. Agents read it and the
 * crawl may only reach its host.
 */
export const ChangeSourceSite = z.object({
  url: z.url({ protocol: /^https?$/ }).max(500),
});
export type ChangeSourceSite = z.infer<typeof ChangeSourceSite>;

/** POST /projects/:id/reset — back to intake. `confirmation` is the project name. */
export const ResetProject = z.object({ confirmation: z.string() });
export type ResetProject = z.infer<typeof ResetProject>;

/**
 * PUT /projects/:id/credentials/:credentialId — add a credential intake didn't have, or replace
 * one. Checked against its service first; nothing is stored on a failure.
 */
export const SetCredential = z.object({ secret: Secret });
export type SetCredential = z.infer<typeof SetCredential>;

/** PUT /projects/:id/brief — answer or revise the brief. Features apply from the next start. */
export const ChangeBrief = z.object({
  answers: z.record(z.string().max(60), z.string().trim().max(2000)),
});
export type ChangeBrief = z.infer<typeof ChangeBrief>;

/** PUT /projects/:id/target/:key — change one intake value before Start. */
export const ChangeTargetValue = z.object({
  value: z.union([z.string().trim().max(200), z.array(z.string().trim().max(60)).max(20)]),
});
export type ChangeTargetValue = z.infer<typeof ChangeTargetValue>;

/** POST /projects/:id/build-repo — create the build repository (a name overrides the default). */
export const CreateBuildRepo = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}$/, 'letters, digits, dot, dash and underscore')
    .optional(),
});
export type CreateBuildRepo = z.infer<typeof CreateBuildRepo>;

/** POST /projects/:id/escalations/:escalationId/defer */
export const DeferEscalation = z.object({ until: z.iso.datetime() });
export type DeferEscalation = z.infer<typeof DeferEscalation>;

/**
 * POST /projects/:id/gates/:escalationId/approve
 * Gate 2 (Acceptance) closes the engagement, so it requires `confirmation` = the project name.
 */
export const ApproveGate = z.object({ confirmation: z.string().optional() });
export type ApproveGate = z.infer<typeof ApproveGate>;

/** POST /projects/:id/gates/:escalationId/send-back — notes are required. */
export const SendBackGate = z.object({ notes: z.string().min(1) });
export type SendBackGate = z.infer<typeof SendBackGate>;

/** POST /projects/:id/control */
export const Control = z.object({
  verb: ControlVerb,
  scope: z.object({ kind: ScopeKind, id: z.string() }),
});
export type Control = z.infer<typeof Control>;

/** POST /projects/:id/tasks/:taskId/rerun */
export const RerunTask = z.object({ instructions: z.string().min(1).max(4000) });
export type RerunTask = z.infer<typeof RerunTask>;

/** POST /projects/:id/phases/:phase/rollback — destructive: type ROLL BACK. */
export const RollbackPhase = z.object({ confirmation: z.literal('ROLL BACK') });
export type RollbackPhase = z.infer<typeof RollbackPhase>;

/** POST /projects/:id/archive — type the project name. */
export const ArchiveProject = z.object({ confirmation: z.string() });
export type ArchiveProject = z.infer<typeof ArchiveProject>;

/** PUT /projects/:id/settings/:key */
export const ChangeSetting = z.object({ value: z.json() });
export type ChangeSetting = z.infer<typeof ChangeSetting>;

/** Every command answers with the seq of the last event it produced, so the UI can reconcile. */
export const CommandResult = z.object({ accepted: z.literal(true), seq: z.number().int() });
export type CommandResult = z.infer<typeof CommandResult>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    /** Names the system and the next step, per design spec §10. */
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
