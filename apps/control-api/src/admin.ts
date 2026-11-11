import type { ProjectState } from '@lw/domain';
import { CommandError } from '@lw/domain';
import type { OrganizationStore } from '@lw/events';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { subjectOf } from './organizations';
import { INVITATION_DAYS, type SendInvitation } from './people';

/** What `/admin` needs beside the organization store. */
export interface AdminDeps {
  orgs: OrganizationStore;
  signedIn: boolean;
  sendInvitation: SendInvitation | null;
  /** Every project the API has read (caught up). */
  projects: () => Promise<ProjectState[]>;
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');

const NewOrganization = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().max(40).optional(),
  /** The customer's first Director, invited by email. */
  directorEmail: z.string().trim().max(254).optional(),
});

/**
 * Icreon's own pages (`/admin/*`, super admins only: the scope hook refuses everyone else).
 * Every organization on the product, and creating one: the Icreon Director who creates it becomes
 * its kickoff Director, and the customer's first Director is invited.
 */
export function registerAdmin(app: FastifyInstance, deps: AdminDeps): void {
  const { orgs } = deps;
  const who = (req: FastifyRequest) => subjectOf(req, deps.signedIn) ?? 'local';

  app.get('/admin/organizations', async () => {
    const [list, projects] = await Promise.all([orgs.list(), deps.projects()]);
    const owners = await orgs.ownersOf(projects.map((p) => p.projectId));
    return Promise.all(
      list.map(async (o) => {
        const [members, invitations] = await Promise.all([
          orgs.members(o.id),
          orgs.invitations(o.id),
        ]);
        const own = projects.filter((p) => owners.get(p.projectId) === o.id);
        return {
          id: o.id,
          name: o.name,
          slug: o.slug,
          createdAt: o.createdAt,
          directors: members.filter((m) => m.role === 'director').length,
          watchers: members.filter((m) => m.role === 'watcher').length,
          invitations: invitations.length,
          projects: own.filter((p) => p.mode === 'live').length,
          running: own.filter((p) => p.status === 'running').length,
          // What the organization's agents have cost Icreon (Claude), across its live projects.
          usage: own
            .filter((p) => p.mode === 'live')
            .reduce(
              (u, p) => ({
                usd: u.usd + p.spent.usd,
                tokens: u.tokens + p.spent.tokens,
                hours: u.hours + p.spent.hours,
              }),
              { usd: 0, tokens: 0, hours: 0 },
            ),
        };
      }),
    );
  });

  app.post('/admin/organizations', async (req, reply) => {
    const input = NewOrganization.parse(req.body ?? {});
    const slug = input.slug || slugOf(input.name);
    const org = await orgs.create({ name: input.name, slug }).catch((err: Error) => {
      throw new CommandError(422, 'invalid', err.message);
    });
    // Whoever creates it starts it: they are its kickoff Director, whom the customer can't remove.
    const me = who(req);
    await orgs.setMember(org.id, me, 'director', me, req.operator?.login ?? 'local');
    let invited: { email: string; emailSent: boolean; detail: string | null } | null = null;
    if (input.directorEmail) {
      const invitation = await orgs
        .invite({
          organizationId: org.id,
          email: input.directorEmail,
          role: 'director',
          invitedBy: me,
          expiresAt: new Date(Date.now() + INVITATION_DAYS * 86_400_000),
        })
        .catch((err: Error) => {
          throw new CommandError(422, 'invalid', err.message);
        });
      const mail = deps.sendInvitation
        ? await deps.sendInvitation(invitation.email)
        : { sent: false, detail: 'Email invitations need WorkOS.' };
      invited = { email: invitation.email, emailSent: mail.sent, detail: mail.detail };
    }
    return reply.status(201).send({ organization: org, invited });
  });
}
