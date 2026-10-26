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
  /** "cm" or an editing host's type; editing hosts are listed as environments too. */
  type?: string | null;
  /** Set on an editing host: the CM environment it renders for. */
  editingHostEnvironmentDetails?: { cmEnvironmentId?: string | null } | null;
}

/** An editing host listed among the environments: it has no editing secret of its own. */
const isEditingHost = (e: DeployEnvironment) =>
  Boolean(e.editingHostEnvironmentDetails?.cmEnvironmentId) || /^(eh|editing)/i.test(e.type ?? '');

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

  /**
   * The CM environment whose host is this one. Editing hosts are listed as environments too and
   * can carry the same host, so the whole list is read and the CM environment preferred; an
   * editing host alone leads to the CM environment it renders for.
   */
  async environmentFor(
    cmHost: string,
  ): Promise<DeployEnvironment | { error: string; status: number }> {
    const want = cmHost.toLowerCase();
    const all: DeployEnvironment[] = [];
    // The API refuses a page size over 50 ("validation errors").
    const size = 50;
    for (let page = 1; page <= 40; page++) {
      const r = await this.request(
        'GET',
        `/api/environments/v1?pageNumber=${page}&pageSize=${size}`,
      );
      if (r.status !== 200) return { status: r.status, error: problem(r, 'listing environments') };
      const body = r.body as
        { data?: DeployEnvironment[]; totalCount?: number } | DeployEnvironment[];
      const list = Array.isArray(body) ? body : (body.data ?? []);
      all.push(...list);
      if (list.length < size) break;
    }
    const hits = all.filter((e) => (e.host ?? '').toLowerCase() === want);
    const cm = hits.find((e) => !isEditingHost(e));
    if (cm) return cm;
    const cmId = hits.find(isEditingHost)?.editingHostEnvironmentDetails?.cmEnvironmentId;
    const owner = cmId ? all.find((e) => e.id === cmId) : undefined;
    if (owner) return owner;
    return { status: 404, error: `No environment in the organization has the CM host ${cmHost}.` };
  }

  /** The environment's editing secret, which the head checks on every Page builder request. */
  async editingSecret(environmentId: string): Promise<{ secret: string } | { problem: string }> {
    const r = await this.request(
      'GET',
      `/api/environments/v1/${encodeURIComponent(environmentId)}/obtain-editing-secret`,
    );
    if (r.status !== 200) return { problem: problem(r, 'reading the editing secret') };
    // The API's definition says { apiKey }; a bare string or another name is taken too.
    const body = r.body;
    const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const secret =
      typeof body === 'string' && /^\S{16,}$/.test(body)
        ? body
        : [fields.apiKey, fields.editingSecret, fields.secret].find(
            (v): v is string => typeof v === 'string' && v.length > 0,
          );
    if (secret) return { secret };
    // Field names only, never values: enough to see what the API actually answered.
    const names = Object.keys(fields);
    return {
      problem: `The Deploy API returned no editing secret for this environment (${
        names.length
          ? `its answer has ${names.map((n) => `${n}${fields[n] == null || fields[n] === '' ? ' (empty)' : ''}`).join(', ')}`
          : `its answer was ${typeof body === 'string' ? (body ? 'text' : 'empty') : String(body)}`
      }). Copy SITECORE_EDITING_SECRET from the Deploy app's Developer settings into the SitecoreAI editing secret credential in Settings instead.`,
    };
  }
}

export const problem = (r: { status: number; body: unknown }, doing: string) => {
  const b = r.body as { detail?: string; title?: string } | null;
  const why = b?.detail ?? b?.title;
  return `The Deploy API answered ${r.status} ${doing}${why ? `: ${why}` : ''}.`;
};
