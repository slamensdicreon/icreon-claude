import { createHash } from 'node:crypto';
import type {
  BlobStore,
  OperationCatalog,
  ToolCallContext,
  ToolResult,
  ToolServer,
} from '@lw/tool-gateway';
import { rejected } from '@lw/tool-gateway';
import { z } from 'zod';

/**
 * Optimizely CMS (SaaS) through its REST API v1: applications, content types (read only: the
 * content model is code, pushed by the CLI in the sandbox), content, Visual Builder compositions,
 * blueprints and media.
 *
 * Optimizely addresses content by key, and the gateway scopes roles by path, so this server gives
 * every item the team makes a path of its own:
 *
 *   /content/<application>            the application's start page
 *   /content/<application>/<name>/…   pages below it
 *   /shared/<application>/<name>/…    shared blocks (header, footer, navigation), in the application's own assets
 *   /media/<application>/<name>/…     media, in the application's own assets
 *   /applications/<application>, /contenttypes/<key>, /displaytemplates/<key>
 *
 * An item's key is derived from its path, so creating the same path twice finds the first item
 * instead of making a second, and a later task reaches it without looking anything up. Items an
 * editor made in the CMS itself have no such path: they are read by key.
 *
 * The server only ever writes inside the project's own application and only content of types
 * carrying the project's prefix: an instance, its content types and its Graph index are shared
 * by every application on it.
 */

/** What the server knows about the project's Optimizely target, from intake. */
export interface OptimizelyFacts {
  /** The instance's origin, `https://app-<id>.cms.optimizely.com`. */
  cmsUrl: string;
  /** The application's key: letters, digits and underscores. */
  application: string;
  /** How the application is named for people. */
  applicationName: string;
  /** Content type and display template keys this project owns start with it. */
  typePrefix: string;
  languages: string[];
  /** The source site's hosts, the only place media may be downloaded from. */
  sourceHosts: string[];
  /** Hosts the project's head is deployed on: the only ones that may become the application's. */
  headHosts: string[];
}

export interface OptimizelyCmsServerOptions {
  facts(projectId: string): Promise<OptimizelyFacts | null>;
  fetch?: typeof fetch;
  /** The REST API gateway. */
  apiUrl?: string;
  /** Where downloads are stored: media.upload takes a file the browser already fetched. */
  blobs?: BlobStore;
}

/** The container every application's start page sits in: the same key on every instance. */
export const ROOT_CONTAINER = '43f936c99b234ea397b261c538ad07c9';
const API_URL = 'https://api.cms.optimizely.com';
const MAX_MEDIA_BYTES = 25_000_000;
/** What the image content type takes. AVIF is not among them. */
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
};
const NO_ACCESS =
  'The API key has no content rights on this instance: its scope lets it push content types, but content is governed by access rights. A CMS admin gives the key (its client ID) Read, Create, Change, Delete and Publish on the Root, in Settings > Set Access Rights. Raise this as an access blocker; retrying will not help.';

export { applicationKey } from '@lw/connectors';

const NO_BLUEPRINTS =
  "The API key may not create blueprints on this instance. That is a right of its own, separate from content rights (a key that creates and publishes pages is still refused). Don't retry: say so in your result. An editor makes the blueprint in Visual Builder from a finished page (the page's menu, save as blueprint), or a CMS admin gives the key that right.";

/** The key of the item at a path of this instance: the same path always gives the same key. */
export function keyForPath(cmsUrl: string, path: string): string {
  const host = cmsUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return createHash('md5')
    .update(`launchworks:${host}:${path.toLowerCase().replace(/\/+$/, '')}`)
    .digest('hex');
}

export const contentRef = (key: string) => `cms://content/${key}`;
const refKey = (ref: string | null | undefined) =>
  (ref ?? '').replace(/^cms:\/\/content\//, '').replace(/-/g, '');
const guid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

type Space = 'content' | 'shared' | 'media';
const SPACES: Space[] = ['content', 'shared', 'media'];

interface Located {
  space: Space;
  /** The path as given, normalized. */
  path: string;
  /** Segments below `/<space>/<application>`. */
  below: string[];
}

const ItemPath = z
  .string()
  .max(500)
  .regex(
    /^\/(content|shared|media)\/[^/]+(\/[^/]+)*\/?$/,
    'a path: /content/<application>/…, /shared/<application>/… or /media/<application>/…',
  );
const Key = z.string().regex(/^[0-9a-f]{32}$/i, 'a content key (32 hex digits)');
const TypeKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/, 'a content type key');
/** Property values as an agent writes them: plain values, wrapped for the API by `toProperties`. */
const Properties = z.record(z.string(), z.unknown());
const Node = z.object({
  /** The section's name in Visual Builder's outline. */
  name: z.string().min(1).max(200),
  contentType: TypeKey,
  /** The display template's key; the type's default when left out. */
  displayTemplate: z.string().max(100).optional(),
  settings: z.record(z.string(), z.string()).optional(),
  properties: Properties.optional(),
});

const ReadArgs = z
  .object({
    path: ItemPath.optional(),
    key: Key.optional(),
    children: z.boolean().optional(),
    locale: z.string().max(20).optional(),
  })
  .refine((a) => Boolean(a.path) !== Boolean(a.key), 'give either path or key');
const CreateArgs = z.object({
  path: ItemPath,
  contentType: TypeKey,
  displayName: z.string().min(1).max(200).optional(),
  /** A page's "name in URL"; from the path's last segment when left out. */
  routeSegment: z.string().max(200).optional(),
  properties: Properties.optional(),
  locale: z.string().max(20).optional(),
});
const UpdateArgs = z.object({
  path: ItemPath,
  displayName: z.string().min(1).max(200).optional(),
  properties: Properties,
  locale: z.string().max(20).optional(),
});
const CompositionArgs = z.object({
  path: ItemPath,
  nodes: z.array(Node).min(1).max(100),
  locale: z.string().max(20).optional(),
});
const PublishArgs = z.object({ path: ItemPath, locale: z.string().max(20).optional() });
const ApplicationArgs = z.object({
  /** The content type of the application's start page: an experience or page type of this project. */
  entryType: TypeKey,
  /** The start page's name. */
  entryName: z.string().min(1).max(200).optional(),
});
const HostArgs = z.object({
  /** The head's host, e.g. acme.vercel.app */
  host: z
    .string()
    .max(253)
    .regex(/^[a-z0-9.-]+(:\d+)?$/i, 'a host name, without scheme or path'),
});
const PreviewArgs = z.object({
  /** The preview route on the head; Visual Builder opens it in its frame. */
  route: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]*$/, 'a path on the head, e.g. /preview')
    .optional(),
});
const TypeListArgs = z.object({
  /** Every type on the instance, not only this project's. */
  all: z.boolean().optional(),
});
const TypeReadArgs = z.object({ key: TypeKey });
const BlueprintArgs = z.object({
  name: z.string().min(1).max(200),
  contentType: TypeKey,
  nodes: z.array(Node).max(100).optional(),
  properties: Properties.optional(),
});
const MediaArgs = z
  .object({
    path: z
      .string()
      .max(500)
      .regex(
        /^\/media\/[^/]+(\/[^/]+)+$/,
        'a path under /media/<application>/, ending in the file name',
      ),
    sourceUrl: z.url({ protocol: /^https$/ }).optional(),
    /** A file browser.fetch.asset stored (its `ref`), so it isn't downloaded twice. */
    ref: z.string().startsWith('blob://').max(500).optional(),
    alt: z.string().max(500).optional(),
  })
  .refine((a) => Boolean(a.sourceUrl) !== Boolean(a.ref), 'give either ref or sourceUrl');

