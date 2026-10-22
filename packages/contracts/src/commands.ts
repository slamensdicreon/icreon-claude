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
});
export type CreateProject = z.infer<typeof CreateProject>;

/** POST /projects/:id/messages — a directive or a question for the Chief of Staff. */
export const PostMessage = z.object({ body: z.string().min(1).max(8000) });
export type PostMessage = z.infer<typeof PostMessage>;

/** POST /projects/:id/escalations/:escalationId/resolve */
export const ResolveEscalation = z.object({ optionId: z.string() });
export type ResolveEscalation = z.infer<typeof ResolveEscalation>;

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
