import type { ProjectState } from '@lw/domain';
import { CommandError } from '@lw/domain';
import { DEFAULT_ORGANIZATION, type LicenseStore, type OrganizationStore } from '@lw/events';
import type { BuildUsage } from '@lw/stack';
import { holdsPlace, standingOf } from './licenses';
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
  licenses?: LicenseStore;
  now: () => number;
  /** A hosting project's Vercel builds; absent where the API has no Vercel token. */
  buildUsage?: (hostingProject: string) => Promise<BuildUsage | null>;
}

/** Vercel's answers are kept this long: the page doesn't ask Vercel on every load. */
const BUILD_USAGE_TTL = 15 * 60_000;
const minutes = (ms: number) => Math.round(ms / 60_000);

/** How long Icreon's support access lasts, at most. */
export const SUPPORT_HOURS_MAX = 72;

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
        const license = deps.licenses ? await deps.licenses.get(o.id) : null;
        const standing = standingOf(o.id, license, deps.now());
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
                sandboxMinutes: u.sandboxMinutes + minutes(p.toolTime?.sandbox ?? 0),
              }),
              { usd: 0, tokens: 0, hours: 0, sandboxMinutes: 0 },
            ),
          license: {
            standing: standing.kind,
            used: own.filter(holdsPlace).length,
            ...(license
              ? {
                  entities: license.entities,
                  playbooks: license.playbooks,
                  projectsIncluded: license.projectsIncluded,
                  startsAt: license.startsAt,
                  endsAt: license.endsAt,
                  purgedAt: license.purgedAt,
                }
              : {}),
          },
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

  const builds = new Map<string, { at: number; usage: BuildUsage | null; error: string | null }>();
  const buildsOf = async (name: string) => {
    const hit = builds.get(name);
    if (hit && deps.now() - hit.at < BUILD_USAGE_TTL) return hit;
    let entry: { at: number; usage: BuildUsage | null; error: string | null };
    try {
      entry = { at: deps.now(), usage: await deps.buildUsage!(name), error: null };
    } catch (err) {
      entry = { at: deps.now(), usage: null, error: (err as Error).message };
    }
    builds.set(name, entry);
    return entry;
  };

  /**
   * What an organization has cost Icreon, project by project: Claude (the agents' spend), the
   * time its agents' tools ran (the sandbox, the browser, …) and its Vercel builds. Vercel's API
   * gives no bandwidth or function time per project, so those aren't here.
   */
  app.get<{ Params: { id: string } }>('/admin/organizations/:id/usage', async (req) => {
    const org = await orgs.get(req.params.id);
    if (!org) throw new CommandError(404, 'unknown_organization', 'No such organization.');
    const all = await deps.projects();
    const owners = await orgs.ownersOf(all.map((p) => p.projectId));
    const own = all.filter((p) => p.mode === 'live' && owners.get(p.projectId) === org.id);
    const projects = await Promise.all(
      own.map(async (p) => {
        const hosting =
          typeof p.intake?.target.hostingProject === 'string'
            ? p.intake.target.hostingProject
            : null;
        const b = hosting && deps.buildUsage ? await buildsOf(hosting) : null;
        return {
          projectId: p.projectId,
          name: p.name,
          status: p.status,
          claude: p.spent,
          toolMinutes: Object.fromEntries(
            Object.entries(p.toolTime ?? {}).map(([server, ms]) => [server, minutes(ms)]),
          ),
          vercel: b?.usage
            ? {
                hostingProject: hosting,
                deployments: b.usage.deployments,
                failed: b.usage.failed,
                buildMinutes: minutes(b.usage.buildMs),
              }
            : { hostingProject: hosting, deployments: 0, failed: 0, buildMinutes: 0 },
          vercelNote: !hosting
            ? 'No hosting project'
            : !deps.buildUsage
              ? 'Vercel not connected here'
              : b?.error
                ? b.error
                : !b?.usage
                  ? 'Not in our Vercel team yet'
                  : null,
        };
      }),
    );
    const sum = (f: (x: (typeof projects)[number]) => number) =>
      projects.reduce((n, x) => n + f(x), 0);
    return {
      organization: { id: org.id, name: org.name },
      totals: {
        claudeUsd: sum((x) => x.claude.usd),
        claudeTokens: sum((x) => x.claude.tokens),
        sandboxMinutes: sum((x) => x.toolMinutes.sandbox ?? 0),
        toolMinutes: sum((x) => Object.values(x.toolMinutes).reduce((a, b) => a + b, 0)),
        vercelDeployments: sum((x) => x.vercel.deployments),
        vercelBuildMinutes: sum((x) => x.vercel.buildMinutes),
      },
      projects,
      cachedForMinutes: minutes(BUILD_USAGE_TTL),
    };
  });

  /**
   * Support access: an Icreon administrator joins a customer organization for a few hours, to
   * look (Watcher) or to help (Director). It shows in the organization's People with when it
   * ends, and ends on its own.
   */
  app.post<{ Params: { id: string } }>('/admin/organizations/:id/support', async (req) => {
    const { hours, role } = z
      .object({
        hours: z.number().int().min(1).max(SUPPORT_HOURS_MAX).default(4),
        role: z.enum(['watcher', 'director']).default('watcher'),
      })
      .parse(req.body ?? {});
    const org = await orgs.get(req.params.id);
    if (!org) throw new CommandError(404, 'unknown_organization', 'No such organization.');
    if (org.id === DEFAULT_ORGANIZATION)
      throw new CommandError(409, 'icreon', 'You are already in Icreon.');
    const me = who(req);
    const mine = (await orgs.members(org.id)).find((m) => m.subject === me);
    if (mine && !mine.expiresAt)
      throw new CommandError(409, 'already_member', `You are already a member of ${org.name}.`);
    const expiresAt = new Date(deps.now() + hours * 3_600_000);
    await orgs.setMember(org.id, me, role, me, req.operator?.login ?? 'local', expiresAt);
    return {
      organization: { id: org.id, name: org.name },
      role,
      expiresAt: expiresAt.toISOString(),
    };
  });
}