const node = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    contentType: { type: 'string' },
    displayTemplate: { type: 'string' },
    settings: { type: 'object' },
    properties: { type: 'object' },
  },
  required: ['name', 'contentType'],
};
const VALUES =
  'Property values are written plainly: text as a string, a boolean or number as itself, rich text as { html }, a link as { url, text, title?, target? }, an item of a list of inline components as { properties } (the type of the list says what each item is), a list as an array of those. To point at another item (an image, a shared block, a page) give its path (/media/…, /shared/…, /content/…) or "cms://content/<key>".';

export class OptimizelyCmsToolServer implements ToolServer {
  readonly name = 'optimizely-cms';
  readonly catalog: OperationCatalog = {
    'application.list': {
      description:
        'List the applications (websites) on the instance: key, name, start page, hosts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'application.read': {
      description:
        "Read this project's application: its start page, hosts, preview URL format and assets root. 404 until application.create has run.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'application.create': {
      description:
        "Create this project's application and its start page (an empty draft of entryType, a page or experience type carrying the project's prefix, already pushed). The application gets assets of its own. Safe to repeat: an application that exists is returned as it is.",
      inputSchema: {
        type: 'object',
        properties: { entryType: { type: 'string' }, entryName: { type: 'string' } },
        required: ['entryType'],
        additionalProperties: false,
      },
      mutates: true,
      lockPaths: () => ['/applications'],
    },
    'hostname.add': {
      description:
        "Make a host the head is deployed on the application's primary host, so routes resolve on it and Visual Builder opens its preview there. Only hosts of this project's own deployments are accepted.",
      inputSchema: {
        type: 'object',
        properties: { host: { type: 'string' } },
        required: ['host'],
        additionalProperties: false,
      },
      mutates: true,
      releases: true,
      lockPaths: () => ['/applications'],
    },
    'hostname.remove': {
      description: "Remove a host from this project's application.",
      inputSchema: {
        type: 'object',
        properties: { host: { type: 'string' } },
        required: ['host'],
        additionalProperties: false,
      },
      mutates: true,
      releases: true,
      lockPaths: () => ['/applications'],
    },
    'preview.configure': {
      description:
        "Point Visual Builder's live preview at the head's preview route (default /preview) with preview tokens on.",
      inputSchema: {
        type: 'object',
        properties: { route: { type: 'string' } },
        additionalProperties: false,
      },
      mutates: true,
      releases: true,
      lockPaths: () => ['/applications'],
    },
    'locale.list': {
      description: 'List the locales on the instance and whether each is enabled.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'contenttype.list': {
      description:
        "List the content types carrying this project's prefix (key, base type, composition behaviours, property names). all: true lists every type on the instance, other teams' included, which this project never changes.",
      inputSchema: {
        type: 'object',
        properties: { all: { type: 'boolean' } },
        additionalProperties: false,
      },
      mutates: false,
    },
    'contenttype.read': {
      description: 'Read one content type with its properties, as the CMS stores it.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
      mutates: false,
    },
    'displaytemplate.list': {
      description:
        "List the display templates carrying this project's prefix, with the content type each belongs to and its settings. all: true lists every template on the instance.",
      inputSchema: {
        type: 'object',
        properties: { all: { type: 'boolean' } },
        additionalProperties: false,
      },
      mutates: false,
    },
    'displaytemplate.read': {
      description: 'Read one display template with its settings and choices.',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false,
      },
      mutates: false,
    },
    'manifest.export': {
      description:
        "Export the content model as the CMS holds it, narrowed to this project's content types and display templates: what a dry-run push from the repository must reproduce.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'content.read': {
      description:
        'Read an item the team made, by its path, or any item by key: content type, status, properties and, for an experience, its composition. children: true also lists what is directly under it. /content/<application> is the start page.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          key: { type: 'string' },
          children: { type: 'boolean' },
          locale: { type: 'string' },
        },
        additionalProperties: false,
      },
      mutates: false,
      pathArgs: ['path'],
    },
    'content.create': {
      description: `Create an item at a path as a draft: a page under /content/<application>/…, or a shared block under /shared/<application>/… (folders on the way are made). The content type must carry the project's prefix. Creating a path that exists writes a new draft of that item instead of a second item. ${VALUES}`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          contentType: { type: 'string' },
          displayName: { type: 'string' },
          routeSegment: { type: 'string' },
          properties: { type: 'object' },
          locale: { type: 'string' },
        },
        required: ['path', 'contentType'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['path'],
    },
    'content.update': {
      description: `Set properties on an item (by path) as a new draft: the properties you give replace those values, every other property and the composition stay. ${VALUES}`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          displayName: { type: 'string' },
          properties: { type: 'object' },
          locale: { type: 'string' },
        },
        required: ['path', 'properties'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['path'],
    },
    'composition.write': {
      description: `Compose an experience (by path) in Visual Builder's outline: one section per node, in order, each a section-enabled content type of this project with its display template, settings and properties. Replaces the page's sections as a new draft; its own properties stay. ${VALUES}`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          nodes: { type: 'array', items: node },
          locale: { type: 'string' },
        },
        required: ['path', 'nodes'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['path'],
    },
    'content.previews': {
      description:
        "The addresses Visual Builder opens for an item's latest version (by path): the head's preview route with a short-lived preview token, as a visitor preview and as the editing frame. For checking the preview renders a draft; the token is good for a few minutes and reads only that item.",
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, locale: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      mutates: false,
      pathArgs: ['path'],
    },
    'content.publish': {
      description:
        'Publish the latest draft of an item (by path), so Optimizely Graph serves it. An item with nothing to publish is reported as already published.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, locale: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      mutates: true,
      releases: true,
      pathArgs: ['path'],
    },
    'blueprint.list': {
      description:
        'List the blueprints on the instance: name, key and the content type each starts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'blueprint.create': {
      description: `Create a blueprint: a starting composition for new experiences of a content type of this project, which editors pick when they create a page. Safe to repeat for the same name. ${VALUES}`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          contentType: { type: 'string' },
          nodes: { type: 'array', items: node },
          properties: { type: 'object' },
        },
        required: ['name', 'contentType'],
        additionalProperties: false,
      },
      mutates: true,
      lockPaths: (a) => [`/blueprints/${String(a.name)}`],
    },
    'media.upload': {
      description:
        "Upload an image to the application's own media at /media/<application>/<folder…>/<file name>, with its alt text, and publish it. Give the ref of a file browser.fetch.asset stored, or a sourceUrl on the source site. Uploading a path that exists returns the item already there. AVIF is not accepted by the CMS: download it as WebP, PNG or JPEG first.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          sourceUrl: { type: 'string' },
          ref: { type: 'string' },
          alt: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['path'],
    },
  };

  private readonly fetch: typeof fetch;
  private readonly api: string;

  constructor(private readonly opts: OptimizelyCmsServerOptions) {
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.api = (opts.apiUrl ?? API_URL).replace(/\/$/, '');
  }

  target(projectId: string) {
    return `optimizely:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const facts = await this.opts.facts(ctx.projectId);
    if (!facts) return { code: 409, body: { error: 'This project has no Optimizely target.' } };
    if (!facts.application || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(facts.application))
      return rejected(
        `"${facts.application}" is not an application key Optimizely accepts (letters, digits and underscores, not starting with a digit).`,
      );
    const rest = new Rest(this.fetch, `${this.api}/v1`, ctx.token);
    const w = new Work(rest, facts);
    try {
      switch (op) {
        case 'application.list':
          return await w.applications();
        case 'application.read':
          return await w.applicationRead();
        case 'application.create':
          return await w.applicationCreate(ApplicationArgs.safeParse(args));
        case 'hostname.add':
          return await w.host(HostArgs.safeParse(args), true);
        case 'hostname.remove':
          return await w.host(HostArgs.safeParse(args), false);
        case 'preview.configure':
          return await w.preview(PreviewArgs.safeParse(args));
        case 'locale.list':
          return await w.locales();
        case 'contenttype.list':
          return await w.types('contenttypes', TypeListArgs.safeParse(args));
        case 'contenttype.read':
          return await w.typeRead('contenttypes', TypeReadArgs.safeParse(args));
        case 'displaytemplate.list':
          return await w.types('displaytemplates', TypeListArgs.safeParse(args));
        case 'displaytemplate.read':
          return await w.typeRead('displaytemplates', TypeReadArgs.safeParse(args));
        case 'manifest.export':
          return await w.manifest();
        case 'content.read':
          return await w.read(ReadArgs.safeParse(args));
        case 'content.create':
          return await w.create(CreateArgs.safeParse(args));
        case 'content.update':
          return await w.update(UpdateArgs.safeParse(args));
        case 'composition.write':
          return await w.compose(CompositionArgs.safeParse(args));
        case 'content.previews':
          return await w.previews(PublishArgs.safeParse(args));
        case 'content.publish':
          return await w.publish(PublishArgs.safeParse(args));
        case 'blueprint.list':
          return await w.blueprints();
        case 'blueprint.create':
          return await w.blueprint(BlueprintArgs.safeParse(args));
        case 'media.upload':
          return await w.media(MediaArgs.safeParse(args), ctx, this.opts.blobs, this.fetch);
        default:
          return { code: 404, body: { error: `Unknown operation ${op}` } };
      }
    } catch (err) {
      if (err instanceof RestError)
        return { code: err.status, body: { error: err.message }, summary: err.message };
      throw err;
    }
  }
}

class RestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Answer {
  status: number;
  body: unknown;
}

/** The REST API: JSON in and out, its problem details turned into one plain sentence. */
class Rest {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly base: string,
    private readonly token: string,
  ) {}

  async send(
    method: string,
    route: string,
    opts: { json?: unknown; form?: FormData; patch?: boolean; ok?: number[] } = {},
  ): Promise<Answer> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
      prefer: 'return=representation',
    };
    let body: string | FormData | undefined;
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) {
      headers['content-type'] = opts.patch ? 'application/merge-patch+json' : 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await this.fetch(`${this.base}${route}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    const ok = opts.ok ?? [200, 201, 204];
    if (!ok.includes(res.status)) throw new RestError(res.status, problem(res.status, parsed));
    return { status: res.status, body: parsed };
  }

  get = (route: string, ok?: number[]) => this.send('GET', route, { ok });
}

