import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';

/**
 * The SitecoreAI Deploy API, with the organization automation client: finds the project's
 * environment by its CM host and registers the head as its editing host, so Page builder renders
 * pages through it. Context IDs and secrets it reads never leave the server.
 */

export const DEPLOY_API = 'https://xmclouddeploy-api.sitecorecloud.io';

export interface DeployFacts {
  cmHost: string;
  /** Hosts the head is deployed on (from the hosting server): the only ones that may be registered. */
  headHosts: string[];
}

export interface DeployServerOptions {
  facts(projectId: string): Promise<DeployFacts | null>;
  fetch?: typeof fetch;
  api?: string;
}

interface Environment {
  id: string;
  name: string | null;
  projectName: string | null;
  host: string | null;
  provisioningStatus?: string | null;
}

/** A small client for the endpoints this server and the head's environment need. */
export class DeployClient {
  private readonly fetch: typeof fetch;
  constructor(
    private readonly token: string,
    opts: { fetch?: typeof fetch; api?: string } = {},
  ) {
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.api = opts.api ?? DEPLOY_API;
  }
  private readonly api: string;

  async request(method: string, path: string, body?: unknown) {
    const res = await this.fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed };
  }

  /** The environment whose CM host is this one, across every page of the organization's list. */
  async environmentFor(cmHost: string): Promise<Environment | { error: string; status: number }> {
    const want = cmHost.toLowerCase();
    for (let page = 1; page <= 20; page++) {
      const r = await this.request('GET', `/api/environments/v1?pageNumber=${page}&pageSize=100`);
      if (r.status !== 200) return { status: r.status, error: problem(r, 'listing environments') };
      const body = r.body as { data?: Environment[]; totalCount?: number } | Environment[];
      const list = Array.isArray(body) ? body : (body.data ?? []);
      const hit = list.find((e) => (e.host ?? '').toLowerCase() === want);
      if (hit) return hit;
      if (list.length < 100) break;
    }
    return { status: 404, error: `No environment in the organization has the CM host ${cmHost}.` };
  }

  /** The environment's editing secret, which the head checks on every Page builder request. */
  async editingSecret(environmentId: string): Promise<string | null> {
    const r = await this.request(
      'GET',
      `/api/environments/v1/${encodeURIComponent(environmentId)}/obtain-editing-secret`,
    );
    if (r.status !== 200) return null;
    return (r.body as { apiKey?: string | null }).apiKey ?? null;
  }
}

const problem = (r: { status: number; body: unknown }, doing: string) => {
  const b = r.body as { detail?: string; title?: string } | null;
  const why = b?.detail ?? b?.title;
  return `The Deploy API answered ${r.status} ${doing}${why ? `: ${why}` : ''}.`;
};

const RegisterArgs = z.object({
  /** The head's base URL, e.g. https://acme-site.vercel.app */
  url: z.url({ protocol: /^https$/ }),
  /** The rendering host key from xmcloud.build.json; it must match exactly. */
  applicationName: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'letters, digits, dot, dash'),
});

export class SitecoreDeployToolServer implements ToolServer {
  readonly name = 'sitecore-deploy';
  readonly catalog: OperationCatalog = {
    'environment.read': {
      description:
        "The project's SitecoreAI environment, found by its CM host: id, name, project and status. Context IDs and secrets are never returned.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'editing-host.read': {
      description:
        "The editing hosts registered for the project's environment: application name and rendering URLs.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'editing-host.register': {
      description:
        "Register the head as the environment's editing host, so Page builder renders through it. `url` is the head's base URL and must be one the hosting server deployed for this project; `applicationName` is the rendering host key from the build repository's xmcloud.build.json, exactly. The render and config endpoints are /api/editing/render and /api/editing/config. Read it back with editing-host.read.",
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, applicationName: { type: 'string' } },
        required: ['url', 'applicationName'],
        additionalProperties: false,
      },
      mutates: true,
      releases: true,
    },
  };

  constructor(private readonly opts: DeployServerOptions) {}

  target(projectId: string) {
    return `sitecore-deploy:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const facts = await this.opts.facts(ctx.projectId);
    if (!facts) return { code: 409, body: { error: 'This project has no SitecoreAI target.' } };
    const client = new DeployClient(ctx.token, { fetch: this.opts.fetch, api: this.opts.api });
    const env = await client.environmentFor(facts.cmHost);
    if ('error' in env) return { code: env.status, body: { error: env.error }, summary: env.error };
    const envPath = `/api/hosts/v1/environment/${encodeURIComponent(env.id)}`;
    switch (op) {
      case 'environment.read':
        return {
          code: 200,
          body: {
            id: env.id,
            name: env.name,
            project: env.projectName,
            host: env.host,
            status: env.provisioningStatus ?? null,
          },
          summary: `Environment ${env.name ?? env.id} (${env.projectName ?? 'project'}) for ${facts.cmHost}`,
        };
      case 'editing-host.read': {
        const r = await client.request('GET', envPath);
        if (r.status === 404)
          return { code: 200, body: { hosts: [] }, summary: 'No editing hosts' };
        if (r.status !== 200) return fail(r, 'reading editing hosts');
        const hosts = (r.body as Record<string, unknown>[]).map((h) => ({
          id: h.id,
          applicationName: h.applicationName,
          renderingEngineApplicationUrl: h.renderingEngineApplicationUrl,
          renderingEngineEndpointUrl: h.renderingEngineEndpointUrl,
          renderingEngineConfigUrl: h.renderingEngineConfigUrl,
        }));
        return {
          code: 200,
          body: { hosts },
          summary: `${hosts.length} editing host${hosts.length === 1 ? '' : 's'}: ${hosts.map((h) => h.applicationName).join(', ') || 'none'}`,
        };
      }
      case 'editing-host.register': {
        const a = RegisterArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        const base = new URL(a.data.url);
        if (!facts.headHosts.includes(base.host)) {
          return bad(
            `${base.host} isn't a host this project's head is deployed on (${facts.headHosts.join(', ') || 'none yet'}). Deploy it with the hosting tools first.`,
          );
        }
        const origin = base.origin;
        const r = await client.request('PUT', envPath, {
          cmEnvironmentId: env.id,
          editingHostEnvironmentId: null,
          applicationName: a.data.applicationName,
          renderingEngineEndpointUrl: `${origin}/api/editing/render`,
          renderingEngineApplicationUrl: origin,
          renderingEngineConfigUrl: `${origin}/api/editing/config`,
        });
        if (r.status !== 201 && r.status !== 200) return fail(r, 'registering the editing host');
        const h = r.body as { id?: string };
        return {
          code: 200,
          body: { id: h.id ?? null, applicationName: a.data.applicationName, url: origin },
          summary: `Registered ${origin} as editing host "${a.data.applicationName}"`,
        };
      }
      default:
        return { code: 404, body: { error: `Unknown operation ${op}` } };
    }
  }
}

const bad = (message: string): ToolResult => ({
  code: 422,
  body: { error: message },
  summary: message,
});
const fail = (r: { status: number; body: unknown }, doing: string): ToolResult => {
  const error = problem(r, doing);
  return { code: r.status, body: { error }, summary: error };
};
