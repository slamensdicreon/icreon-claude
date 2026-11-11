import type { Control } from '@lw/contracts';
import { CommandError, type ProjectState } from '@lw/domain';
import {
  checkTerms,
  DEFAULT_ORGANIZATION,
  LicenseError,
  type License,
  type LicenseStore,
  type OrganizationStore,
} from '@lw/events';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { subjectOf } from './organizations';

/** How long export stays open after a term ends. */
export const EXPORT_DAYS = 90;

/** Where an organization stands with its license, at a moment. */
export type Standing =
  /** Icreon, or a server without licenses: no limits. */
  | { kind: 'unlimited' }
  /** A customer with no license yet: nothing can be started. */
  | { kind: 'none' }
  | { kind: 'upcoming'; license: License }
  | { kind: 'active'; license: License }
  /** The term is over: paused and read only; export open until `exportUntil`. */
  | { kind: 'ended'; license: License; exportUntil: string };

export function standingOf(organizationId: string, license: License | null, now: number): Standing {
  if (organizationId === DEFAULT_ORGANIZATION) return { kind: 'unlimited' };
  if (!license) return { kind: 'none' };
  if (now < Date.parse(license.startsAt)) return { kind: 'upcoming', license };
  if (now < Date.parse(license.endsAt)) return { kind: 'active', license };
  return {
    kind: 'ended',
    license,
    exportUntil: new Date(Date.parse(license.endsAt) + EXPORT_DAYS * 86_400_000).toISOString(),
  };
}

/** A project that holds a place in the license: live, and not on its way to deletion. */
export const holdsPlace = (s: ProjectState) => s.mode === 'live' && !s.deletion;

/** Writes an ended license still allows: signing in and out, one's own settings, people, export. */
const OPEN_WHEN_ENDED = [
  /^\/auth\//,
  /^\/me(\/|$)/,
  /^\/organization\//,
  /^\/projects\/:id\/export$/,
];

export interface LicenseDeps {
  orgs: OrganizationStore;
  licenses: LicenseStore;
  /** Every project, caught up. */
  projects: () => Promise<ProjectState[]>;
  /** The platform a playbook runs on. */
  platformOf: (playbookId: string) => string | null;
  /** One project's read model, if the API has it. */
  project?: (projectId: string) => ProjectState | undefined;
  /** A project's orchestrator, to pause and resume it; undefined where none runs it. */
  control?: (projectId: string, cmd: Control) => Promise<unknown>;
  signedIn: boolean;
  now: () => number;
}

const Terms = z.object({
  entities: z.array(z.string().max(80)).max(20),
  playbooks: z.array(z.string().max(120)).max(100),
  projectsIncluded: z.number().int().min(0).max(10_000),
  startsAt: z.string().max(40),
  endsAt: z.string().max(40),
});

