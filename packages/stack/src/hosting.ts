import type { NewEvent } from '@lw/contracts';
import { DeployClient, type CleanupResult, type GithubApp } from '@lw/connectors';
import type { ProjectState } from '@lw/domain';
import { SITECOREAI, sitecoreTarget, text, type PlatformPack } from '@lw/platforms';
import { INTEGRATION_BRANCH, type ToolCallContext, type ToolResult } from '@lw/tool-gateway';
import { editingHost, HostingToolServer, type HostingFacts } from '@lw/tool-hosting';
import { SitecoreAuthoringToolServer, type TenantFacts } from '@lw/tool-sitecore';

/**
 * The head's hosting, wired the same way for the agents (the worker's tool servers) and for the
 * Director's hosting setup (the Control API): the Vercel project, its environment from the vault,
 * the editing host and production. Nothing here hands a secret to a caller.
 */
export interface HostingWiring {
  /** A Vercel token for our team, and the team. */
  token: string;
  teamId: string;
  project(projectId: string): Promise<ProjectState | undefined>;
  platforms: Map<string, PlatformPack>;
  /** A project credential opened from the vault, or null. */
  credential(projectId: string, credentialId: string): Promise<Record<string, string> | null>;
  /** A token for one of the project's tool servers (sitecore-deploy, sitecore-authoring). */
  tokenFor(projectId: string, server: string): Promise<string>;
  github?: GithubApp | null;
  append(projectId: string, events: NewEvent[]): Promise<void>;
  /** Tests answer Vercel's and SitecoreAI's APIs. */
  fetch?: typeof fetch;
}

/** The Vercel project, repository and app folder a project's head is hosted from. */
export function hostingFacts(s: ProjectState | undefined): HostingFacts | null {
  const name = s?.intake ? text(s.intake.target, 'hostingProject') : '';
  return s?.buildRepo && name
    ? {
        project: name,
        repo: s.buildRepo.repo,
        branch: s.buildRepo.branch,
        rootDirectory: s.buildRepo.appPath,
      }
    : null;
}

/** The SitecoreAI environment, site and source hosts a project's authoring tools work in. */
export function sitecoreFacts(s: ProjectState | undefined): TenantFacts | null {
  if (s?.intake?.platform !== SITECOREAI) return null;
  const host = s.sourceUrl ? new URL(s.sourceUrl).hostname : null;
  const t = sitecoreTarget(s.intake);
  return {
    cmHost: t.cmHost,
    siteCollection: t.siteCollection,
    site: t.site,
    languages: t.languages,
    sourceHosts: host ? [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`] : [],
  };
}

export function hostingToolServer(w: HostingWiring): HostingToolServer {
  return new HostingToolServer({
    token: w.token,
    teamId: w.teamId,
    ...(w.fetch ? { fetch: w.fetch } : {}),
    facts: async (id) => hostingFacts(await w.project(id)),
    // What the head needs, from the platform pack: values come from the vault and the
    // platform's APIs, never from the agent.
    env: async (id, which) => {
      const s = await w.project(id);
      const pack = s?.intake ? w.platforms.get(s.intake.platform) : undefined;
      if (!s?.intake || !pack?.headEnv) return { vars: [], missing: ['this platform has no head'] };
      return pack.headEnv(s.intake.target, which, {
        credential: (credentialId) => w.credential(id, credentialId),
        // Says why when it can't: "missing" alone left the team guessing.
        editingSecret: async () => {
          try {
            const deploy = new DeployClient(await w.tokenFor(id, 'sitecore-deploy'));
            const e = await deploy.environmentFor(sitecoreTarget(s.intake!).cmHost);
            return 'error' in e ? { problem: e.error } : await deploy.editingSecret(e.id);
          } catch (err) {
            return {
              problem: `the organization client couldn't be used: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        },
      });
    },
    // Agents' commits aren't Vercel team members: Vercel's own Git deployments of them are
    // refused and notify the team. Deployments go through these tools instead.
    prepare: async (id) => {
      const s = await w.project(id);
      if (!s?.buildRepo || !w.github) return 'no build repository to configure';
      const done = await w.github.ensureNoGitDeploys(s.buildRepo);
      return done === 'added'
        ? `turned off automatic Git deployments (${s.buildRepo.appPath}/vercel.json on ${s.buildRepo.branch})`
        : 'automatic Git deployments already off';
    },
    record: async (id, r) => {
      const s = await w.project(id);
      const name = s?.intake ? text(s.intake.target, 'hostingProject') : '';
      const actor = { kind: 'system', id: 'hosting' } as const;
      const subject = { kind: 'project', id } as const;
      const events: NewEvent[] = [];
      if (!s?.hosting || (r.url && r.url !== s.hosting.url)) {
        events.push({
          type: 'project.updated',
          actor,
          subject,
          severity: r.url ? 'notable' : 'routine',
          data: { hosting: { provider: 'vercel', project: name, url: r.url } },
        });
      }
      // Once per deployment, however often its status is read.
      if (r.deployment && s?.preview.target?.deployment !== r.deployment.id) {
        events.push({
          type: 'preview.deployed',
          actor,
          subject,
          severity: 'notable',
          data: {
            side: 'target',
            label: `Vercel, ${r.deployment.target === 'production' ? 'production' : r.deployment.ref}`,
            url: r.deployment.url,
            deployment: r.deployment.id,
          },
        });
      }
      if (events.length) await w.append(id, events);
    },
  });
}

