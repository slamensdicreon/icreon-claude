import type { NewEvent } from '@lw/contracts';
import { DeployClient, type GithubApp } from '@lw/connectors';
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
 * integration branch deployed as the editing host, the build repository's default branch to
 * production, and, on SitecoreAI, the site's rendering host pointed at the editing address.
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
  const ok =
    (await run('Vercel project', () => hosting.call('project.create', {}, ctx))) &&
    (await run('Environment variables', () => hosting.call('env.set', { target: 'both' }, ctx))) &&
    (await run('Editing host build', () =>
      hosting.call('deploy.preview', { ref: INTEGRATION_BRANCH }, ctx),
    )) &&
    (await run('Production build', () => hosting.call('deploy.production', {}, ctx)));
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
