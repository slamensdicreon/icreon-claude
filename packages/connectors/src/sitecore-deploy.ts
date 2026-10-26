/**
 * The SitecoreAI Deploy API, with an organization automation client: finds an environment by its
 * CM host and reads its editing secret. Used by the organization credential's check and by the
 * sitecore-deploy tool server, so a passing check means the agents' calls work too.
 */

export const DEPLOY_API = 'https://xmclouddeploy-api.sitecorecloud.io';

export interface DeployEnvironment {
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
  async environmentFor(
    cmHost: string,
  ): Promise<DeployEnvironment | { error: string; status: number }> {
    const want = cmHost.toLowerCase();
    // The API refuses a page size over 50 ("validation errors").
    const size = 50;
    for (let page = 1; page <= 40; page++) {
      const r = await this.request(
        'GET',
        `/api/environments/v1?pageNumber=${page}&pageSize=${size}`,
      );
      if (r.status !== 200) return { status: r.status, error: problem(r, 'listing environments') };
      const body = r.body as { data?: DeployEnvironment[]; totalCount?: number } | DeployEnvironment[];
      const list = Array.isArray(body) ? body : (body.data ?? []);
      const hit = list.find((e) => (e.host ?? '').toLowerCase() === want);
      if (hit) return hit;
      if (list.length < size) break;
    }
    return { status: 404, error: `No environment in the organization has the CM host ${cmHost}.` };
  }

  /** The environment's editing secret, which the head checks on every Page builder request. */
  async editingSecret(environmentId: string): Promise<{ secret: string } | { problem: string }> {
    const r = await this.request(
      'GET',
      `/api/environments/v1/${encodeURIComponent(environmentId)}/obtain-editing-secret`,
    );
    if (r.status !== 200) return { problem: problem(r, 'reading the editing secret') };
    const secret = (r.body as { apiKey?: string | null } | null)?.apiKey;
    return secret
      ? { secret }
      : { problem: 'The Deploy API returned no editing secret for this environment.' };
  }
}

export const problem = (r: { status: number; body: unknown }, doing: string) => {
  const b = r.body as { detail?: string; title?: string } | null;
  const why = b?.detail ?? b?.title;
  return `The Deploy API answered ${r.status} ${doing}${why ? `: ${why}` : ''}.`;
};