/** One step of the hosting setup, as the tool answered it. */
export interface HostingStep {
  step: string;
  ok: boolean;
  summary: string;
  /** For the two deployments: follow them with hostingStatus. */
  deploymentId?: string;
}

const summaryOf = (r: ToolResult) =>
  r.summary ??
  (typeof (r.body as { error?: unknown })?.error === 'string'
    ? (r.body as { error: string }).error
    : `answered ${r.code}`);

/**
 * The Director's hosting setup, the steps the Deployment Engineer and Head Integrator take on a
 * playbook run: the Vercel project (protection off), the head's environment from the vault, the
 * build repository's default branch to production, the integration branch deployed as the
 * editing host, and, on SitecoreAI, the site's rendering host pointed at the editing address.
 * Stops at the first step that fails; deployments are followed with hostingStatus.
 */
export async function setUpHosting(
  w: HostingWiring,
  projectId: string,
): Promise<{ steps: HostingStep[]; editingHost: string | null }> {
  const hosting = hostingToolServer(w);
  const ctx: ToolCallContext = { projectId, token: '', role: 'director', taskId: 'hosting-setup' };
  const facts = hostingFacts(await w.project(projectId));
  const steps: HostingStep[] = [];
  const run = async (step: string, call: () => Promise<ToolResult>) => {
    let res: ToolResult;
    try {
      res = await call();
    } catch (err) {
      res = { code: 502, body: { error: err instanceof Error ? err.message : String(err) } };
    }
    const deploymentId = (res.body as { deploymentId?: string } | undefined)?.deploymentId;
    steps.push({
      step,
      ok: res.code < 300,
      summary: summaryOf(res),
      ...(deploymentId ? { deploymentId } : {}),
    });
    return res.code < 300;
  };
  // Production goes first: Vercel makes a new project's first deployment its production one,
  // whatever its branch, and the editing host must be a preview.
  const ok =
    (await run('Vercel project', () => hosting.call('project.create', {}, ctx))) &&
    (await run('Environment variables', () => hosting.call('env.set', { target: 'both' }, ctx))) &&
    (await run('Production build', () => hosting.call('deploy.production', {}, ctx))) &&
    (await run('Editing host build', () =>
      hosting.call('deploy.preview', { ref: INTEGRATION_BRANCH }, ctx),
    ));
  const editing = facts ? `https://${editingHost(facts.project)}` : null;
  const s = await w.project(projectId);
  if (ok && editing && s?.intake?.platform === SITECOREAI) {
    const authoring = new SitecoreAuthoringToolServer({
      facts: async () => sitecoreFacts(s),
      ...(w.fetch ? { fetch: w.fetch } : {}),
    });
    await run('Page builder rendering host', async () =>
      authoring.call(
        'rendering-host.set',
        { url: editing },
        { ...ctx, token: await w.tokenFor(projectId, 'sitecore-authoring') },
      ),
    );
  }
  return { steps, editingHost: editing };
}

/** A hosting deployment's state; a ready integration build becomes the editing host. */
export function hostingStatus(w: HostingWiring, projectId: string, deploymentId: string) {
  return hostingToolServer(w).call(
    'deploy.status',
    { deploymentId },
    { projectId, token: '', role: 'director', taskId: 'hosting-setup' },
  );
}

/**
 * Deletes a project's Vercel project from our team, for a project being deleted. One no longer in
 * our team (moved to the client's, or already gone) is left. Vercel's refusal comes back as an
 * outcome, so the purge records it and carries on; an outage throws, so it tries again next run.
 */
/** Vercel team roles that can delete projects. */
const DELETERS = new Set(['OWNER', 'MEMBER']);

/**
 * Can the purge delete hosting projects in our Vercel team? Reads the token owner's role in the
 * team (read only): an Owner or a Member can delete projects; a Developer, Viewer or Billing role
 * can't.
 */
