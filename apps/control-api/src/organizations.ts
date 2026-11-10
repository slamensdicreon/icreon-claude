import {
  DEFAULT_ORGANIZATION,
  githubSubject,
  type MemberRole,
  type OrganizationStore,
} from '@lw/events';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The organization a request acts in, and the caller's role there. */
export interface RequestOrganization {
  id: string;
  name: string;
  slug: string;
  role: MemberRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set on every signed-in request. `null` for the system's own scheduled calls (Vercel Cron),
     * which work across organizations; undefined where organizations aren't wired (tests).
     */
    organization?: RequestOrganization | null;
  }
}

/** Picks one of the caller's organizations (by id or slug); the first one otherwise. */
export const ORGANIZATION_HEADER = 'x-lw-organization';
/** Who a local run without sign-in is. */
export const LOCAL_SUBJECT = 'local';
/** The scheduled caller the sign-in hook lets through with CRON_SECRET. */
const CRON_LOGIN = 'vercel-cron';

const deny = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.status(status).send({ error: { code, message } });

/** Who the caller is, as memberships name them. */
export const subjectOf = (req: FastifyRequest, signedIn: boolean): string | null =>
  !signedIn ? LOCAL_SUBJECT : req.operator ? githubSubject(req.operator.login) : null;

/**
 * Puts every request in one organization and keeps it there: a project of another organization
 * answers as if it didn't exist. Register after sign-in, whose hook runs first.
 */
export function registerOrganizationScope(
  app: FastifyInstance,
  orgs: OrganizationStore,
  opts: { signedIn: boolean },
): void {
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return;
    // Signed in, only open paths arrive without an operator: the sign-in hook turned everyone
    // else away. They read nothing of any organization's.
    if (opts.signedIn && !req.operator) return;
    if (opts.signedIn && req.operator?.login === CRON_LOGIN) {
      req.organization = null;
      return;
    }
    const subject = subjectOf(req, opts.signedIn)!;
    const mine = await orgs.membershipsOf(subject);
    const raw = req.headers[ORGANIZATION_HEADER];
    const wanted = typeof raw === 'string' && raw ? raw : null;
    const m = wanted
      ? mine.find((x) => x.organizationId === wanted || x.organization.slug === wanted)
      : mine[0];
    if (!m)
      return wanted
        ? deny(reply, 403, 'not_a_member', `You are not a member of "${wanted}".`)
        : deny(
            reply,
            403,
            'no_organization',
            'Your account is not a member of any organization yet. Ask your Director for an invitation.',
          );
    req.organization = {
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
    };
  });

  // Every route on one project: the project must be the caller's organization's.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.organization) return;
    if (!(req.routeOptions.url ?? '').startsWith('/projects/:id')) return;
    const id = (req.params as { id?: string } | undefined)?.id;
    if (!id) return;
    if (!(await owns(orgs, req, id)))
      return deny(reply, 404, 'unknown_project', `No project "${id}".`);
  });
}

/** Whether the request's organization owns a project (always, for system calls). */
export async function owns(
  orgs: OrganizationStore | undefined,
  req: FastifyRequest,
  projectId: string,
): Promise<boolean> {
  if (!orgs || !req.organization) return true;
  return (await orgs.ownersOf([projectId])).get(projectId) === req.organization.id;
}

/** The items of the request's organization, by the project each belongs to. */
export async function scoped<T>(
  orgs: OrganizationStore | undefined,
  req: FastifyRequest,
  items: T[],
  projectOf: (item: T) => string,
): Promise<T[]> {
  if (!orgs || !req.organization) return items;
  const owners = await orgs.ownersOf(items.map(projectOf));
  const id = req.organization.id;
  return items.filter((x) => owners.get(projectOf(x)) === id);
}

/** The organization new work is filed under: the request's, or Icreon's for system calls. */
export const organizationOf = (req: FastifyRequest): string =>
  req.organization?.id ?? DEFAULT_ORGANIZATION;
