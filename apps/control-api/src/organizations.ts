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
  /** A Director of Icreon (organization #1): Icreon's own administrators. */
  superAdmin: boolean;
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
/**
 * The organization the person chose in the Control Center. A cookie, not the header, because the
 * live stream (an EventSource) can't send headers. A choice that no longer holds is ignored.
 */
export const ORGANIZATION_COOKIE = 'lw_org';

/** One cookie's value from the request, if present. */
export function cookieOf(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
/** Who a local run without sign-in is. */
export const LOCAL_SUBJECT = 'local';
/** The scheduled caller the sign-in hook lets through with CRON_SECRET. */
const CRON_LOGIN = 'vercel-cron';

/**
 * What a Watcher may call: the portfolio and every project's progress, read only. Everything else
 * is closed to them, including any route added later, until it is listed here.
 */
export const WATCHER_ROUTES = new Set([
  'GET /auth/me',
  'GET /me/organizations',
  'GET /me/preferences',
  // Their own screen modes, not the project's.
  'PUT /me/preferences',
  // Which of their organizations they look at.
  'PUT /me/organization',
  'GET /health',
  'GET /projects',
  'GET /playbooks',
  'GET /playbooks/:id/scorecard',
  'GET /portfolio',
  'GET /portfolio/overview',
  'GET /portfolio/team',
  'GET /portfolio/workbench',
  'GET /portfolio/scorecard',
  'GET /portfolio/activity',
  'GET /projects/:id/icon',
  'GET /projects/:id/mission-control',
  'GET /projects/:id/scorecard',
  'GET /projects/:id/team',
  'GET /projects/:id/agents/:agentId',
  'GET /projects/:id/plan',
  'GET /projects/:id/tasks/:taskId',
  'GET /projects/:id/conversation',
  'GET /projects/:id/escalations/:escalationId',
  'GET /projects/:id/decisions',
  'GET /projects/:id/facts',
  'GET /projects/:id/workbench',
  'GET /projects/:id/artifacts/:artifactId',
  'GET /projects/:id/artifacts/:artifactId/versions/:version/content',
  'GET /projects/:id/artifacts/:artifactId/versions/:version/plain',
  'GET /projects/:id/schedule',
  'GET /projects/:id/preview',
  'GET /projects/:id/blueprint',
  'GET /projects/:id/since',
  'GET /projects/:id/blobs/*',
  'GET /projects/:id/activity',
  'GET /projects/:id/stream',
]);

/**
 * Icreon's alone, whichever organization the request acts in: the knowledge, rules and proposals
 * every licensee's playbooks learn from, the GitHub App, and the system's diagnostics and tests.
 */
const SUPER_ADMIN_ROUTES = [
  /^\/admin(\/|$)/,
  /^\/integrations\/github(\/manifest|\/callback)?$/,
  /^\/rules(\/|$)/,
  /^\/knowledge(\/|$)/,
  /^\/proposals\//,
  /^\/playbooks\/:id\/in-force$/,
  /^\/projects\/:id\/escalations\/:escalationId\/rule-draft$/,
  /^\/projects\/:id\/rules\/harvest$/,
  /^\/projects\/:id\/retrospectives$/,
  /^\/projects\/:id\/lessons$/,
  /^\/projects\/:id\/triage\/replay$/,
  /^\/projects\/:id\/operator\/test-email$/,
  /^\/projects\/:id\/diagnostics$/,
  /^\/projects\/:id\/scenarios(\/|$)/,
  /^\/portfolio\/diagnostics$/,
  /^\/portfolio\/watchdog$/,
  /^\/portfolio\/licenses$/,
];
export const isSuperAdminRoute = (url: string) => SUPER_ADMIN_ROUTES.some((r) => r.test(url));

const deny = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.status(status).send({ error: { code, message } });

/** Who the caller is, as memberships name them. */
export const subjectOf = (req: FastifyRequest, signedIn: boolean): string | null =>
  !signedIn
    ? LOCAL_SUBJECT
    : req.operator
      ? (req.operator.subject ?? githubSubject(req.operator.login))
      : null;

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
    const chosen = cookieOf(req, ORGANIZATION_COOKIE);
    const named = (key: string) =>
      mine.find((x) => x.organizationId === key || x.organization.slug === key);
    const m = wanted ? named(wanted) : ((chosen && named(chosen)) ?? mine[0]);
    if (!m)
      return wanted
        ? deny(reply, 403, 'not_a_member', `You are not a member of "${wanted}".`)
        : deny(
            reply,
            403,
            'no_organization',
            'Your account is not a member of any organization yet. Ask your Director for an invitation.',
          );
    const superAdmin = mine.some(
      (x) => x.organizationId === DEFAULT_ORGANIZATION && x.role === 'director',
    );
    req.organization = {
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
      superAdmin,
    };

    // What the caller may do here. An unknown path is left to answer 404.
    const url = req.routeOptions.url;
    if (!url) return;
    if (isSuperAdminRoute(url) && !superAdmin)
      return deny(reply, 403, 'super_admin_only', "Only Icreon's administrators can do this.");
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    if (m.role === 'watcher' && !WATCHER_ROUTES.has(`${method} ${url}`))
      return deny(
        reply,
        403,
        'read_only',
        `You are watching ${m.organization.name}: you can see everything, but not change it.`,
      );
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