export async function canDeleteHostingProjects(
  w: Pick<HostingWiring, 'token' | 'teamId' | 'fetch'>,
): Promise<{ state: 'ok' | 'missing' | 'off' | 'unknown'; detail: string }> {
  const doFetch = w.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`https://api.vercel.com/v2/teams/${encodeURIComponent(w.teamId)}`, {
      headers: { authorization: `Bearer ${w.token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { state: 'unknown', detail: `Vercel couldn't be reached: ${(err as Error).message}` };
  }
  if (res.status === 403 || res.status === 404)
    return {
      state: 'missing',
      detail: "The Vercel token can't see our team, so hosting projects can't be deleted.",
    };
  if (!res.ok)
    return { state: 'unknown', detail: `Vercel answered ${res.status} reading the team.` };
  const team = (await res.json()) as { slug?: string; membership?: { role?: string } };
  const role = team.membership?.role;
  const where = team.slug ? ` in ${team.slug}` : '';
  if (!role) return { state: 'unknown', detail: `Vercel didn't say the token's role${where}.` };
  const named = role.charAt(0) + role.slice(1).toLowerCase();
  return DELETERS.has(role)
    ? {
        state: 'ok',
        detail: `The token's owner is ${/^[AEIOU]/.test(named) ? 'an' : 'a'} ${named}${where}, so it can delete hosting projects.`,
      }
    : {
        state: 'missing',
        detail: `The token's owner is ${/^[AEIOU]/.test(named) ? 'an' : 'a'} ${named}${where}, which can't delete projects. Make them a Member or an Owner, or use another person's token.`,
      };
}

export async function deleteHostingProject(
  w: Pick<HostingWiring, 'token' | 'teamId' | 'fetch'>,
  name: string,
): Promise<CleanupResult> {
  const doFetch = w.fetch ?? fetch;
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(name)}?teamId=${encodeURIComponent(w.teamId)}`;
  const headers = { authorization: `Bearer ${w.token}` };
  const found = await doFetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (found.status === 404)
    return {
      outcome: 'not_found',
      detail: `${name} is not in our Vercel team (moved to the client, or already gone): left.`,
    };
  if (found.status === 403)
    return {
      outcome: 'refused',
      detail: `Vercel refused to read ${name}: the token can't see it.`,
    };
  if (!found.ok) throw new Error(`Vercel answered ${found.status} reading ${name}.`);
  const gone = await doFetch(url, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (gone.status === 204 || gone.status === 200)
    return { outcome: 'deleted', detail: `${name} and its deployments deleted.` };
  if (gone.status === 404) return { outcome: 'not_found', detail: `${name} was already gone.` };
  if (gone.status === 403)
    return {
      outcome: 'refused',
      detail: `Vercel refused to delete ${name}: the token's owner needs a role that can delete projects in the team.`,
    };
  throw new Error(`Vercel answered ${gone.status} deleting ${name}.`);
}

/** What a hosting project's builds have used on Vercel. */
export interface BuildUsage {
  /** Deployments built (finished or failed). */
  deployments: number;
  /** Build time, summed. */
  buildMs: number;
  /** Deployments whose build failed. */
  failed: number;
}

/**
 * A hosting project's builds in our Vercel team since a moment: how many, how long they built,
 * how many failed. Null when the project isn't in the team (not set up yet, or handed over).
 * Vercel's API gives deployments, not bandwidth or function time per project, so those aren't
 * counted here.
 */
export async function hostingBuildUsage(
  w: Pick<HostingWiring, 'token' | 'teamId' | 'fetch'>,
  name: string,
  since?: number,
): Promise<BuildUsage | null> {
  const doFetch = w.fetch ?? fetch;
  const usage: BuildUsage = { deployments: 0, buildMs: 0, failed: 0 };
  let until: number | null = null;
  // A page is 100 deployments; 20 pages is far beyond any project's year.
  for (let page = 0; page < 20; page++) {
    const url = new URL('https://api.vercel.com/v6/deployments');
    url.searchParams.set('projectId', name);
    url.searchParams.set('teamId', w.teamId);
    url.searchParams.set('limit', '100');
    if (since) url.searchParams.set('since', String(since));
    if (until) url.searchParams.set('until', String(until));
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${w.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 400) return page === 0 ? null : usage;
    if (!res.ok) throw new Error(`Vercel answered ${res.status} listing ${name}'s deployments.`);
    const body = (await res.json()) as {
      deployments?: { state?: string; buildingAt?: number; ready?: number }[];
      pagination?: { next?: number | null };
    };
    for (const d of body.deployments ?? []) {
      if (d.state !== 'READY' && d.state !== 'ERROR') continue;
      usage.deployments += 1;
      if (d.state === 'ERROR') usage.failed += 1;
      if (d.buildingAt && d.ready && d.ready >= d.buildingAt)
        usage.buildMs += d.ready - d.buildingAt;
    }
    const next = body.pagination?.next;
    if (!next || !body.deployments?.length) break;
    until = next;
  }
  return usage;
}