/** Optimizely's problem details as one sentence an agent can act on. */
function problem(status: number, body: unknown): string {
  const b = (body ?? {}) as {
    title?: string;
    detail?: string;
    errors?: { detail?: string; field?: string }[];
  };
  // Blueprints have a right of their own: a key with full content rights is still refused.
  if (status === 403 && /create blueprints/i.test(b.detail ?? '')) return NO_BLUEPRINTS;
  if (status === 403 && /required access is|access rights/i.test(b.detail ?? '')) return NO_ACCESS;
  if (status === 401)
    return 'Optimizely refused the API key (401): it may have been deleted or rotated. Check it in Settings.';
  const errors = (b.errors ?? [])
    .map((e) => [e.field, e.detail].filter(Boolean).join(': '))
    .filter(Boolean);
  const said = errors.length ? errors.join('; ') : (b.detail ?? b.title ?? '');
  return `Optimizely answered ${status}${said ? `: ${said}` : ''}`;
}

type Parsed<S extends z.ZodType> = z.ZodSafeParseResult<z.infer<S>>;
const invalid = (p: { error: z.ZodError }) => {
  const issue = p.error.issues[0]!;
  return rejected(`${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`);
};

interface Application {
  key: string;
  displayName: string;
  entryPoint: string;
  assetsRoot?: string | null;
  useApplicationSpecificAssets?: boolean;
  usePreviewTokens?: boolean;
  previewUrlFormats?: Record<string, string>;
  hosts?: { authority: string; type?: string; preferredUrlScheme?: string; locale?: string }[];
}
interface ContentNode {
  key: string;
  container?: string;
  contentType?: string;
  locales?: string[];
  deleted?: string | null;
}
interface Version {
  key?: string;
  locale?: string;
  version?: string;
  contentType?: string;
  displayName?: string;
  status?: string;
  routeSegment?: string;
  properties?: Record<string, { value?: unknown }>;
  composition?: unknown;
}

/** One call's work against one project's application. */
class Work {
  private app: Application | null | undefined;

  constructor(
    private readonly rest: Rest,
    private readonly facts: OptimizelyFacts,
  ) {}

  private get locale() {
    return this.facts.languages[0] ?? 'en';
  }

  private owns(typeKey: string): boolean {
    return typeKey.startsWith(this.facts.typePrefix);
  }

  // Applications

  async applications(): Promise<ToolResult> {
    const { body } = await this.rest.get('/applications?pageSize=100');
    const items = ((body as { items?: Application[] }).items ?? []).map(applicationView);
    return {
      code: 200,
      body: { applications: items },
      summary: `${items.length} application${items.length === 1 ? '' : 's'} on the instance`,
    };
  }

