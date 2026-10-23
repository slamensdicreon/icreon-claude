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

const ClientCredentials = z.object({
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().trim().min(1).max(500),
});
const ContextId = z.string().trim().min(1).max(200);
const Repo = z
  .string()
  .trim()
  .regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name');
const Branch = z.string().trim().min(1).max(200);

/**
 * POST /intake/verify — checks one credential against the live service before anything is stored.
 * The environment client is checked together with its CM host.
 */
export const VerifyIntakeCredential = z.discriminatedUnion('kind', [
  ClientCredentials.extend({
    kind: z.literal('sitecore.environment'),
    cmHost: z.string().trim().min(1).max(300),
  }),
  ClientCredentials.extend({ kind: z.literal('sitecore.organization') }),
  z.object({ kind: z.literal('edge.preview'), contextId: ContextId }),
  z.object({ kind: z.literal('edge.live'), contextId: ContextId }),
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
 * POST /projects — the New Project wizard. Everything a real engagement needs before it starts:
 * the source, the SitecoreAI target and its credentials, hosting, budgets. Secrets are sealed in
 * the vault on arrival; the event log only ever records references.
 */
export const ProjectIntake = z.object({
  name: z.string().trim().min(1).max(120),
  client: z.string().trim().min(1).max(120),
  timezone: z.string().min(1).max(64).default('America/New_York'),
  budgets: z.object({
    usd: z.number().positive().max(1_000_000),
    tokens: z.number().int().positive(),
    hours: z.number().positive().max(10_000),
  }),
  source: z.object({
    repo: Repo,
    branch: Branch.default('main'),
    url: z
      .url({ protocol: /^https?$/ })
      .nullable()
      .default(null),
  }),
  target: z.object({
    cmHost: z.string().trim().min(1).max(300),
    siteCollection: z.string().trim().min(1).max(100),
    site: z.string().trim().min(1).max(100),
    languages: z.array(z.string().trim().min(2).max(20)).min(1).default(['en']),
  }),
  hosting: z.object({
    provider: z.literal('vercel'),
    project: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{0,99}$/, 'lowercase letters, digits and dashes'),
  }),
  credentials: z.object({
    environment: ClientCredentials,
    organization: ClientCredentials.nullable().default(null),
    edgePreviewContextId: ContextId.nullable().default(null),
    edgeLiveContextId: ContextId.nullable().default(null),
  }),
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
