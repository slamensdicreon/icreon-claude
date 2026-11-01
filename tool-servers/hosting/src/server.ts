import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';
import { AGENT_BRANCH, INTEGRATION_BRANCH, rejected } from '@lw/tool-gateway';

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
  /**
   * Readies the build repository for hosting (turns off Vercel's automatic Git deployments);
   * says what it did, or throws.
   */
  prepare?(projectId: string): Promise<string>;
  /** Records the Vercel project and each ready deployment on the project. */
  record(projectId: string, r: HostingRecord): Promise<void>;
  /** How long a reproduction listens to the runtime log, and after the page answers (tests). */
  logTiming?: { windowMs: number; graceMs: number };
  fetch?: typeof fetch;
  api?: string;
}

/** The editing host's fixed address: Page builder's rendering host points here. */
export const editingHost = (project: string) => `${project}-editing.vercel.app`;

const PreviewArgs = z.object({
  ref: z.string().regex(AGENT_BRANCH, 'an agent branch, launchworks/…').optional(),
});
const StatusArgs = z.object({ deploymentId: z.string().regex(/^dpl_[A-Za-z0-9]+$/) });
const EnvArgs = z.object({ target: z.enum(['preview', 'production', 'both']).default('both') });
const LogsArgs = z.object({
  path: z
    .string()
    .regex(/^\/[^\s]*$/, 'a path on the site, starting with /')
    .max(500),
  target: z.enum(['editing', 'production']).default('editing'),
  deploymentId: z
    .string()
    .regex(/^dpl_[A-Za-z0-9]+$/)
    .optional(),
  level: z.enum(['error', 'all']).default('all'),
});

