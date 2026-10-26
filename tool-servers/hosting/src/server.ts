import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';

/**
 * The head on our Vercel team: one Vercel project per Launchworks project, linked to its build
 * repository, so the team (and the client) can see what was built. The project's production
 * deployment is the stable preview of the site and the editing host Page builder renders
 * through; agents' branches get preview deployments. Agents never choose the project, the
 * repository or any environment value: those come from the project, server-side.
 */

export interface HostingFacts {
  /** The Vercel project's name, from intake. */
  project: string;
  /** The build repository, "owner/name", and its default branch. */
  repo: string;
  branch: string;
  /** Where the app lives in the repository ("examples/basic-nextjs"). */
  rootDirectory: string;
}

export interface EnvVar {
  key: string;
  value: string;
  /** Server-only secrets are stored as Vercel "sensitive" values, unreadable after. */
  sensitive: boolean;
}

/** What the server records about a project's hosting (written to the project's log). */
export interface HostingRecord {
  projectId: string;
  /** The stable production alias, once a production deployment is ready. */
  url: string | null;
  deployment?: {
    id: string;
    url: string;
    target: 'preview' | 'production';
    ref: string;
  };
}

export interface HostingServerOptions {
  /** A Vercel token for our team; never a client's. */
  token: string;
  teamId: string;
  facts(projectId: string): Promise<HostingFacts | null>;
  /**
   * The head's environment variables for a target, resolved server-side (platform pack), and
   * what couldn't be resolved yet (a Context ID not given at intake).
   */
  env(
    projectId: string,
    target: 'preview' | 'production',
  ): Promise<{ vars: EnvVar[]; missing: string[] }>;
  /** Records the Vercel project and each ready deployment on the project. */
  /**
   * Readies the build repository for hosting (turns off Vercel's automatic Git deployments);
   * says what it did, or throws.
   */
  prepare?(projectId: string): Promise<string>;
  record(projectId: string, r: HostingRecord): Promise<void>;
  fetch?: typeof fetch;
  api?: string;
}

const AGENT_BRANCH = /^launchworks\/[A-Za-z0-9._/-]{1,100}$/;

const PreviewArgs = z.object({
  ref: z.string().regex(AGENT_BRANCH, 'an agent branch, launchworks/…').optional(),
});
const StatusArgs = z.object({ deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/) });
const EnvArgs = z.object({ target: z.enum(['preview', 'production', 'both']).default('both') });

