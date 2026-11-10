import { DEFAULT_ORGANIZATION, MEMBER_ROLES, type OrganizationStore } from '@lw/events';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CommandError } from '@lw/domain';
import { subjectOf } from './organizations';

/** How long an invitation stays open (WorkOS's own default). */
export const INVITATION_DAYS = 7;

/** Sends the invitation email; says whether it went, and why not. */
export type SendInvitation = (email: string) => Promise<{ sent: boolean; detail: string | null }>;

/** WorkOS sends the email; its link signs the person up through AuthKit and lands back here. */
export function workosInvitations(opts: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): SendInvitation {
  const doFetch = opts.fetch ?? fetch;
  return async (email) => {
    const res = await doFetch(
      `${opts.baseUrl ?? 'https://api.workos.com'}/user_management/invitations`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ email, expires_in_days: INVITATION_DAYS }),
      },
    ).catch(() => null);
    if (res?.ok) return { sent: true, detail: null };
    const body = (await res?.json().catch(() => null)) as { message?: string } | null;
    return {
      sent: false,
      detail:
        body?.message ?? (res ? `WorkOS answered ${res.status}.` : 'WorkOS could not be reached.'),
    };
  };
}

const Invite = z.object({
  email: z.string().trim().min(3).max(254),
  role: z.enum(MEMBER_ROLES as ['director', 'watcher']),
});
const ChangeRole = z.object({ role: z.enum(MEMBER_ROLES as ['director', 'watcher']) });

/**
 * The organization's people: who belongs, who is invited, and a Director's ways to change that.
 * Watchers never reach these routes (they aren't on the Watcher list).
 */
export function registerPeople(
  app: FastifyInstance,
  deps: { orgs: OrganizationStore; signedIn: boolean; sendInvitation: SendInvitation | null },
): void {
  const { orgs } = deps;
  const here = (req: FastifyRequest) => {
    if (!req.organization)
      throw new CommandError(
        400,
        'no_organization',
        'Act in one organization to manage its people.',
      );
    return req.organization;
  };
  /** Icreon's Directors run every customer's kickoff; a customer can't remove or demote them. */
  const isIcreonDirector = async (subject: string) =>
    (await orgs.membershipsOf(subject)).some(
      (m) => m.organizationId === DEFAULT_ORGANIZATION && m.role === 'director',
    );
  /** The checks before a member's role changes or they leave. */
  const mayChange = async (req: FastifyRequest, subject: string, nextRole: string | null) => {
    const org = here(req);
    const members = await orgs.members(org.id);
    const target = members.find((m) => m.subject === subject);
    if (!target) throw new CommandError(404, 'unknown_member', 'No such member here.');
    if (subject === subjectOf(req, deps.signedIn))
      throw new CommandError(409, 'yourself', 'Ask another Director to change your own access.');
    if (org.id !== DEFAULT_ORGANIZATION && !org.superAdmin && (await isIcreonDirector(subject)))
      throw new CommandError(
        409,
        'icreon_director',
        'Icreon’s Director stays with your organization. Ask Icreon to change this.',
      );
    const directors = members.filter((m) => m.role === 'director');
    if (target.role === 'director' && nextRole !== 'director' && directors.length <= 1)
      throw new CommandError(409, 'last_director', 'An organization needs at least one Director.');
    return { org, target };
  };

  app.get('/organization/people', async (req) => {
    const org = here(req);
    const [members, invitations] = await Promise.all([
      orgs.members(org.id),
      orgs.invitations(org.id),
    ]);
    const me = subjectOf(req, deps.signedIn);
    return {
      organization: { id: org.id, name: org.name, slug: org.slug },
      emailInvitations: Boolean(deps.sendInvitation),
      members: await Promise.all(
        members.map(async (m) => ({
          subject: m.subject,
          label: m.label ?? m.subject.replace(/^github:/, ''),
          via: m.subject.startsWith('workos:')
            ? 'email'
            : m.subject.startsWith('github:')
              ? 'github'
              : 'local',
          role: m.role,
          since: m.createdAt,
          you: m.subject === me,
          icreon: org.id !== DEFAULT_ORGANIZATION && (await isIcreonDirector(m.subject)),
        })),
      ),
      invitations: invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        invitedBy: i.invitedBy.replace(/^(github|workos):/, ''),
        expiresAt: i.expiresAt,
      })),
    };
  });

  app.post('/organization/invitations', async (req, reply) => {
    const org = here(req);
    const { email, role } = Invite.parse(req.body ?? {});
    const by = req.operator?.login ?? 'local';
    const invitation = await orgs
      .invite({
        organizationId: org.id,
        email,
        role,
        invitedBy: subjectOf(req, deps.signedIn) ?? by,
        expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
      })
      .catch((err: Error) => {
        throw new CommandError(422, 'invalid', err.message);
      });
    const mail = deps.sendInvitation
      ? await deps.sendInvitation(invitation.email)
      : {
          sent: false,
          detail: 'Email invitations need WorkOS; they can sign in once it is set up.',
        };
    return reply.status(201).send({ invitation, emailSent: mail.sent, detail: mail.detail });
  });

  app.delete<{ Params: { id: string } }>('/organization/invitations/:id', async (req, reply) => {
    const org = here(req);
    if (!(await orgs.revokeInvitation(org.id, req.params.id)))
      throw new CommandError(404, 'unknown_invitation', 'No open invitation with that id.');
    return reply.status(204).send();
  });

  app.put<{ Params: { subject: string } }>('/organization/members/:subject', async (req) => {
    const { role } = ChangeRole.parse(req.body ?? {});
    const { org, target } = await mayChange(req, req.params.subject, role);
    await orgs.setMember(org.id, target.subject, role, req.operator?.login ?? 'local');
    return { ok: true };
  });

  app.delete<{ Params: { subject: string } }>(
    '/organization/members/:subject',
    async (req, reply) => {
      const { org, target } = await mayChange(req, req.params.subject, null);
      await orgs.removeMember(org.id, target.subject);
      return reply.status(204).send();
    },
  );
}