/** How long a reproduction waits for the server's log lines, all told. */
const LOG_WINDOW_MS = 12_000;
/** After the page has answered, how long log lines still have to arrive. */
const LOG_GRACE_MS = 4_000;

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
      description: `Deploy an agent branch (launchworks/…) of the build repository as a preview. Returns the deployment id; follow it with deploy.status until it is READY or ERROR. A ready preview of ${INTEGRATION_BRANCH} becomes the editing host, at the project's fixed address https://<project>-editing.vercel.app.`,
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
    'logs.runtime': {
      description:
        "Reproduce a page on the head and read what the server logged while rendering it: errors and warnings with their stack (the component or field that threw), the request's path and status. Opens the deployment's runtime log, requests `path` on it, and returns the lines that arrived, with the page's own status and error digest. Use it when a page answers 500 or renders wrong. target: 'editing' (the editing host, the default) or 'production'; or give a deploymentId.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          target: { type: 'string', enum: ['editing', 'production'] },
          deploymentId: { type: 'string' },
          level: { type: 'string', enum: ['error', 'all'] },
        },
        required: ['path'],
        additionalProperties: false,
      },
      mutates: false,
      // Log lines quote page content and whatever the app printed.
      untrusted: true,
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
        return this.read(ctx.projectId, facts);
      case 'env.set': {
        const a = EnvArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        return this.setEnv(ctx.projectId, facts, a.data.target);
      }
      case 'deploy.preview': {
        const a = PreviewArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        if (!a.data.ref) return rejected('Give the agent branch to preview (launchworks/…).');
        return this.deploy(facts, a.data.ref, 'preview');
      }
      case 'deploy.production':
        return this.deploy(facts, facts.branch, 'production');
      case 'deploy.status': {
        const a = StatusArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        return this.status(ctx.projectId, facts, a.data.deploymentId);
      }
      case 'logs.runtime': {
        const a = LogsArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        return this.runtimeLogs(facts, a.data);
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
      return rejected(
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

  private async read(projectId: string, facts: HostingFacts): Promise<ToolResult> {
    const p = await this.request('GET', `/v9/projects/${encodeURIComponent(facts.project)}`);
    if (p.status === 404)
      return { code: 404, body: { error: `${facts.project} doesn't exist yet.` } };
    if (p.status !== 200) return fail(p, `reading ${facts.project}`);
    const v = p.body as VercelProject;
    const [env, d] = await Promise.all([
      this.request('GET', `/v10/projects/${encodeURIComponent(v.id)}/env`),
      this.request('GET', `/v6/deployments?projectId=${encodeURIComponent(v.id)}&limit=5`),
    ]);
    const deployments =
      d.status === 200 ? ((d.body as { deployments: Deployment[] }).deployments ?? []) : [];
    // A production deployment that finished while no one was reading its status is still live:
    // record its address here too, or the head stays without one.
    const live = productionUrl(v);
    const ready = deployments.find(
      (x) => x.target === 'production' && (x.state ?? x.readyState) === 'READY',
    );
    if (live && ready?.uid)
      await this.opts.record(projectId, {
        projectId,
        url: live,
        deployment: {
          id: ready.uid,
          url: live,
          target: 'production',
          ref: ready.meta?.githubCommitRef ?? '',
        },
      });
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
        return rejected(
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
      return rejected(`${deploymentId} isn't a deployment of ${facts.project}.`);
    const state = d.readyState ?? d.state ?? 'UNKNOWN';
    const target = d.target === 'production' ? 'production' : 'preview';
    const url = d.url ? `https://${d.url}` : null;
    const ref = d.meta?.githubCommitRef ?? d.gitSource?.ref ?? '';
    let stable: string | null = null;
    let editing: string | null = null;
    let superseded: string | null = null;
    if (state === 'READY' && url && target === 'preview' && ref === INTEGRATION_BRANCH) {
      // The integration preview is the editing host: move the fixed address onto it, unless a
      // newer integration build (which has everything this one has) already holds it.
      const alias = editingHost(facts.project);
      const held = await this.request('GET', `/v4/aliases/${encodeURIComponent(alias)}`);
      const current =
        held.status === 200 ? (held.body as { deploymentId?: string }).deploymentId : null;
      if (current && current !== d.id) {
        const c = await this.request('GET', `/v13/deployments/${encodeURIComponent(current)}`);
        const at = c.status === 200 ? (c.body as Deployment).createdAt : undefined;
        if (at && d.createdAt && at > d.createdAt) superseded = current;
      }
      if (!superseded) {
        const a = await this.request(
          'POST',
          `/v2/deployments/${encodeURIComponent(d.id)}/aliases`,
          { alias },
        );
        if (a.status !== 200 && a.status !== 201) return fail(a, `pointing ${alias} at ${d.id}`);
        editing = `https://${alias}`;
      }
    }
    if (state === 'READY' && url) {
      stable =
        editing ?? (target === 'production' ? (d.alias?.[0] ? `https://${d.alias[0]}` : url) : url);
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
        editingHost: editing,
        error: d.errorMessage ?? null,
      },
      summary: `${d.id}: ${state}${state === 'ERROR' && d.errorMessage ? `, ${d.errorMessage}` : ''}${editing ? `, live as the editing host at ${editing}` : superseded ? `; a newer integration build (${superseded}) is already the editing host` : stable ? `, ${stable}` : ''}`,
    };
  }

  /**
   * The deployment a reproduction runs against, with the address to request it at: the editing
   * host's current deployment, the latest production one, or one named (of this project only).
   */
  private async deploymentFor(
    facts: HostingFacts,
    a: z.infer<typeof LogsArgs>,
  ): Promise<{ projectId: string; deploymentId: string; host: string } | ToolResult> {
    const p = await this.request('GET', `/v9/projects/${encodeURIComponent(facts.project)}`);
    if (p.status === 404)
      return { code: 404, body: { error: `${facts.project} doesn't exist yet.` } };
    if (p.status !== 200) return fail(p, `reading ${facts.project}`);
    const project = p.body as VercelProject;
    if (a.deploymentId) {
      const d = await this.request('GET', `/v13/deployments/${encodeURIComponent(a.deploymentId)}`);
      if (d.status !== 200) return fail(d, `reading ${a.deploymentId}`);
      const dep = d.body as Deployment & { id: string; name?: string };
      if (dep.name && dep.name !== facts.project)
        return rejected(`${a.deploymentId} isn't a deployment of ${facts.project}.`);
      if (!dep.url) return rejected(`${a.deploymentId} has no address yet.`);
      return { projectId: project.id, deploymentId: dep.id, host: dep.url };
    }
    if (a.target === 'editing') {
      const alias = editingHost(facts.project);
      const held = await this.request('GET', `/v4/aliases/${encodeURIComponent(alias)}`);
      const id = held.status === 200 ? (held.body as { deploymentId?: string }).deploymentId : null;
      if (!id)
        return {
          code: 404,
          body: { error: `No editing host yet: ${alias} points at no deployment.` },
        };
      return { projectId: project.id, deploymentId: id, host: alias };
    }
    const d = await this.request(
      'GET',
      `/v6/deployments?projectId=${encodeURIComponent(project.id)}&target=production&state=READY&limit=1`,
    );
    const latest =
      d.status === 200 ? (d.body as { deployments?: Deployment[] }).deployments?.[0] : null;
    const live = productionUrl(project);
    if (!latest?.uid || !live)
      return { code: 404, body: { error: `${facts.project} has no ready production deployment.` } };
    return {
      projectId: project.id,
      deploymentId: latest.uid,
      host: live.replace(/^https:\/\//, ''),
    };
  }

  /**
   * Reproduces a page and reads the server's log while it renders. Vercel's runtime log is a live
   * tail: it shows what happens from the moment it is opened, so the page is requested once the
   * tail is open, and the lines that arrive within the window are returned.
   */
  private async runtimeLogs(facts: HostingFacts, a: z.infer<typeof LogsArgs>): Promise<ToolResult> {
    const found = await this.deploymentFor(facts, a);
    if ('code' in found) return found;
    const { projectId, deploymentId, host } = found;
    const started = Date.now();
    const { windowMs, graceMs } = this.opts.logTiming ?? {
      windowMs: LOG_WINDOW_MS,
      graceMs: LOG_GRACE_MS,
    };
    const abort = new AbortController();
    const window = setTimeout(() => abort.abort(), windowMs);
    const lines: LogLine[] = [];
    let page: { status: number; digest: string | null; title: string | null } | null = null;
    let tail = 'closed';
    // The page, with a fresh query so a cached copy doesn't answer instead of the server.
    const sep = a.path.includes('?') ? '&' : '?';
    const request = (onAnswer: () => void) =>
      this.fetch(`https://${host}${a.path}${sep}lw-log=${started}`, {
        signal: AbortSignal.timeout(windowMs),
        redirect: 'manual',
      })
        .then(async (r) => {
          const html = await r.text().catch(() => '');
          page = {
            status: r.status,
            digest: html.match(/digest["':\s]+([\w-]{4,})/i)?.[1] ?? null,
            title: html.match(/<title>([^<]{0,200})<\/title>/i)?.[1] ?? null,
          };
          onAnswer();
        })
        .catch((err: unknown) => {
          page = { status: 0, digest: null, title: (err as Error).message };
        });
    try {
      const res = await this.fetch(
        `${this.api}/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/runtime-logs?teamId=${encodeURIComponent(this.opts.teamId)}`,
        {
          headers: {
            authorization: `Bearer ${this.opts.token}`,
            accept: 'application/stream+json',
          },
          signal: abort.signal,
        },
      );
      if (!res.ok || !res.body) {
        tail = `refused (${res.status})`;
        await request(() => undefined);
      } else {
        tail = 'open';
        // Requested once the tail is listening; the log gets its grace period after the answer.
        const requested = request(() => setTimeout(() => abort.abort(), graceMs));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split('\n');
            buffer = parts.pop() ?? '';
            for (const part of parts) {
              const line = logLine(part);
              if (line) lines.push(line);
            }
          }
        } catch {
          /* the window closed */
        }
        const last = logLine(buffer);
        if (last) lines.push(last);
        await requested;
      }
    } catch (err) {
      if (!abort.signal.aborted) tail = `failed: ${(err as Error).message}`;
    } finally {
      clearTimeout(window);
    }
    const shown = lines.filter((l) => a.level === 'all' || l.level === 'error').slice(-80);
    const errors = lines.filter((l) => l.level === 'error').length;
    const answered = page as { status: number; digest: string | null; title: string | null } | null;
    return {
      code: 200,
      body: {
        deploymentId,
        url: `https://${host}${a.path}`,
        page: answered,
        tail,
        lines: shown,
        ...(lines.length
          ? {}
          : {
              note:
                tail === 'open'
                  ? 'No log lines arrived while the page rendered. A page served from the cache logs nothing; a 500 with a digest means the error was logged under that digest, so try again.'
                  : `The runtime log could not be read (${tail}); the page's status and digest are above.`,
            }),
      },
      summary: `${a.path} on ${host}: ${answered ? (answered.status ? `answered ${answered.status}` : `no answer (${answered.title})`) : 'not requested'}; ${lines.length} log line${lines.length === 1 ? '' : 's'}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}`,
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
  createdAt?: number;
}

/** One line of a deployment's runtime log, as the agent reads it. */
interface LogLine {
  at: string | null;
  level: 'error' | 'warning' | 'info';
  message: string;
  path: string | null;
  status: number | null;
}

/** A runtime log line from Vercel's stream (one JSON object a line); anything else is dropped. */
function logLine(raw: string): LogLine | null {
  const t = raw.trim();
  if (!t) return null;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = String(d.message ?? d.text ?? '').trim();
  if (!message && d.responseStatusCode == null) return null;
  const level = String(d.level ?? d.type ?? 'info').toLowerCase();
  const ts = Number(d.timestampInMs ?? d.timestamp ?? d.date);
  return {
    at: Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : null,
    level: /err|fatal/.test(level) ? 'error' : /warn/.test(level) ? 'warning' : 'info',
    message: message.length > 4000 ? `${message.slice(0, 4000)}…` : message,
    path: typeof d.requestPath === 'string' ? d.requestPath : null,
    status: typeof d.responseStatusCode === 'number' ? d.responseStatusCode : null,
  };
}

function productionUrl(p: VercelProject): string | null {
  const alias = p.targets?.production?.alias?.[0] ?? p.alias?.[0]?.domain;
  return alias ? `https://${alias}` : null;
}

const message = (r: { body: unknown }) =>
  (r.body as { error?: { message?: string } } | null)?.error?.message;

function fail(r: { status: number; body: unknown }, doing: string, hint = ''): ToolResult {
  const m = message(r);
  const error = `Vercel answered ${r.status} ${doing}${m ? `: ${m}` : ''}.${hint}`;
  return { code: r.status, body: { error }, summary: error };
}