/** The license rules, the license routes, and the reconciler the scheduled call runs. */
export function registerLicenses(app: FastifyInstance, deps: LicenseDeps) {
  const { orgs, licenses } = deps;
  const standing = async (organizationId: string) =>
    standingOf(organizationId, await licenses.get(organizationId), deps.now());
  const owned = async (organizationId: string) => {
    const all = await deps.projects();
    const owners = await orgs.ownersOf(all.map((s) => s.projectId));
    return all.filter((s) => owners.get(s.projectId) === organizationId);
  };

  // After the term, the organization reads but changes nothing (but what OPEN_WHEN_ENDED lists).
  app.addHook('preHandler', async (req, reply) => {
    const org = req.organization;
    if (!org || org.id === DEFAULT_ORGANIZATION) return;
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const url = req.routeOptions.url ?? '';
    if (OPEN_WHEN_ENDED.some((r) => r.test(url))) return;
    const s = await standing(org.id);
    if (s.kind !== 'ended') {
      // A project on a platform the license no longer covers is read only too.
      const id = (req.params as { id?: string } | undefined)?.id;
      if (!url.startsWith('/projects/:id') || !id || (s.kind !== 'active' && s.kind !== 'upcoming'))
        return;
      const platform = deps.project?.(id)?.intake?.platform;
      if (!platform || s.license.entities.includes(platform)) return;
      return reply.status(403).send({
        error: {
          code: 'platform_not_licensed',
          message: `${org.name}'s license no longer covers this project's platform: it is paused and read only. Export stays open. Ask Icreon to add the platform back.`,
        },
      });
    }
    return reply.status(403).send({
      error: {
        code: 'license_ended',
        message: `${org.name}'s license ended on ${s.license.endsAt.slice(0, 10)}: its projects are paused and read only. Export stays open until ${s.exportUntil.slice(0, 10)}. Ask Icreon to renew.`,
      },
    });
  });

  /**
   * Whether the request's organization may start one more project on a playbook; throws the
   * reason if not. System calls and Icreon may always.
   */
  const mayCreate = async (req: FastifyRequest, playbookId: string) => {
    const org = req.organization;
    if (!org) return;
    const s = await standing(org.id);
    if (s.kind === 'unlimited') return;
    if (s.kind === 'none')
      throw new CommandError(409, 'no_license', `${org.name} has no license yet. Ask Icreon.`);
    if (s.kind === 'upcoming')
      throw new CommandError(
        409,
        'license_not_started',
        `${org.name}'s license starts on ${s.license.startsAt.slice(0, 10)}.`,
      );
    if (s.kind === 'ended')
      throw new CommandError(
        409,
        'license_ended',
        `${org.name}'s license has ended. Ask Icreon to renew.`,
      );
    const platform = deps.platformOf(playbookId);
    if (
      !platform ||
      !s.license.entities.includes(platform) ||
      !s.license.playbooks.includes(playbookId)
    )
      throw new CommandError(
        409,
        'not_licensed',
        'That playbook is not in your license. Ask Icreon to add it.',
      );
    const used = (await owned(org.id)).filter(holdsPlace).length;
    if (used >= s.license.projectsIncluded)
      throw new CommandError(
        409,
        'no_project_left',
        `${org.name}'s license includes ${s.license.projectsIncluded} ${s.license.projectsIncluded === 1 ? 'project' : 'projects'}, and all are in use. Delete one, or ask Icreon for more.`,
      );
  };

  /** Whether each playbook is in the request's organization's license, for the catalog. */
  const licensedPlaybooks = async (req: FastifyRequest) => {
    const org = req.organization;
    if (!org) return () => true;
    const s = await standing(org.id);
    if (s.kind === 'unlimited') return () => true;
    if (s.kind !== 'active' && s.kind !== 'upcoming') return () => false;
    return (playbookId: string, platform: string) =>
      s.license.entities.includes(platform) && s.license.playbooks.includes(playbookId);
  };

  /**
   * Keeps projects in step with the license. At the end of the term every running project
   * pauses; while it runs, a project on a platform the license no longer covers pauses too. What
   * this paused is recorded, and resumes exactly when its reason goes (a renewal, the platform
   * added back). A project someone paused by hand is left as it is.
   */
  const reconcile = async (organizationId: string, by: string) => {
    const s = await standing(organizationId);
    if (s.kind === 'unlimited' || s.kind === 'none')
      return { organizationId, action: 'none', projects: [] as string[] };
    const license = s.license;
    const projects = (await owned(organizationId)).filter((p) => p.mode === 'live');
    const outside = (p: ProjectState) =>
      s.kind === 'ended' || !license.entities.includes(p.intake?.platform ?? '');
    const held = new Set(license.suspended?.projects ?? []);
    const paused: string[] = [];
    for (const p of projects) {
      if (p.status !== 'running' || !outside(p) || held.has(p.projectId)) continue;
      try {
        await deps.control?.(p.projectId, {
          verb: 'pause',
          scope: { kind: 'project', id: p.projectId },
        });
        paused.push(p.projectId);
      } catch {
        /* not running here (or already stopped): nothing to pause */
      }
    }
    const resumed: string[] = [];
    for (const id of held) {
      const p = projects.find((x) => x.projectId === id);
      if (p && outside(p)) continue;
      resumed.push(id);
      // Deleted or finished since: nothing to resume, but it no longer counts as held.
      if (p)
        await deps
          .control?.(id, { verb: 'resume', scope: { kind: 'project', id } })
          .catch(() => {});
    }
    const still = [...held].filter((id) => !resumed.includes(id)).concat(paused);
    const next =
      still.length || s.kind === 'ended'
        ? { at: license.suspended?.at ?? new Date(deps.now()).toISOString(), projects: still }
        : null;
    const same =
      (next === null && license.suspended === null) ||
      (next !== null &&
        license.suspended !== null &&
        JSON.stringify(next.projects) === JSON.stringify(license.suspended.projects));
    if (!same) await licenses.setSuspended(organizationId, next, by);
    const action = paused.length
      ? 'suspended'
      : resumed.length
        ? 'resumed'
        : same
          ? 'none'
          : next
            ? 'suspended'
            : 'resumed';
    return { organizationId, action, projects: paused.length ? paused : resumed };
  };

  /** The request's organization's license: its terms and what is in use. */
  app.get('/organization/license', async (req) => {
    const org = req.organization;
    if (!org) return { standing: 'unlimited' };
    const s = await standing(org.id);
    const used = (await owned(org.id)).filter(holdsPlace).length;
    return {
      standing: s.kind,
      used,
      ...(s.kind === 'unlimited' || s.kind === 'none'
        ? {}
        : {
            entities: s.license.entities,
            playbooks: s.license.playbooks,
            projectsIncluded: s.license.projectsIncluded,
            startsAt: s.license.startsAt,
            endsAt: s.license.endsAt,
          }),
      ...(s.kind === 'ended' ? { exportUntil: s.exportUntil } : {}),
    };
  });

  /** Icreon sets an organization's license; a renewal resumes what the end of the term paused. */
  app.put<{ Params: { id: string } }>('/admin/organizations/:id/license', async (req) => {
    if (req.params.id === DEFAULT_ORGANIZATION)
      throw new CommandError(409, 'icreon', 'Icreon needs no license.');
    if (!(await orgs.get(req.params.id)))
      throw new CommandError(404, 'unknown_organization', 'No such organization.');
    const by = subjectOf(req, deps.signedIn) ?? 'local';
    const input = Terms.parse(req.body ?? {});
    try {
      checkTerms(input);
    } catch (err) {
      if (err instanceof LicenseError) throw new CommandError(422, 'invalid', err.message);
      throw err;
    }
    const license = await licenses.set(req.params.id, input, by);
    const reconciled = await reconcile(req.params.id, by);
    return { license, reconciled };
  });

  app.get<{ Params: { id: string } }>('/admin/organizations/:id/license', async (req) => ({
    license: await licenses.get(req.params.id),
    history: await licenses.history(req.params.id),
  }));

  // The scheduled call (Vercel Cron, hourly) and Icreon's administrators by hand.
  app.get('/portfolio/licenses', async (req) => {
    const by = req.operator?.login ?? 'vercel-cron';
    const results = [];
    for (const l of await licenses.list()) results.push(await reconcile(l.organizationId, by));
    return { results: results.filter((r) => r.action !== 'none') };
  });

  return { mayCreate, licensedPlaybooks, standing, reconcile };
}