  private async application(): Promise<Application | null> {
    if (this.app !== undefined) return this.app;
    const { status, body } = await this.rest.get(
      `/applications/${this.facts.application}`,
      [200, 404],
    );
    this.app = status === 200 ? (body as Application) : null;
    return this.app;
  }

  async applicationRead(): Promise<ToolResult> {
    const app = await this.application();
    if (!app)
      return {
        code: 404,
        body: { error: `Application ${this.facts.application} does not exist yet.` },
        summary: `Application ${this.facts.application} does not exist yet: application.create makes it`,
      };
    return {
      code: 200,
      body: applicationView(app),
      summary: `Application ${app.key}: ${(app.hosts ?? []).map((h) => h.authority).join(', ') || 'no host yet'}`,
    };
  }

  async applicationCreate(a: Parsed<typeof ApplicationArgs>): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const existing = await this.application();
    if (existing)
      return {
        code: 200,
        body: { ...applicationView(existing), created: false },
        summary: `Application ${existing.key} already exists`,
      };
    if (!this.owns(a.data.entryType))
      return rejected(
        `${a.data.entryType} doesn't carry this project's prefix (${this.facts.typePrefix}): the start page is one of the project's own page or experience types.`,
      );
    const type = await this.rest.get(`/contenttypes/${a.data.entryType}`, [200, 404]);
    if (type.status === 404)
      return rejected(
        `Content type ${a.data.entryType} is not in the CMS yet: push the content model first (sandbox exec.optimizely-cli, config push).`,
      );
    const base = (type.body as { baseType?: string }).baseType;
    if (base !== '_experience' && base !== '_page')
      return rejected(
        `${a.data.entryType} is a ${base} type; a start page is a page or experience.`,
      );
    const path = `/content/${this.facts.application}`;
    const entryKey = keyForPath(this.facts.cmsUrl, path);
    const found = await this.node(entryKey);
    if (!found) {
      await this.rest.send('POST', '/content', {
        json: {
          key: entryKey,
          contentType: a.data.entryType,
          container: ROOT_CONTAINER,
          initialVersion: {
            locale: this.locale,
            displayName: a.data.entryName ?? this.facts.applicationName,
            routeSegment: slug(this.facts.applicationName) || slug(this.facts.application),
          },
        },
      });
    }
    const { body } = await this.rest.send('POST', '/applications', {
      json: {
        key: this.facts.application,
        displayName: this.facts.applicationName,
        type: 'website',
        entryPoint: contentRef(entryKey),
        isDefault: false,
        useApplicationSpecificAssets: true,
        usePreviewTokens: true,
        hosts: [],
      },
    });
    this.app = (body as Application | undefined)?.key
      ? (body as Application)
      : ((await this.rest.get(`/applications/${this.facts.application}`)).body as Application);
    return {
      code: 201,
      body: { ...applicationView(this.app), created: true, startPage: { path, key: entryKey } },
      summary: `Created application ${this.facts.application} with its start page (${a.data.entryType}, draft)`,
    };
  }

  private async requireApplication(): Promise<Application | ToolResult> {
    const app = await this.application();
    return (
      app ??
      rejected(
        `Application ${this.facts.application} does not exist yet: run application.create first.`,
        409,
      )
    );
  }

  async host(a: Parsed<typeof HostArgs>, add: boolean): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const app = await this.requireApplication();
    if (!('key' in app)) return app;
    const host = a.data.host.toLowerCase();
    const hosts = app.hosts ?? [];
    const has = hosts.some((h) => h.authority.toLowerCase() === host);
    if (add) {
      if (!this.facts.headHosts.map((h) => h.toLowerCase()).includes(host))
        return rejected(
          `${host} is not a host this project's head is deployed on (${this.facts.headHosts.join(', ') || 'none yet: deploy first'}).`,
        );
      if (has && hosts.find((h) => h.authority.toLowerCase() === host)?.type === 'primary')
        return {
          code: 200,
          body: applicationView(app),
          summary: `${host} is already the primary host`,
        };
    } else if (!has) {
      return {
        code: 200,
        body: applicationView(app),
        summary: `${host} is not a host of the application`,
      };
    }
    const kept = hosts.filter((h) => h.authority.toLowerCase() !== host);
    const next = add
      ? [
          // One primary host: the one before becomes an ordinary one.
          ...kept.map(({ type, ...h }) => (type === 'primary' ? h : { ...h, type })),
          { authority: host, type: 'primary', preferredUrlScheme: 'https' },
        ]
      : kept;
    const { body } = await this.rest.send('PATCH', `/applications/${app.key}`, {
      json: { hosts: next },
      patch: true,
    });
    const after = (body as Application | undefined)?.key
      ? (body as Application)
      : { ...app, hosts: next };
    return {
      code: 200,
      body: applicationView(after),
      summary: add
        ? `${host} is now the primary host of ${app.key}`
        : `Removed ${host} from ${app.key}`,
    };
  }

  async preview(a: Parsed<typeof PreviewArgs>): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const app = await this.requireApplication();
    if (!('key' in app)) return app;
    const route = a.data.route ?? '/preview';
    const format = `{host}${route}?key={key}&ver={version}&loc={locale}&ctx={context}`;
    if (app.usePreviewTokens && app.previewUrlFormats?.any === format)
      return {
        code: 200,
        body: applicationView(app),
        summary: `Live preview already opens ${route}`,
      };
    const { body } = await this.rest.send('PATCH', `/applications/${app.key}`, {
      json: { usePreviewTokens: true, previewUrlFormats: { any: format } },
      patch: true,
    });
    const after = (body as Application | undefined)?.key
      ? (body as Application)
      : { ...app, usePreviewTokens: true, previewUrlFormats: { any: format } };
    return {
      code: 200,
      body: applicationView(after),
      summary: `Live preview opens ${route} on the application's host, with preview tokens`,
    };
  }

  async locales(): Promise<ToolResult> {
    const { body } = await this.rest.get('/locales?pageSize=100');
    const items = (
      (body as { items?: { key: string; displayName?: string; isEnabled?: boolean }[] }).items ?? []
    ).map((l) => ({ key: l.key, name: l.displayName, enabled: l.isEnabled !== false }));
    return {
      code: 200,
      body: { locales: items },
      summary: `Enabled locales: ${
        items
          .filter((l) => l.enabled)
          .map((l) => l.key)
          .join(', ') || 'none'
      }`,
    };
  }

  // The content model (read only here: it is code, pushed by the CLI)

  private async all(kind: 'contenttypes' | 'displaytemplates'): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let page = 0; page < 20; page++) {
      const { body } = await this.rest.get(`/${kind}?pageSize=100&pageIndex=${page}`);
      const items = (body as { items?: Record<string, unknown>[] }).items ?? [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  async types(
    kind: 'contenttypes' | 'displaytemplates',
    a: Parsed<typeof TypeListArgs>,
  ): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const every = await this.all(kind);
    const mine = every.filter((t) => this.owns(String(t.key ?? '')));
    const shown = (a.data.all ? every : mine).map((t) =>
      kind === 'contenttypes'
        ? {
            key: t.key,
            displayName: t.displayName,
            baseType: t.baseType,
            compositionBehaviors: t.compositionBehaviors ?? [],
            properties: Object.keys((t.properties as object | undefined) ?? {}),
            source: t.source || undefined,
          }
        : {
            key: t.key,
            displayName: t.displayName,
            contentType: t.contentType || undefined,
            baseType: t.baseType || undefined,
            nodeType: t.nodeType || undefined,
            isDefault: t.isDefault === true,
            settings: Object.keys((t.settings as object | undefined) ?? {}),
          },
    );
    const what = kind === 'contenttypes' ? 'content types' : 'display templates';
    return {
      code: 200,
      body: {
        [kind === 'contenttypes' ? 'contentTypes' : 'displayTemplates']: shown,
        prefix: this.facts.typePrefix,
      },
      summary: `${mine.length} ${what} with the prefix ${this.facts.typePrefix}${a.data.all ? ` (${every.length} on the instance)` : ''}`,
    };
  }

  async typeRead(
    kind: 'contenttypes' | 'displaytemplates',
    a: Parsed<typeof TypeReadArgs>,
  ): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const { status, body } = await this.rest.get(`/${kind}/${a.data.key}`, [200, 404]);
    const what = kind === 'contenttypes' ? 'Content type' : 'Display template';
    if (status === 404)
      return {
        code: 404,
        body: { error: `${what} ${a.data.key} is not in the CMS.` },
        summary: `${what} ${a.data.key} is not in the CMS: push the content model, or check the key`,
      };
    return { code: 200, body, summary: `${what} ${a.data.key}` };
  }

  async manifest(): Promise<ToolResult> {
    const { body } = await this.rest.get('/manifest');
    const m = (body ?? {}) as {
      contentTypes?: { key?: string }[];
      displayTemplates?: { key?: string }[];
    };
    const contentTypes = (m.contentTypes ?? []).filter((t) => this.owns(t.key ?? ''));
    const displayTemplates = (m.displayTemplates ?? []).filter((t) => this.owns(t.key ?? ''));
    return {
      code: 200,
      body: { contentTypes, displayTemplates },
      summary: `Manifest: ${contentTypes.length} content types and ${displayTemplates.length} display templates with the prefix ${this.facts.typePrefix}`,
    };
  }

  // Paths

  /** A path as the project's own, or why it isn't. */
  private locate(path: string): Located | ToolResult {
    const segments = path.split('/').filter(Boolean);
    const space = segments[0] as Space;
    if (!SPACES.includes(space) || segments.length < 2)
      return rejected(
        `${path} is not a content path (/content, /shared or /media, then the application).`,
      );
    if (segments[1]!.toLowerCase() !== this.facts.application.toLowerCase())
      return rejected(
        `${path} belongs to another application: this project's is ${this.facts.application}.`,
        403,
      );
    return {
      space,
      path: `/${space}/${this.facts.application}${segments.length > 2 ? `/${segments.slice(2).join('/')}` : ''}`,
      below: segments.slice(2),
    };
  }

  private async node(key: string): Promise<ContentNode | null> {
    const { status, body } = await this.rest.get(`/content/${key}`, [200, 404]);
    const n = body as ContentNode | undefined;
    return status === 200 && n && !n.deleted ? n : null;
  }

  /** The key of the item at a path: the start page from the application, the rest from the path. */
  private async keyOf(at: Located): Promise<string | ToolResult> {
    if (at.space === 'content' && !at.below.length) {
      const app = await this.requireApplication();
      return 'key' in app ? refKey(app.entryPoint) : app;
    }
    return keyForPath(this.facts.cmsUrl, at.path);
  }

  /** The container a new item at this path goes in; folders of the assets tree are made on the way. */
  private async containerOf(at: Located): Promise<string | ToolResult> {
    const app = await this.requireApplication();
    if (!('key' in app)) return app;
    if (at.space === 'content') {
      if (!at.below.length) return ROOT_CONTAINER;
      const parent: Located = {
        ...at,
        below: at.below.slice(0, -1),
        path: at.path.replace(/\/[^/]+$/, ''),
      };
      const key = await this.keyOf(parent);
      if (typeof key !== 'string') return key;
      if (!(await this.node(key)))
        return rejected(`${parent.path} does not exist yet: create the parent page first.`, 409);
      return key;
    }
    const assets = refKey(app.assetsRoot);
    if (!assets)
      return rejected(
        `Application ${app.key} has no assets of its own (it was not made by application.create). Shared blocks and media need them: turn on "use application specific assets" for it in Settings > Applications.`,
        409,
      );
    // /shared/<app> is the folder "Shared" in the application's assets, /media/<app> "Media".
    let container = assets;
    const folders = [at.space === 'shared' ? 'Shared' : 'Media', ...at.below.slice(0, -1)];
    let path = `/${at.space}/${this.facts.application}`;
    for (const [i, name] of folders.entries()) {
      if (i > 0) path += `/${name}`;
      const key = keyForPath(this.facts.cmsUrl, `${path}#folder`);
      if (!(await this.node(key))) {
        await this.rest.send('POST', '/content', {
          json: {
            key,
            contentType: 'SysContentFolder',
            container,
            initialVersion: { displayName: name },
          },
        });
      }
      container = key;
    }
    return container;
  }

  // Property values

  /**
   * Values as an agent writes them, in the API's shape: each wrapped in `{ value }`, inline
   * components recursively, and a path to one of the project's items as a content reference.
   */
  private toProperties(
    given: Record<string, unknown> | undefined,
  ): Record<string, { value: unknown }> | ToolResult {
    const out: Record<string, { value: unknown }> = {};
    for (const [name, raw] of Object.entries(given ?? {})) {
      const value = this.toValue(raw);
      if (isResult(value)) return value;
      out[name] = { value };
    }
    return out;
  }

  private toValue(raw: unknown): unknown {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') {
      if (/^\/(content|shared|media)\//.test(raw)) {
        const at = this.locate(raw);
        if (!('space' in at)) return at;
        if (at.space === 'content' && !at.below.length)
          return rejected(
            `To point at the start page give its key ("cms://content/<key>", from application.read), not ${raw}.`,
          );
        return contentRef(keyForPath(this.facts.cmsUrl, at.path));
      }
      return raw;
    }
    if (Array.isArray(raw)) {
      const items = [];
      for (const item of raw) {
        const value = this.toValue(item);
        if (isResult(value)) return value;
        items.push(value);
      }
      return items;
    }
    if (typeof raw === 'object') {
      const o = raw as Record<string, unknown>;
      // An already wrapped value: take what is inside.
      if ('value' in o && Object.keys(o).length === 1) return this.toValue(o.value);
      // An inline component (a card in a list of cards): its properties only. The list's content
      // type already says what each item is, and the API refuses an item that names its type.
      if (o.properties && typeof o.properties === 'object' && !Array.isArray(o.properties)) {
        if (typeof o.contentType === 'string' && !this.owns(o.contentType))
          return rejected(
            `${o.contentType} doesn't carry this project's prefix (${this.facts.typePrefix}): inline components are the project's own types.`,
          );
        const properties = this.toProperties(o.properties as Record<string, unknown>);
        if (isResult(properties)) return properties;
        return { properties };
      }
      return o;
    }
    return raw;
  }

  private toNodes(nodes: z.infer<typeof Node>[], pathOrName: string): unknown[] | ToolResult {
    const out: unknown[] = [];
    for (const [i, n] of nodes.entries()) {
      if (!this.owns(n.contentType))
        return rejected(
          `${n.contentType} doesn't carry this project's prefix (${this.facts.typePrefix}): compose pages from the project's own section types.`,
        );
      if (n.displayTemplate && !this.owns(n.displayTemplate))
        return rejected(
          `Display template ${n.displayTemplate} doesn't carry this project's prefix (${this.facts.typePrefix}).`,
        );
      const properties = this.toProperties(n.properties);
      if (isResult(properties)) return properties;
      out.push({
        // The same section of the same page keeps its ID across rewrites, so an editor's
        // selection and Visual Builder's history survive.
        id: guid(keyForPath(this.facts.cmsUrl, `${pathOrName}#${i}:${n.name}`)),
        displayName: n.name,
        nodeType: 'component',
        ...(n.displayTemplate
          ? { displaySettings: { displayTemplate: n.displayTemplate, settings: n.settings ?? {} } }
          : {}),
        component: { contentType: n.contentType, properties },
      });
    }
    return out;
  }

  // Content

  private async latest(key: string, locale: string): Promise<Version | null> {
    const { body } = await this.rest.get(`/content/${key}/versions?pageSize=50`);
    const items = (body as { items?: Version[] }).items ?? [];
    const mine = items.filter((v) => !v.locale || v.locale === locale);
    const pool = mine.length ? mine : items;
    return pool.reduce<Version | null>(
      (best, v) => (!best || Number(v.version ?? 0) > Number(best.version ?? 0) ? v : best),
      null,
    );
  }

  async read(a: Parsed<typeof ReadArgs>): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    let key: string;
    let path: string | null = null;
    if (a.data.path) {
      const at = this.locate(a.data.path);
      if (!('space' in at)) return at;
      const k = await this.keyOf(at);
      if (typeof k !== 'string') return k;
      key = k;
      path = at.path;
    } else key = a.data.key!.toLowerCase();
    const n = await this.node(key);
    if (!n)
      return {
        code: 404,
        body: {
          error: path
            ? `Nothing at ${path}. Paths reach what the team created; an item made in the CMS itself is read by key.`
            : `No content with key ${key}.`,
        },
        summary: `Nothing at ${path ?? key}`,
      };
    const version = await this.latest(key, a.data.locale ?? this.locale);
    const out: Record<string, unknown> = {
      path,
      key,
      ref: contentRef(key),
      contentType: n.contentType,
      displayName: version?.displayName,
      status: version?.status,
      version: version?.version,
      locale: version?.locale,
      routeSegment: version?.routeSegment,
      properties: unwrap(version?.properties),
      ...(version?.composition ? { composition: compositionView(version.composition) } : {}),
    };
    if (a.data.children) {
      const { body } = await this.rest.get(`/content/${key}/items?pageSize=100`);
      out.children = ((body as { items?: ContentNode[] }).items ?? []).map((c) => ({
        key: c.key,
        contentType: c.contentType,
      }));
    }
    return {
      code: 200,
      body: out,
      summary: `${n.contentType} "${version?.displayName ?? key}" at ${path ?? key}: ${version?.status ?? 'no version'}`,
    };
  }

  /** A new draft of an item: what is given replaces, the rest of the latest version stays. */
  private async draft(
    key: string,
    locale: string,
    change: {
      displayName?: string;
      properties?: Record<string, { value: unknown }>;
      composition?: unknown;
    },
  ): Promise<Version> {
    const before = await this.latest(key, locale);
    const body: Record<string, unknown> = {
      locale,
      displayName: change.displayName ?? before?.displayName ?? 'Untitled',
      ...(before?.routeSegment ? { routeSegment: before.routeSegment } : {}),
      properties: { ...(before?.properties ?? {}), ...(change.properties ?? {}) },
    };
    const composition = change.composition ?? before?.composition;
    if (composition) body.composition = composition;
    const res = await this.rest.send('POST', `/content/${key}/versions`, { json: body });
    return (res.body as Version | undefined) ?? (await this.latest(key, locale)) ?? {};
  }

  async create(a: Parsed<typeof CreateArgs>): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const at = this.locate(a.data.path);
    if (!('space' in at)) return at;
    if (at.space === 'media')
      return rejected('Media is uploaded with media.upload, not created as content.');
    if (!at.below.length)
      return rejected(
        `${at.path} is the application's start page: application.create makes it; change it with content.update or composition.write.`,
      );
    if (!this.owns(a.data.contentType))
      return rejected(
        `${a.data.contentType} doesn't carry this project's prefix (${this.facts.typePrefix}): this project creates content of its own types only.`,
      );
    const properties = this.toProperties(a.data.properties);
    if (isResult(properties)) return properties;
    const locale = a.data.locale ?? this.locale;
    const name = at.below[at.below.length - 1]!;
    const displayName = a.data.displayName ?? name;
    const key = keyForPath(this.facts.cmsUrl, at.path);
    const existing = await this.node(key);
    if (existing) {
      if (existing.contentType !== a.data.contentType)
        return rejected(
          `${at.path} already exists as ${existing.contentType}, not ${a.data.contentType}. Choose another path, or update the item that is there.`,
          409,
        );
      const version = await this.draft(key, locale, { displayName, properties });
      return {
        code: 200,
        body: {
          path: at.path,
          key,
          ref: contentRef(key),
          contentType: a.data.contentType,
          version: version.version,
          status: version.status ?? 'draft',
          created: false,
        },
        summary: `${at.path} existed: wrote a new draft of it`,
      };
    }
    const container = await this.containerOf(at);
    if (typeof container !== 'string') return container;
    const res = await this.rest.send('POST', '/content', {
      json: {
        key,
        contentType: a.data.contentType,
        container,
        initialVersion: {
          locale,
          displayName,
          ...(at.space === 'content' ? { routeSegment: a.data.routeSegment ?? slug(name) } : {}),
          properties,
        },
      },
    });
    const version = (res.body as { initialVersion?: Version } | undefined)?.initialVersion;
    return {
      code: 201,
      body: {
        path: at.path,
        key,
        ref: contentRef(key),
        contentType: a.data.contentType,
        version: version?.version,
        status: 'draft',
        created: true,
      },
      summary: `Created ${a.data.contentType} "${displayName}" at ${at.path} (draft)`,
    };
  }

  private async existing(
    path: string,
  ): Promise<{ at: Located; key: string; node: ContentNode } | ToolResult> {
    const at = this.locate(path);
    if (!('space' in at)) return at;
    const key = await this.keyOf(at);
    if (typeof key !== 'string') return key;
    const node = await this.node(key);
    if (!node) return rejected(`Nothing at ${at.path}: create it first.`, 404);
    return { at, key, node };
  }

  async update(a: Parsed<typeof UpdateArgs>): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const found = await this.existing(a.data.path);
    if (isResult(found)) return found;
    const properties = this.toProperties(a.data.properties);
    if (isResult(properties)) return properties;
    const version = await this.draft(found.key, a.data.locale ?? this.locale, {
      displayName: a.data.displayName,
      properties,
    });
    const names = Object.keys(properties);
    return {
      code: 200,
      body: {
        path: found.at.path,
        key: found.key,
        ref: contentRef(found.key),
        version: version.version,
        status: version.status ?? 'draft',
        set: names,
      },
      summary: `Set ${names.join(', ')} on ${found.at.path} (draft)`,
    };
  }

  async compose(a: Parsed<typeof CompositionArgs>): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const found = await this.existing(a.data.path);
    if (isResult(found)) return found;
    const nodes = this.toNodes(a.data.nodes, found.at.path);
    if (isResult(nodes)) return nodes;
    const locale = a.data.locale ?? this.locale;
    const before = await this.latest(found.key, locale);
    const version = await this.draft(found.key, locale, {
      composition: {
        id: guid(found.key),
        displayName: before?.displayName ?? found.at.path,
        nodeType: 'experience',
        layoutType: 'outline',
        nodes,
      },
    });
    return {
      code: 200,
      body: {
        path: found.at.path,
        key: found.key,
        version: version.version,
        status: version.status ?? 'draft',
        sections: a.data.nodes.map((n) => ({
          name: n.name,
          contentType: n.contentType,
          displayTemplate: n.displayTemplate ?? null,
        })),
      },
      summary: `Composed ${found.at.path}: ${a.data.nodes.length} section${a.data.nodes.length === 1 ? '' : 's'} (draft)`,
    };
  }

  async previews(a: Parsed<typeof PublishArgs>): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const found = await this.existing(a.data.path);
    if (isResult(found)) return found;
    const version = await this.latest(found.key, a.data.locale ?? this.locale);
    if (!version?.version) return rejected(`${found.at.path} has no version to preview.`, 409);
    const { body } = await this.rest.get(
      `/content/${found.key}/versions/${version.version}/previews`,
    );
    const mine = ((body as { items?: { application?: string; url?: string }[] }).items ?? []).find(
      (p) => p.application === this.facts.application,
    );
    if (!mine?.url)
      return {
        code: 404,
        body: {
          error: `Application ${this.facts.application} has no preview for ${found.at.path}.`,
        },
        summary: `No preview for ${found.at.path}: the application needs a host and a preview URL format (hostname.add, preview.configure)`,
      };
    return {
      code: 200,
      body: {
        path: found.at.path,
        version: version.version,
        status: version.status,
        preview: mine.url,
        // The same address as Visual Builder's editing frame opens it.
        edit: mine.url.replace(/([?&])ctx=[^&]*/, '$1ctx=edit'),
      },
      summary: `Preview address for ${found.at.path} (version ${version.version}, ${version.status ?? 'draft'})`,
    };
  }

  async publish(a: Parsed<typeof PublishArgs>): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const found = await this.existing(a.data.path);
    if (isResult(found)) return found;
    const version = await this.latest(found.key, a.data.locale ?? this.locale);
    if (!version?.version) return rejected(`${found.at.path} has no version to publish.`, 409);
    if (version.status === 'published')
      return {
        code: 200,
        body: {
          path: found.at.path,
          key: found.key,
          version: version.version,
          status: 'published',
        },
        summary: `${found.at.path} is already published (version ${version.version})`,
      };
    await this.rest.send('POST', `/content/${found.key}/versions/${version.version}:publish`, {
      json: {},
    });
    return {
      code: 200,
      body: { path: found.at.path, key: found.key, version: version.version, status: 'published' },
      summary: `Published ${found.at.path} (version ${version.version}); Optimizely Graph indexes it within moments`,
    };
  }

  async blueprints(): Promise<ToolResult> {
    const { body } = await this.rest.get('/blueprints?pageSize=100');
    const items = (
      (body as { items?: { key?: string; displayName?: string; contentType?: string }[] }).items ??
      []
    ).map((b) => ({
      key: b.key,
      name: b.displayName,
      contentType: b.contentType,
      own: this.owns(b.contentType ?? ''),
    }));
    return {
      code: 200,
      body: { blueprints: items },
      summary: `${items.filter((b) => b.own).length} blueprint${items.filter((b) => b.own).length === 1 ? '' : 's'} for this project's types`,
    };
  }

  async blueprint(a: Parsed<typeof BlueprintArgs>): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    if (!this.owns(a.data.contentType))
      return rejected(
        `${a.data.contentType} doesn't carry this project's prefix (${this.facts.typePrefix}): blueprints are for the project's own experience types.`,
      );
    const where = `/blueprints/${this.facts.application}/${a.data.name}`;
    const key = keyForPath(this.facts.cmsUrl, where);
    const properties = this.toProperties(a.data.properties);
    if (isResult(properties)) return properties;
    const nodes = this.toNodes(a.data.nodes ?? [], where);
    if (isResult(nodes)) return nodes;
    const content = {
      properties,
      composition: {
        displayName: a.data.name,
        nodeType: 'experience',
        layoutType: 'outline',
        nodes,
      },
    };
    const existing = await this.rest.get(`/blueprints/${key}`, [200, 404]);
    if (existing.status === 200) {
      await this.rest.send('PATCH', `/blueprints/${key}`, {
        json: { displayName: a.data.name, content },
        patch: true,
      });
      return {
        code: 200,
        body: { key, name: a.data.name, contentType: a.data.contentType, created: false },
        summary: `Updated blueprint "${a.data.name}" for ${a.data.contentType}`,
      };
    }
    await this.rest.send('POST', '/blueprints', {
      json: { key, displayName: a.data.name, contentType: a.data.contentType, content },
    });
    return {
      code: 201,
      body: { key, name: a.data.name, contentType: a.data.contentType, created: true },
      summary: `Created blueprint "${a.data.name}" for ${a.data.contentType}: ${nodes.length} section${nodes.length === 1 ? '' : 's'}`,
    };
  }

  async media(
    a: Parsed<typeof MediaArgs>,
    ctx: ToolCallContext,
    blobs: BlobStore | undefined,
    fetcher: typeof fetch,
  ): Promise<ToolResult> {
    if (!a.success) return invalid(a);
    const at = this.locate(a.data.path);
    if (!('space' in at)) return at;
    let bytes: Uint8Array;
    let from: string;
    if (a.data.ref) {
      // A file the browser downloaded for this project (its host was checked there), or one the
      // Director gave the team.
      if (
        !a.data.ref.startsWith(`blob://${ctx.projectId}/assets/`) &&
        !a.data.ref.startsWith(`blob://${ctx.projectId}/files/`)
      )
        return rejected(
          `${a.data.ref} isn't a file downloaded for this project or one the Director gave it.`,
        );
      if (!blobs) return rejected('Stored files are not available here; give sourceUrl.', 501);
      try {
        bytes = await blobs.get(a.data.ref);
      } catch {
        return rejected(
          `No stored file at ${a.data.ref}; download it again with browser.fetch.asset.`,
          404,
        );
      }
      from = a.data.ref;
    } else {
      const source = new URL(a.data.sourceUrl!);
      if (!this.facts.sourceHosts.includes(source.hostname))
        return rejected(
          `${source.hostname} is not the project's source site. Download it with browser.fetch.asset and upload its ref instead.`,
        );
      const file = await fetcher(source, { signal: AbortSignal.timeout(60_000) });
      if (!file.ok)
        return {
          code: 424,
          body: { error: `The source answered ${file.status} for ${source.href}` },
        };
      bytes = new Uint8Array(await file.arrayBuffer());
      from = source.href;
    }
    if (bytes.byteLength > MAX_MEDIA_BYTES)
      return rejected(`The file is ${Math.round(bytes.byteLength / 1e6)} MB; the limit is 25 MB.`);
    const kind = sniffImage(bytes);
    if (kind === 'avif')
      return rejected(
        "Optimizely's image type doesn't take AVIF. Download it as WebP, PNG or JPEG instead (most image servers convert on request: fm=webp, fmt=png-alpha, format=jpg) with browser.fetch.asset, and upload that ref.",
      );
    if (!kind)
      return rejected('The file is not an image the CMS takes (PNG, JPEG, WebP, GIF or SVG).');
    // The file name's extension is what the CMS types the item by: keep it true to the bytes.
    const base = at.below[at.below.length - 1]!.replace(/\.[a-z0-9]{2,5}$/i, '');
    const fileName = `${base}.${kind}`;
    const path = `${at.path.replace(/\/[^/]+$/, '')}/${fileName}`;
    const key = keyForPath(this.facts.cmsUrl, path);
    const existing = await this.node(key);
    if (existing)
      return {
        code: 200,
        body: { path, key, ref: contentRef(key), fileName, uploaded: false },
        summary: `${path} is already uploaded`,
      };
    const container = await this.containerOf({
      ...at,
      path,
      below: [...at.below.slice(0, -1), fileName],
    });
    if (typeof container !== 'string') return container;
    const form = new FormData();
    form.append(
      'content',
      new Blob(
        [
          JSON.stringify({
            key,
            contentType: 'ImageMedia',
            container,
            initialVersion: {
              displayName: fileName,
              properties: a.data.alt ? { AltText: { value: a.data.alt } } : {},
            },
          }),
        ],
        { type: 'application/json' },
      ),
    );
    form.append('file', new Blob([new Uint8Array(bytes)], { type: MEDIA_TYPES[kind]! }), fileName);
    const res = await this.rest.send('POST', '/content', { form });
    const version =
      (res.body as { initialVersion?: Version } | undefined)?.initialVersion?.version ??
      (await this.latest(key, this.locale))?.version;
    if (version)
      await this.rest.send('POST', `/content/${key}/versions/${version}:publish`, { json: {} });
    return {
      code: 201,
      body: {
        path,
        key,
        ref: contentRef(key),
        fileName,
        bytes: bytes.byteLength,
        alt: a.data.alt ?? null,
        uploaded: true,
        from,
      },
      summary: `Uploaded ${fileName} to ${path}${a.data.alt ? '' : ' (no alt text given)'}`,
    };
  }
}