export class HostingToolServer implements ToolServer {
  readonly name = 'hosting';
  readonly catalog: OperationCatalog = {
    'project.create': {
      description:
        "Create the project's Vercel project on our team, linked to the build repository with the app's root directory, and turn off Vercel Authentication so SitecoreAI can reach the head. Safe to repeat: an existing project of that name, linked to the same repository, is reused.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: true,
    },
    'project.read': {
      description:
        'The Vercel project as it stands: link, root directory, protection, environment variable names (never values), production URL and the latest deployments.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'env.set': {
      description:
        "Set the head's environment variables from the project (site, language, Experience Edge Context IDs, editing secret) for preview, production or both. Values are resolved on the server and never shown; the result lists the names set.",
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string', enum: ['preview', 'production', 'both'] } },
        additionalProperties: false,
      },
      mutates: true,
    },
    'deploy.preview': {
      description:
        'Deploy an agent branch (launchworks/…) of the build repository as a preview. Returns the deployment id; follow it with deploy.status until it is READY or ERROR.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        additionalProperties: false,
      },
      // An agent branch's preview changes nothing the client or Page builder sees.
      mutates: true,
    },
    'deploy.production': {
      description:
        "Deploy the build repository's default branch to the Vercel project's production URL: the stable preview of the site and the editing host. Returns the deployment id; follow it with deploy.status.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: true,
      releases: true,
    },
    'deploy.status': {
      description:
        "A deployment's state (QUEUED, BUILDING, READY, ERROR, CANCELED), URL and error. A ready deployment is recorded on the project.",
      inputSchema: {
        type: 'object',
        properties: { deploymentId: { type: 'string' } },
        required: ['deploymentId'],
        additionalProperties: false,
      },
      mutates: false,
    },
  };

  private readonly fetch: typeof fetch;
  private readonly api: string;

  constructor(private readonly opts: HostingServerOptions) {
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.api = opts.api ?? 'https://api.vercel.com';
  }

  target(projectId: string) {
    return `hosting:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const facts = await this.opts.facts(ctx.projectId);
    if (!facts) {
      const error =
        'This project has no build repository or Vercel project name yet. Create the build repository in Settings first.';
      return { code: 409, body: { error }, summary: error };
    }
    switch (op) {
      case 'project.create':
        return this.create(ctx.projectId, facts);
      case 'project.read':
        return this.read(facts);
      case 'env.set': {
        const a = EnvArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        return this.setEnv(ctx.projectId, facts, a.data.target);
      }
      case 'deploy.preview': {
        const a = PreviewArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        if (!a.data.ref) return bad('Give the agent branch to preview (launchworks/…).');
        return this.deploy(facts, a.data.ref, 'preview');
      }
      case 'deploy.production':
        return this.deploy(facts, facts.branch, 'production');
      case 'deploy.status': {
        const a = StatusArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        return this.status(ctx.projectId, facts, a.data.deploymentId);
      }
      default:
        return { code: 404, body: { error: `Unknown operation ${op}` } };
    }
  }

  private async create(projectId: string, facts: HostingFacts): Promise<ToolResult> {
    let prepared: string | null = null;
    try {
      prepared = (await this.opts.prepare?.(projectId)) ?? null;
    } catch (err) {
      prepared = `couldn't turn off automatic Git deployments: ${err instanceof Error ? err.message : String(err)}`;
    }
    const name = encodeURIComponent(facts.project);
    let p = await this.request('GET', `/v9/projects/${name}`);
    let created = false;
    if (p.status === 404) {
      p = await this.request('POST', '/v11/projects', {
        name: facts.project,
        framework: 'nextjs',
        rootDirectory: facts.rootDirectory,
        gitRepository: { type: 'github', repo: facts.repo },
      });
      if (p.status !== 200 && p.status !== 201) {
        return fail(
          p,
          `creating ${facts.project}`,
          /github|repository|integration|install/i.test(message(p) ?? '')
            ? ` Vercel's GitHub app needs access to ${facts.repo.split('/')[0]}: install it on the organization from Vercel's Git settings.`
            : '',
        );
      }
      created = true;
    } else if (p.status !== 200) {
      return fail(p, `reading ${facts.project}`);
    }
    const project = p.body as VercelProject;
    const linked = project.link ? `${project.link.org}/${project.link.repo}` : null;
    if (linked && linked.toLowerCase() !== facts.repo.toLowerCase()) {
      return bad(
        `A Vercel project named ${facts.project} already exists, linked to ${linked}, not ${facts.repo}. Choose another hosting project name.`,
      );
    }
    // SitecoreAI calls the head from its servers, so the deployments can't sit behind Vercel's
    // login. They hold no secrets: those are server-side environment variables.
    const patch = await this.request('PATCH', `/v9/projects/${encodeURIComponent(project.id)}`, {
      ssoProtection: null,
      passwordProtection: null,
      ...(project.rootDirectory !== facts.rootDirectory
        ? { rootDirectory: facts.rootDirectory }
        : {}),
    });
    if (patch.status !== 200) return fail(patch, 'turning off Vercel Authentication');
    // Executed is not verified: read it back.
    const back = await this.request('GET', `/v9/projects/${encodeURIComponent(project.id)}`);
    if (back.status !== 200) return fail(back, `reading ${facts.project} back`);
    const v = back.body as VercelProject;
    const problems = [
      v.link ? null : `not linked to ${facts.repo}`,
      v.rootDirectory === facts.rootDirectory
        ? null
        : `root directory is ${v.rootDirectory ?? '/'}`,
      v.ssoProtection ? 'Vercel Authentication is still on' : null,
    ].filter(Boolean);
    await this.opts.record(projectId, { projectId, url: productionUrl(v) });
    return {
      code: problems.length ? 409 : 200,
      body: {
        project: v.name,
        id: v.id,
        created,
        repository: v.link ? `${v.link.org}/${v.link.repo}` : null,
        rootDirectory: v.rootDirectory,
        protection: v.ssoProtection ? 'on' : 'off',
        repositoryConfig: prepared,
        problems,
      },
      summary: `${
        problems.length
          ? `${v.name}: ${problems.join('; ')}`
          : `${created ? 'Created' : 'Checked'} Vercel project ${v.name}, linked to ${facts.repo} (${facts.rootDirectory}), protection off`
      }${prepared ? `; ${prepared}` : ''}`,
    };
  }

  private async read(facts: HostingFacts): Promise<ToolResult> {
    const p = await this.request('GET', `/v9/projects/${encodeURIComponent(facts.project)}`);
    if (p.status === 404)
      return { code: 404, body: { error: `${facts.project} doesn't exist yet.` } };
    if (p.status !== 200) return fail(p, `reading ${facts.project}`);
    const v = p.body as VercelProject;
    const env = await this.request('GET', `/v10/projects/${encodeURIComponent(v.id)}/env`);
    const d = await this.request(
      'GET',
      `/v6/deployments?projectId=${encodeURIComponent(v.id)}&limit=5`,
    );
    const deployments =
      d.status === 200 ? ((d.body as { deployments: Deployment[] }).deployments ?? []) : [];
    return {
      code: 200,
      body: {
        project: v.name,
        repository: v.link ? `${v.link.org}/${v.link.repo}` : null,
        rootDirectory: v.rootDirectory,
        protection: v.ssoProtection ? 'on' : 'off',
        productionUrl: productionUrl(v),
        env:
          env.status === 200
            ? ((env.body as { envs?: { key: string; target?: string[] }[] }).envs ?? []).map(
                (e) => ({
                  key: e.key,
                  target: e.target ?? [],
                }),
              )
            : [],
        deployments: deployments.map((x) => ({
          id: x.uid,
          state: x.state ?? x.readyState,
          target: x.target ?? 'preview',
          url: x.url ? `https://${x.url}` : null,
          ref: x.meta?.githubCommitRef ?? null,
          sha: x.meta?.githubCommitSha ?? null,
        })),
      },
      summary: `${v.name}: ${deployments.length} recent deployment${deployments.length === 1 ? '' : 's'}`,
    };
  }

  private async setEnv(
    projectId: string,
    facts: HostingFacts,
    which: 'preview' | 'production' | 'both',
  ): Promise<ToolResult> {
    const targets = which === 'both' ? (['preview', 'production'] as const) : [which];
    const set: { key: string; target: string }[] = [];
    const missing = new Set<string>();
    for (const target of targets) {
      const { vars, missing: m } = await this.opts.env(projectId, target);
      m.forEach((x) => missing.add(x));
      if (!vars.length) continue;
      const r = await this.request(
        'POST',
        `/v10/projects/${encodeURIComponent(facts.project)}/env?upsert=true`,
        vars.map((v) => ({
          key: v.key,
          value: v.value,
          type: v.sensitive ? 'sensitive' : 'encrypted',
          target: [target],
        })),
      );
      if (r.status !== 200 && r.status !== 201) return fail(r, `setting ${target} variables`);
      const failed =
        (r.body as { failed?: { error: { key?: string; message: string } }[] }).failed ?? [];
      if (failed.length) {
        return bad(
          `Vercel refused ${failed.map((f) => `${f.error.key ?? '?'} (${f.error.message})`).join(', ')}.`,
        );
      }
      for (const v of vars) set.push({ key: v.key, target });
    }
    return {
      code: 200,
      body: { set, missing: [...missing] },
      summary: `Set ${set.length} variable${set.length === 1 ? '' : 's'} on ${facts.project}: ${[...new Set(set.map((s) => s.key))].join(', ')}${missing.size ? `. Not set yet: ${[...missing].join('; ')}` : ''}`,
    };
  }

  private async deploy(
    facts: HostingFacts,
    ref: string,
    target: 'preview' | 'production',
  ): Promise<ToolResult> {
    const [org, repo] = facts.repo.split('/');
    const r = await this.request('POST', '/v13/deployments?skipAutoDetectionConfirmation=1', {
      name: facts.project,
      project: facts.project,
      ...(target === 'production' ? { target: 'production' } : {}),
      gitSource: { type: 'github', org, repo, ref },
    });
    if (r.status !== 200 && r.status !== 201) return fail(r, `deploying ${ref}`);
    const d = r.body as Deployment & { id: string };
    return {
      code: 200,
      body: {
        deploymentId: d.id,
        state: d.readyState ?? 'QUEUED',
        url: d.url ? `https://${d.url}` : null,
        target,
        ref,
      },
      summary: `Deploying ${ref} to ${target} (${d.id})`,
    };
  }

  private async status(
    projectId: string,
    facts: HostingFacts,
    deploymentId: string,
  ): Promise<ToolResult> {
    const r = await this.request('GET', `/v13/deployments/${encodeURIComponent(deploymentId)}`);
    if (r.status !== 200) return fail(r, `reading ${deploymentId}`);
    const d = r.body as Deployment & { id: string; name?: string; alias?: string[] };
    if (d.name && d.name !== facts.project)
      return bad(`${deploymentId} isn't a deployment of ${facts.project}.`);
    const state = d.readyState ?? d.state ?? 'UNKNOWN';
    const target = d.target === 'production' ? 'production' : 'preview';
    const url = d.url ? `https://${d.url}` : null;
    const ref = d.meta?.githubCommitRef ?? d.gitSource?.ref ?? '';
    let stable: string | null = null;
    if (state === 'READY' && url) {
      stable = target === 'production' ? (d.alias?.[0] ? `https://${d.alias[0]}` : url) : url;
      await this.opts.record(projectId, {
        projectId,
        url: target === 'production' ? stable : null,
        deployment: { id: d.id, url: stable, target, ref },
      });
    }
    return {
      code: 200,
      body: {
        deploymentId: d.id,
        state,
        target,
        ref,
        url: stable ?? url,
        error: d.errorMessage ?? null,
      },
      summary: `${d.id}: ${state}${state === 'ERROR' && d.errorMessage ? `, ${d.errorMessage}` : ''}${stable ? `, ${stable}` : ''}`,
    };
  }

  private async request(method: string, path: string, body?: unknown) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await this.fetch(
      `${this.api}${path}${sep}teamId=${encodeURIComponent(this.opts.teamId)}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      },
    );
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: res.status, body: text as unknown };
    }
  }
}

interface VercelProject {
  id: string;
  name: string;
  rootDirectory: string | null;
  link?: { type: string; org: string; repo: string };
  ssoProtection?: unknown;
  targets?: { production?: { alias?: string[] } };
  alias?: { domain: string }[];
}

interface Deployment {
  uid?: string;
  url?: string;
  state?: string;
  readyState?: string;
  target?: string | null;
  errorMessage?: string;
  meta?: { githubCommitRef?: string; githubCommitSha?: string };
  gitSource?: { ref?: string };
}

function productionUrl(p: VercelProject): string | null {
  const alias = p.targets?.production?.alias?.[0] ?? p.alias?.[0]?.domain;
  return alias ? `https://${alias}` : null;
}

const message = (r: { body: unknown }) =>
  (r.body as { error?: { message?: string } } | null)?.error?.message;

const bad = (error: string): ToolResult => ({ code: 422, body: { error }, summary: error });

function fail(r: { status: number; body: unknown }, doing: string, hint = ''): ToolResult {
  const m = message(r);
  const error = `Vercel answered ${r.status} ${doing}${m ? `: ${m}` : ''}.${hint}`;
  return { code: r.status, body: { error }, summary: error };
}
