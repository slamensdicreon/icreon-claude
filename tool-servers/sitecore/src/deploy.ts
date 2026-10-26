import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';
import { DeployClient, problem } from '@lw/connectors';

export { DEPLOY_API, DeployClient } from '@lw/connectors';

/**
 * The SitecoreAI Deploy API, with the organization automation client: finds the project's
 * environment by its CM host and registers the head as its editing host, so Page builder renders
 * pages through it. Context IDs and secrets it reads never leave the server.
 */

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