const isResult = (v: unknown): v is ToolResult =>
  typeof v === 'object' &&
  v !== null &&
  'code' in v &&
  'body' in v &&
  typeof (v as ToolResult).code === 'number';

const applicationView = (a: Application) => ({
  key: a.key,
  displayName: a.displayName,
  startPage: { key: refKey(a.entryPoint), ref: a.entryPoint },
  assetsRoot: a.assetsRoot ? refKey(a.assetsRoot) : null,
  hosts: (a.hosts ?? []).map((h) => ({
    host: h.authority,
    type: h.type ?? null,
    scheme: h.preferredUrlScheme ?? null,
  })),
  previewTokens: a.usePreviewTokens === true,
  previewUrl: a.previewUrlFormats?.any ?? null,
});

/** `{ name: { value } }` as `{ name: value }`, inline components included. */
function unwrap(
  properties: Record<string, { value?: unknown }> | undefined,
): Record<string, unknown> {
  const plain = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.properties && typeof o.properties === 'object' && !Array.isArray(o.properties))
        return { properties: unwrap(o.properties as Record<string, { value?: unknown }>) };
    }
    return v;
  };
  return Object.fromEntries(Object.entries(properties ?? {}).map(([k, v]) => [k, plain(v?.value)]));
}

interface RawNode {
  displayName?: string;
  nodeType?: string;
  displaySettings?: { displayTemplate?: string; settings?: Record<string, string> | null };
  component?: {
    contentType?: string;
    reference?: string | null;
    properties?: Record<string, { value?: unknown }>;
  };
  nodes?: RawNode[] | null;
}

/** A composition as a list of what an editor sees: sections, and what is inside grid sections. */
function compositionView(composition: unknown): unknown {
  const view = (n: RawNode): Record<string, unknown> => ({
    name: n.displayName,
    nodeType: n.nodeType,
    ...(n.component?.contentType ? { contentType: n.component.contentType } : {}),
    ...(n.component?.reference ? { reference: n.component.reference } : {}),
    ...(n.displaySettings?.displayTemplate
      ? {
          displayTemplate: n.displaySettings.displayTemplate,
          settings: n.displaySettings.settings ?? {},
        }
      : {}),
    ...(n.component?.properties ? { properties: unwrap(n.component.properties) } : {}),
    ...(n.nodes?.length ? { nodes: n.nodes.map(view) } : {}),
  });
  return ((composition as RawNode).nodes ?? []).map(view);
}

/** An image's type from its first bytes. */
function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  if (at(4, 0x66, 0x74, 0x79, 0x70) && at(8, 0x61, 0x76, 0x69, 0x66)) return 'avif';
  const head = new TextDecoder().decode(b.slice(0, 256)).trimStart();
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}
