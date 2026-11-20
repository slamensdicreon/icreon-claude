/** An in-memory Optimizely CMS REST API v1, as far as the tool server uses it. */
export interface FakeCms {
  fetch: typeof fetch;
  content: Map<string, { node: Record<string, unknown>; versions: Record<string, unknown>[] }>;
  applications: Map<string, Record<string, unknown>>;
  blueprints: Map<string, Record<string, unknown>>;
  calls: { method: string; path: string; body?: unknown }[];
  uploads: { name: string; type: string; bytes: number }[];
}

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
const problem = (status: number, detail: string) => json(status, { status, detail, errors: [] });

export function fakeCms(
  opts: { types?: Record<string, string>; denyContent?: boolean } = {},
): FakeCms {
  const types = opts.types ?? {};
  const state: FakeCms = {
    content: new Map(),
    applications: new Map(),
    blueprints: new Map(),
    calls: [],
    uploads: [],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/v1/, '');
      const method = init?.method ?? 'GET';
      let body: Record<string, unknown> | undefined;
      let file: File | undefined;
      if (init?.body instanceof FormData) {
        body = JSON.parse(await (init.body.get('content') as Blob).text()) as Record<
          string,
          unknown
        >;
        file = init.body.get('file') as File;
      } else if (typeof init?.body === 'string')
        body = JSON.parse(init.body) as Record<string, unknown>;
      state.calls.push({ method, path, body });
      let m: RegExpExecArray | null;

      if (path === '/applications' && method === 'GET')
        return json(200, { items: [...state.applications.values()] });
      if (path === '/applications' && method === 'POST') {
        const key = String(body!.key);
        const app = { ...body, assetsRoot: `cms://content/${'a'.repeat(32)}` };
        state.applications.set(key, app);
        state.content.set('a'.repeat(32), {
          node: { key: 'a'.repeat(32), contentType: 'SysContentFolder' },
          versions: [],
        });
        return json(201, app);
      }
      if ((m = /^\/applications\/(\w+)$/.exec(path))) {
        const app = state.applications.get(m[1]!);
        if (!app) return problem(404, 'Not found');
        if (method === 'PATCH') Object.assign(app, body);
        return json(200, app);
      }
      if ((m = /^\/contenttypes\/(\w+)$/.exec(path)))
        return types[m[1]!]
          ? json(200, { key: m[1], baseType: types[m[1]!] })
          : problem(404, 'Not found');
      if (path === '/blueprints' && method === 'GET')
        return json(200, { items: [...state.blueprints.values()] });
      if (path === '/blueprints' && method === 'POST') {
        state.blueprints.set(String(body!.key), body!);
        return json(201, body);
      }
      if ((m = /^\/blueprints\/(\w+)$/.exec(path))) {
        const b = state.blueprints.get(m[1]!);
        if (!b) return problem(404, 'Not found');
        if (method === 'PATCH') Object.assign(b, body);
        return json(200, b);
      }
      if (path === '/content' && method === 'POST') {
        if (opts.denyContent)
          return problem(
            403,
            `Access was denied to content with key '${String(body!.key)}'. Required access is 'create'.`,
          );
        const key = String(body!.key);
        const version = {
          ...(body!.initialVersion as object),
          version: '1',
          status: 'draft',
          contentType: body!.contentType,
        };
        state.content.set(key, {
          node: { key, container: body!.container, contentType: body!.contentType },
          versions: [version],
        });
        if (file) state.uploads.push({ name: file.name, type: file.type, bytes: file.size });
        return json(201, { key, contentType: body!.contentType, initialVersion: version });
      }
      if ((m = /^\/content\/(\w+)$/.exec(path))) {
        const c = state.content.get(m[1]!);
        return c ? json(200, c.node) : problem(404, 'Not found');
      }
      if ((m = /^\/content\/(\w+)\/items$/.exec(path)))
        return json(200, {
          items: [...state.content.values()]
            .filter((c) => c.node.container === m![1])
            .map((c) => c.node),
        });
      if ((m = /^\/content\/(\w+)\/versions$/.exec(path))) {
        const c = state.content.get(m[1]!);
        if (!c) return problem(404, 'Not found');
        if (method === 'POST') {
          const version = {
            ...body,
            version: String(c.versions.length + 1),
            status: 'draft',
            contentType: c.node.contentType,
          };
          c.versions.push(version);
          return json(201, version);
        }
        return json(200, { items: c.versions });
      }
      if ((m = /^\/content\/(\w+)\/versions\/(\d+):publish$/.exec(path))) {
        const c = state.content.get(m[1]!);
        const v = c?.versions.find((x) => x.version === m![2]);
        if (!v) return problem(404, 'Not found');
        v.status = 'published';
        return json(200, v);
      }
      return problem(404, `No fake for ${method} ${path}`);
    }) as typeof fetch,
  };
  return state;
}
