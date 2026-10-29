import { randomUUID } from 'node:crypto';
import type {
  BlobStore,
  OperationCatalog,
  ToolCallContext,
  ToolResult,
  ToolServer,
} from '@lw/tool-gateway';
import { z } from 'zod';

/** What the server knows about the project's SitecoreAI target, from intake. */
export interface TenantFacts {
  /** CM host, e.g. "xmc-acme-123.sitecorecloud.io". */
  cmHost: string;
  siteCollection: string;
  site: string;
  languages: string[];
  /** The source site's host, the only place media may be downloaded from. */
  sourceHosts: string[];
}

export interface AuthoringServerOptions {
  facts(projectId: string): Promise<TenantFacts | null>;
  fetch?: typeof fetch;
  /** CM hosts this server may call. */
  hostSuffixes?: string[];
  /** Where downloads are stored: media.upload takes a file the browser already fetched. */
  blobs?: BlobStore;
  /**
   * The project's Experience Edge Context ID (live or preview), for edge.routes. It stays in the
   * server: the agent sees only which routes resolve.
   */
  edgeContextId?(projectId: string, live: boolean): Promise<string | null>;
  /** Experience Edge's base URL. */
  edgeUrl?: string;
}

const MEDIA_ROOT = '/sitecore/media library/';
const EDGE_URL = 'https://edge-platform.sitecorecloud.io';
const JSON_RENDERING = '/sitecore/templates/Foundation/JavaScript Services/Json Rendering';
const LANGUAGE_TEMPLATE = '/sitecore/templates/System/Language';
const MAX_MEDIA_BYTES = 25_000_000;
const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
};

const Path = z.string().startsWith('/sitecore/').max(500);
const Field = z.object({ name: z.string().min(1), value: z.string() });
const ReadArgs = z.object({
  path: Path,
  language: z.string().optional(),
  children: z.boolean().optional(),
  /** Only these fields, standard ones included (__Masters, __Standard values). */
  fields: z.array(z.string().min(1).max(100)).max(30).optional(),
});
const CreateArgs = z
  .object({
    parentPath: Path,
    name: z.string().min(1).max(100),
    templatePath: Path.optional(),
    templateId: z.string().optional(),
    language: z.string().optional(),
    fields: z.array(Field).max(200).optional(),
  })
  .refine((a) => a.templatePath || a.templateId, 'templatePath or templateId is required');
const HostArgs = z.object({
  /** The head's base URL, e.g. https://acme-editing.vercel.app */
  url: z.url({ protocol: /^https$/ }),
});
/** Where SitecoreAI keeps rendering hosts; the environment's own is "Default". */
const HOSTS = '/sitecore/system/Settings/Services/Rendering Hosts';
const UpdateArgs = z.object({
  path: Path,
  language: z.string().optional(),
  fields: z.array(Field).min(1).max(200),
});
const RenameArgs = z.object({
  path: Path,
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^/\\:?"<>|\[\]]+$/, 'an item name, without / \\ : ? " < > | [ ]'),
});
const TemplateArgs = z.object({
  parentPath: Path,
  name: z.string().min(1).max(100),
  sections: z
    .array(
      z.object({
        name: z.string().min(1),
        fields: z.array(z.object({ name: z.string().min(1), type: z.string().min(1) })).max(100),
      }),
    )
    .min(1)
    .max(20),
});
const RenderingArgs = z.object({
  parentPath: Path,
  name: z.string().min(1).max(100),
  componentName: z.string().min(1).max(100),
  datasourceTemplatePath: Path.optional(),
  datasourceLocation: z.string().max(500).optional(),
  parametersTemplatePath: Path.optional(),
});
const LayoutArgs = z
  .object({
    path: Path,
    /** The page's components in order: what Page builder shows, top to bottom per placeholder. */
    renderings: z
      .array(
        z.object({
          /** The rendering item: its path or ID. */
          rendering: z.string().min(1),
          placeholder: z.string().min(1).max(200),
          /** The datasource item: its path or ID (omit for none). */
          datasource: z.string().min(1).optional(),
          /** Rendering parameters, as name/value pairs. */
          parameters: z.record(z.string(), z.string()).optional(),
        }),
      )
      .min(1)
      .max(100)
      .optional(),
    /** Layout definition XML instead of `renderings`: `<r><d id=… l=…><r uid=… id=… ph=… ds=…/></d></r>`. */
    renderingsXml: z.string().min(1).max(500_000).optional(),
    language: z.string().optional(),
  })
  .refine(
    (a) => Boolean(a.renderings) !== Boolean(a.renderingsXml),
    'give renderings or renderingsXml',
  );
/** The Default device, and the JSS/SXA headless layout every headless page uses. */
const DEFAULT_DEVICE = '{FE5D7FDF-89C0-4D99-9AA3-B5FBD009C9F3}';
const HEADLESS_LAYOUT = '{96E5F4BA-A2CF-4A4C-A4E7-64DA88226362}';
const MediaArgs = z
  .object({
    itemPath: z.string().startsWith(MEDIA_ROOT).max(500),
    sourceUrl: z.url({ protocol: /^https$/ }).optional(),
    /** A file browser.fetch.asset stored (its `ref`), so it isn't downloaded twice. */
    ref: z.string().startsWith('blob://').max(500).optional(),
    fileName: z.string().min(1).max(200).optional(),
    alt: z.string().max(500).optional(),
  })
  .refine((a) => Boolean(a.sourceUrl) !== Boolean(a.ref), 'give either ref or sourceUrl');
const PublishStatusArgs = z.object({ operationId: z.string().min(1).max(300) });
const EdgeRoutesArgs = z.object({
  paths: z.array(z.string().regex(/^\//, 'route paths start with /')).min(1).max(60),
  live: z.boolean().optional(),
});
const PublishArgs = z.object({
  paths: z.array(Path).min(1).max(50),
  subItems: z.boolean().optional(),
  languages: z.array(z.string()).optional(),
});
/** Defaults to the project's own site and collection, from intake. */
const SiteArgs = z.object({
  collection: z.string().min(1).optional(),
  site: z.string().min(1).optional(),
});
const PageDesignsArgs = z.object({
  /** The site's Page Designs item, `<site>/Presentation/Page Designs`. */
  pageDesignsPath: Path,
  /** Every page template and its page design: the mapping replaces the site's whole mapping. */
  mappings: z
    .array(z.object({ templatePath: Path, pageDesignPath: Path }))
    .min(1)
    .max(50),
});
const LanguageArgs = z.object({
  /** e.g. "es-US" */
  code: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
});

const bad = (message: string, code = 422): ToolResult => ({
  code,
  body: { error: message },
  summary: message,
});
const gql = (s: string) => JSON.stringify(s);

/**
 * The SitecoreAI Authoring and Management GraphQL API on the project's CM host, with the
 * environment automation client's token. Every path is absolute so the gateway can hold each role
 * to its scope; templates are found by path, never by a hard-coded ID.
 */
export class SitecoreAuthoringToolServer implements ToolServer {
  readonly name = 'sitecore-authoring';
  readonly catalog: OperationCatalog = {
    'site.list': {
      description: 'List the sites on the environment: name and root path.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'item.read': {
      description:
        'Read an item by absolute path (fields, template, and with children:true its children). Sitecore\'s standard fields (insert options __Masters, __Renderings, workflow…) are left out unless you name them in `fields`, e.g. fields: ["__Masters"]; naming fields returns only those.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          language: { type: 'string' },
          children: { type: 'boolean' },
          fields: { type: 'array', items: { type: 'string' } },
        },
        required: ['path'],
        additionalProperties: false,
      },
      mutates: false,
      pathArgs: ['path'],
    },
    'item.create': {
      description:
        'Create an item under parentPath from a template (templatePath, or templateId), with field values.',
      inputSchema: {
        type: 'object',
        properties: {
          parentPath: { type: 'string' },
          name: { type: 'string' },
          templatePath: { type: 'string' },
          templateId: { type: 'string' },
          language: { type: 'string' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, value: { type: 'string' } },
              required: ['name', 'value'],
            },
          },
        },
        required: ['parentPath', 'name'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['parentPath'],
      lockPaths: (a) => [`${String(a.parentPath).replace(/\/$/, '')}/${String(a.name)}`],
    },
    'item.update': {
      description: 'Set field values on an item (by absolute path) in one language.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          language: { type: 'string' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, value: { type: 'string' } },
              required: ['name', 'value'],
            },
          },
        },
        required: ['path', 'fields'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['path'],
    },
    'item.rename': {
      description:
        'Rename an item (by absolute path). Its ID, fields, children and every reference to it stay as they are; reads it back under the new name.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, name: { type: 'string' } },
        required: ['path', 'name'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['path'],
    },
    'page-designs.map': {
      description:
        "Map page templates to page designs on the project's site (Sitecore's configurePageDesigns): each page template's pages then show its page design's partial designs (header, footer). Give every page template: the mapping replaces the site's whole mapping. Reads the Page Designs item back to confirm each pair. Don't write TemplatesMapping by hand: Sitecore ignores a value not in its URL-encoded form.",
      inputSchema: {
        type: 'object',
        properties: {
          pageDesignsPath: { type: 'string' },
          mappings: {
            type: 'array',
            items: {
              type: 'object',
              properties: { templatePath: { type: 'string' }, pageDesignPath: { type: 'string' } },
              required: ['templatePath', 'pageDesignPath'],
            },
          },
        },
        required: ['pageDesignsPath', 'mappings'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['pageDesignsPath'],
    },
    'template.create': {
      description:
        'Create a data template under parentPath with sections and fields (types such as "Single-Line Text", "Rich Text", "Image", "General Link", "Multilist").',
      inputSchema: {
        type: 'object',
        properties: {
          parentPath: { type: 'string' },
          name: { type: 'string' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                fields: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { name: { type: 'string' }, type: { type: 'string' } },
                    required: ['name', 'type'],
                  },
                },
              },
              required: ['name', 'fields'],
            },
          },
        },
        required: ['parentPath', 'name', 'sections'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['parentPath'],
      lockPaths: (a) => [`${String(a.parentPath).replace(/\/$/, '')}/${String(a.name)}`],
    },
    'rendering.create': {
      description:
        'Register a headless (JSON) rendering for a component: componentName must match the Content SDK component name. Optional datasource template and location, parameters template.',
      inputSchema: {
        type: 'object',
        properties: {
          parentPath: { type: 'string' },
          name: { type: 'string' },
          componentName: { type: 'string' },
          datasourceTemplatePath: { type: 'string' },
          datasourceLocation: { type: 'string' },
          parametersTemplatePath: { type: 'string' },
        },
        required: ['parentPath', 'name', 'componentName'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['parentPath'],
      lockPaths: (a) => [`${String(a.parentPath).replace(/\/$/, '')}/${String(a.name)}`],
    },
    'layout.compose': {
      description:
        "Place components on a page, so Page builder opens with them in place. Give `renderings` in order: each `rendering` (its path or ID), `placeholder` (e.g. headless-main), `datasource` (its path or ID) and optional `parameters`. The tool resolves the IDs, writes the page's layout (Default device, headless layout), clears the page's own layout edits so they don't override it, and reads it back.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          renderings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rendering: { type: 'string' },
                placeholder: { type: 'string' },
                datasource: { type: 'string' },
                parameters: { type: 'object', additionalProperties: { type: 'string' } },
              },
              required: ['rendering', 'placeholder'],
            },
          },
          renderingsXml: { type: 'string' },
          language: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['path'],
    },
    'media.upload': {
      description:
        "Upload an image or file into the media library. itemPath is the absolute media item path (under /sitecore/media library/). Give `ref`, the stored file browser.fetch.asset returned (preferred: it may come from the site's CDN or the Blueprint's URL), with `fileName`; or `sourceUrl` on the source site itself.",
      inputSchema: {
        type: 'object',
        properties: {
          itemPath: { type: 'string' },
          ref: { type: 'string' },
          fileName: { type: 'string' },
          sourceUrl: { type: 'string' },
          alt: { type: 'string' },
        },
        required: ['itemPath'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['itemPath'],
    },
    publish: {
      description:
        'Publish items (and their subitems unless subItems:false) to Experience Edge in the given languages (default: the project languages). Returns the publishing operation id and its first status.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          subItems: { type: 'boolean' },
          languages: { type: 'array', items: { type: 'string' } },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      mutates: true,
      releases: true,
      pathArgs: ['paths'],
    },
    'publish.status': {
      description:
        "A publishing operation's state, from the operation id publish returned: state, isDone, isFailed. Call it until isDone (a publish takes from seconds to minutes). Changes nothing.",
      inputSchema: {
        type: 'object',
        properties: { operationId: { type: 'string' } },
        required: ['operationId'],
        additionalProperties: false,
      },
      mutates: false,
    },
    'edge.routes': {
      description:
        'Whether each route of the project\'s site resolves on Experience Edge (live by default; live:false for preview), as the delivery host reads it: `paths` like "/", "/about", up to 60. Returns the routes found and the ones missing. Changes nothing.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          live: { type: 'boolean' },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      mutates: false,
    },
    'rendering-host.read': {
      description:
        "Which rendering host the project's site renders through in Page builder: the site's setting (its Site Grouping item) and the rendering host items, with their URLs. Changes nothing.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'rendering-host.set': {
      description:
        "Make the project's own head the site's editing host in Page builder: creates or updates a rendering host item named after the site (same template as the environment's Default host, with this head's render, application and config URLs) and points the site's Site Grouping setting at it. Other sites keep their host. `url` is the head's base URL. Reads both back.",
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
      mutates: true,
      releases: true,
    },
    'site.verify': {
      description:
        "Check the project's site exists in its site collection (both default to the project's target). Returns the site if it does; if not, says so (sites are created in SitecoreAI Sites). Changes nothing.",
      inputSchema: {
        type: 'object',
        properties: { collection: { type: 'string' }, site: { type: 'string' } },
        additionalProperties: false,
      },
      mutates: false,
    },
    // The same read under its first name, so audit trails recorded before the rename read
    // correctly. No role is granted it.
    'site.create': {
      description: 'Old name of site.verify.',
      mutates: false,
    },
    'language.add': {
      description:
        'Add a content language to the environment, e.g. "es-US", if it is not there yet.',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
        additionalProperties: false,
      },
      mutates: true,
    },
  };

  private readonly fetch: typeof fetch;
  private readonly suffixes: string[];

  constructor(private readonly opts: AuthoringServerOptions) {
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.suffixes = opts.hostSuffixes ?? ['.sitecorecloud.io'];
  }

  target(projectId: string) {
    return `sitecore:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const facts = await this.opts.facts(ctx.projectId);
    if (!facts) return { code: 409, body: { error: 'This project has no SitecoreAI target.' } };
    const host = facts.cmHost.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!this.suffixes.some((s) => host.endsWith(s))) {
      return { code: 403, body: { error: `${host} is not a SitecoreAI CM host.` } };
    }
    const q = new Gql(this.fetch, `https://${host}/sitecore/api/authoring/graphql/v1/`, ctx.token);
    const lang = (l?: string) => l ?? facts.languages[0] ?? 'en';
    try {
      switch (op) {
        case 'site.list':
          return await this.sites(q);
        case 'item.read':
          return await this.read(q, ReadArgs.safeParse(args), lang);
        case 'item.create':
          return await this.create(q, CreateArgs.safeParse(args), lang);
        case 'item.update':
          return await this.update(q, UpdateArgs.safeParse(args), lang);
        case 'item.rename':
          return await this.rename(q, RenameArgs.safeParse(args));
        case 'page-designs.map':
          return await this.pageDesigns(q, PageDesignsArgs.safeParse(args), facts);
        case 'template.create':
          return await this.template(q, TemplateArgs.safeParse(args));
        case 'rendering.create':
          return await this.rendering(q, RenderingArgs.safeParse(args), lang);
        case 'layout.compose':
          return await this.layout(q, LayoutArgs.safeParse(args), lang);
        case 'media.upload':
          return await this.media(q, MediaArgs.safeParse(args), facts, ctx, lang);
        case 'publish':
          return await this.publish(q, PublishArgs.safeParse(args), facts);
        case 'publish.status':
          return await this.publishStatus(q, PublishStatusArgs.safeParse(args));
        case 'edge.routes':
          return await this.edgeRoutes(ctx.projectId, EdgeRoutesArgs.safeParse(args), facts);
        case 'site.verify':
        case 'site.create':
          return await this.site(q, SiteArgs.safeParse(args), facts);
        case 'rendering-host.read':
          return await this.hostRead(q, facts);
        case 'rendering-host.set':
          return await this.hostSet(q, HostArgs.safeParse(args), facts, lang);
        case 'language.add':
          return await this.language(q, LanguageArgs.safeParse(args));
        default:
          return { code: 404, body: { error: `Unknown operation ${op}` } };
      }
    } catch (err) {
      if (err instanceof GqlError) return { code: err.status, body: { error: err.message } };
      throw err;
    }
  }

  private async sites(q: Gql): Promise<ToolResult> {
    const d = await q.run<{ sites: { name: string; rootPath: string }[] }>(
      'query { sites { name rootPath } }',
    );
    return { code: 200, body: d, summary: `Listed ${d.sites.length} sites` };
  }

  private async read(q: Gql, a: Parsed<typeof ReadArgs>, lang: Lang): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const named = a.data.fields?.map((f) => f.toLowerCase());
    type Read = { item: { fields: { nodes: { name: string; value: string }[] } } | null };
    // Children come a page at a time: ask for a page large enough for a module folder of dozens
    // of templates, or take the API's default page where it doesn't take a size.
    const query = (size: string) =>
      q.run<Read>(
        `query { item(where: { database: "master", path: ${gql(a.data.path)}, language: ${gql(lang(a.data.language))} }) {
        itemId name path template { name templateId }
        fields(ownFields: false, excludeStandardFields: ${named ? 'false' : 'true'}) { nodes { name value } }
        ${a.data.children ? `children${size} { nodes { itemId name path template { name } } }` : ''}
      } }`,
      );
    let d: Read;
    try {
      d = await query(a.data.children ? '(first: 1000)' : '');
    } catch (err) {
      if (!(err instanceof GqlError) || !a.data.children) throw err;
      d = await query('');
    }
    if (!d.item) return { code: 404, body: { error: `No item at ${a.data.path}` } };
    if (!named) return { code: 200, body: d.item, summary: `Read ${a.data.path}` };
    // Named fields only, asked for by name, and say which the item doesn't have.
    const back = await readBack(q, a.data.path, lang(a.data.language), a.data.fields!);
    const nodes = a.data.fields!.flatMap((name) => {
      const value = back?.fields.get(name.toLowerCase());
      return value === undefined ? [] : [{ name, value }];
    });
    const absent = a.data.fields!.filter(
      (f) => !nodes.some((n) => n.name.toLowerCase() === f.toLowerCase()),
    );
    return {
      code: 200,
      body: { ...d.item, fields: { nodes }, ...(absent.length ? { notOnItem: absent } : {}) },
      summary: `Read ${nodes.map((n) => n.name).join(', ') || 'no fields'} on ${a.data.path}${absent.length ? ` (no ${absent.join(', ')} on this item)` : ''}`,
    };
  }

  private async create(q: Gql, a: Parsed<typeof CreateArgs>, lang: Lang): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const path = `${a.data.parentPath.replace(/\/$/, '')}/${a.data.name}`;
    const language = lang(a.data.language);
    const fields = a.data.fields ?? [];
    // Find before create: an item already there is reported, never duplicated or overwritten.
    const existing = await readBack(q, path, language);
    if (existing) {
      return {
        code: 200,
        body: { itemId: existing.itemId, path, existed: true },
        summary: `${path} already exists; not created again`,
      };
    }
    const parent = await this.idOf(q, a.data.parentPath);
    const templateId = a.data.templateId ?? (await this.idOf(q, a.data.templatePath!));
    let reconciled = false;
    try {
      await q.run<{ createItem: { item: { itemId: string; path: string } } }>(
        `mutation { createItem(input: {
          name: ${gql(a.data.name)}, templateId: ${gql(templateId)}, parent: ${gql(parent)},
          language: ${gql(language)}, fields: ${fieldsOf(fields)}
        }) { item { itemId path } } }`,
      );
    } catch (err) {
      if (err instanceof GqlError) throw err;
      // The request timed out or the connection dropped: the create may have happened.
      reconciled = true;
    }
    // Executed is not verified: read it back.
    const back = await readBack(
      q,
      path,
      language,
      fields.map((f) => f.name),
    );
    if (!back) {
      return {
        code: 503,
        body: { error: `Creating ${path} didn't complete, and nothing is there. Safe to retry.` },
        summary: `Create of ${path} didn't complete`,
      };
    }
    const mismatches = compare(fields, back.fields);
    return {
      code: mismatches.length ? 409 : 200,
      body: {
        itemId: back.itemId,
        path: back.path,
        verified: !mismatches.length,
        mismatches,
        reconciled,
      },
      summary: mismatches.length
        ? `Created ${back.path}, but ${mismatches.length} field${mismatches.length === 1 ? '' : 's'} read back differently: ${mismatches.join(', ')}`
        : `Created ${back.path}${reconciled ? ' (confirmed by read-back after a dropped request)' : ''}, read back`,
    };
  }

  private async update(q: Gql, a: Parsed<typeof UpdateArgs>, lang: Lang): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const language = lang(a.data.language);
    // A rendering's Parameters Template takes an item ID. Given a path, Sitecore stores the path,
    // and every page with that rendering then fails to build its layout data.
    for (const f of a.data.fields) {
      if (/^parameters template$/i.test(f.name) && f.value.trim().startsWith('/'))
        f.value = sitecoreId(await this.idOf(q, f.value.trim()));
    }
    let reconciled = false;
    try {
      await q.run<{ updateItem: { item: { itemId: string; name: string } } }>(
        `mutation { updateItem(input: {
          database: "master", path: ${gql(a.data.path)}, language: ${gql(language)},
          fields: ${fieldsOf(a.data.fields)}
        }) { item { itemId name } } }`,
      );
    } catch (err) {
      if (err instanceof GqlError) throw err;
      reconciled = true;
    }
    const back = await readBack(
      q,
      a.data.path,
      language,
      a.data.fields.map((f) => f.name),
    );
    if (!back) return { code: 404, body: { error: `No item at ${a.data.path}` } };
    const mismatches = compare(a.data.fields, back.fields);
    if (reconciled && mismatches.length) {
      return {
        code: 503,
        body: {
          error: `Updating ${a.data.path} didn't complete; the read-back shows the old values. Safe to retry.`,
        },
        summary: `Update of ${a.data.path} didn't complete`,
      };
    }
    return {
      code: mismatches.length ? 409 : 200,
      body: {
        itemId: back.itemId,
        fields: a.data.fields.map((f) => f.name),
        verified: !mismatches.length,
        mismatches,
        reconciled,
      },
      summary: mismatches.length
        ? `Updated ${a.data.path}, but ${mismatches.join(', ')} read back differently`
        : `Updated ${a.data.fields.length} field${a.data.fields.length === 1 ? '' : 's'} on ${a.data.path}, read back`,
    };
  }

  private async rename(q: Gql, a: Parsed<typeof RenameArgs>): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const itemId = await this.idOf(q, a.data.path);
    const target = `${a.data.path.slice(0, a.data.path.lastIndexOf('/'))}/${a.data.name}`;
    await q.run<{ renameItem: { item: { itemId: string } } }>(
      `mutation { renameItem(input: { database: "master", itemId: ${gql(itemId)}, newName: ${gql(a.data.name)} }) { item { itemId } } }`,
    );
    // Executed is not verified: the same item answers at the new path.
    const back = await readBack(q, target, 'en');
    const same =
      back &&
      back.itemId.replace(/[{}-]/g, '').toLowerCase() ===
        itemId.replace(/[{}-]/g, '').toLowerCase();
    return same
      ? {
          code: 200,
          body: { itemId, path: target },
          summary: `Renamed ${a.data.path} to ${a.data.name}, read back (ID unchanged)`,
        }
      : {
          code: 409,
          body: { itemId, path: a.data.path, expected: target },
          summary: `Renamed ${a.data.path}, but ${target} doesn't read back as the same item`,
        };
  }

  private async pageDesigns(
    q: Gql,
    a: Parsed<typeof PageDesignsArgs>,
    facts: TenantFacts,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const root = a.data.pageDesignsPath.replace(/\/$/, '');
    const outside = a.data.mappings.find((m) => !m.pageDesignPath.startsWith(`${root}/`));
    if (outside) return bad(`${outside.pageDesignPath} is not a page design under ${root}`);
    const pairs: { templateId: string; pageDesignId: string }[] = [];
    for (const m of a.data.mappings) {
      pairs.push({
        templateId: braced(await this.idOf(q, m.templatePath)),
        pageDesignId: braced(await this.idOf(q, m.pageDesignPath)),
      });
    }
    await q.run<{ configurePageDesigns: boolean }>(
      `mutation { configurePageDesigns(input: { siteName: ${gql(facts.site)}, mapping: [${pairs
        .map((p) => `{ templateId: ${gql(p.templateId)}, pageDesignId: ${gql(p.pageDesignId)} }`)
        .join(', ')}] }) }`,
    );
    // Executed is not verified: every pair is in the stored (URL-encoded) mapping.
    const back = await readBack(q, root, 'en', ['TemplatesMapping']);
    const stored = templatesMapping(back?.fields.get('templatesmapping') ?? '');
    const missing = a.data.mappings.filter(
      (_, i) => stored.get(bare(pairs[i]!.templateId)) !== bare(pairs[i]!.pageDesignId),
    );
    return missing.length
      ? {
          code: 409,
          body: { mapped: pairs.length - missing.length, missing },
          summary: `Mapped page designs, but ${missing.map((m) => m.templatePath).join(', ')} doesn't read back`,
        }
      : {
          code: 200,
          body: { mapped: pairs.length },
          summary: `Mapped ${pairs.length} page template${pairs.length === 1 ? '' : 's'} to their page designs, read back`,
        };
  }

  private async template(q: Gql, a: Parsed<typeof TemplateArgs>): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const parent = await this.idOf(q, a.data.parentPath);
    const sections = a.data.sections
      .map(
        (s) =>
          `{ name: ${gql(s.name)}, fields: [${s.fields.map((f) => `{ name: ${gql(f.name)}, type: ${gql(f.type)} }`).join(', ')}] }`,
      )
      .join(', ');
    const d = await q.run<{ createItemTemplate: { itemTemplate: { name: string } } }>(
      `mutation { createItemTemplate(input: { name: ${gql(a.data.name)}, parent: ${gql(parent)}, sections: [${sections}] }) {
        itemTemplate { name ownFields { nodes { name type } } } } }`,
    );
    return {
      code: 200,
      body: d.createItemTemplate.itemTemplate,
      summary: `Created template ${a.data.parentPath}/${a.data.name}`,
    };
  }

  private async rendering(
    q: Gql,
    a: Parsed<typeof RenderingArgs>,
    lang: Lang,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const fields = [{ name: 'componentName', value: a.data.componentName }];
    if (a.data.datasourceTemplatePath)
      fields.push({ name: 'Datasource Template', value: a.data.datasourceTemplatePath });
    if (a.data.datasourceLocation)
      fields.push({ name: 'Datasource Location', value: a.data.datasourceLocation });
    if (a.data.parametersTemplatePath)
      fields.push({
        name: 'Parameters Template',
        value: sitecoreId(await this.idOf(q, a.data.parametersTemplatePath)),
      });
    return this.create(
      q,
      CreateArgs.safeParse({
        parentPath: a.data.parentPath,
        name: a.data.name,
        templatePath: JSON_RENDERING,
        fields,
      }),
      lang,
    );
  }

  private async layout(q: Gql, a: Parsed<typeof LayoutArgs>, lang: Lang): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    // Paths and IDs alike must name an item that exists: a layout pointing at nothing renders nothing.
    const resolve = async (v: string) =>
      sitecoreId(HEX_ID.test(v) ? await this.idExists(q, v) : await this.idOf(q, v));
    let xml: string;
    if (a.data.renderings) {
      const parts: string[] = [];
      for (const r of a.data.renderings) {
        const id = await resolve(r.rendering);
        const ds = r.datasource ? await resolve(r.datasource) : '';
        const par = r.parameters
          ? Object.entries(r.parameters)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join('&')
          : '';
        parts.push(
          `<r ds="${ds}" id="${id}" par="${xmlAttr(par)}" ph="${xmlAttr(r.placeholder)}" uid="${sitecoreId(randomUUID())}" />`,
        );
      }
      xml = `<r xmlns:xsd="http://www.w3.org/2001/XMLSchema"><d id="${DEFAULT_DEVICE}" l="${HEADLESS_LAYOUT}">${parts.join('')}</d></r>`;
    } else {
      xml = stored(a.data.renderingsXml!);
      // Each rendering needs its rendering ID (`id`, or `s:id` in a delta); without it Page builder shows nothing.
      const inner = [...xml.matchAll(/<d\b[^>]*>([\s\S]*?)<\/d>/gi)].flatMap((m) =>
        [...m[1]!.matchAll(/<r\b([^>]*)>/gi)].map((r) => r[1]!),
      );
      const missing = inner.filter((attrs) => !/(?:^|\s)(?:s:)?id="/i.test(attrs));
      if (!inner.length || missing.length)
        return bad(
          `${missing.length || 'No'} rendering${missing.length === 1 ? '' : 's'} in renderingsXml ${inner.length ? 'lack a rendering ID (id="{…}")' : 'found under a <d> device'}. Give renderings instead and the tool writes the XML.`,
        );
    }
    // The whole layout on the page's shared presentation; the page's own (final) layout edits are
    // cleared so they can't override it. Page builder's later edits go on top as usual.
    const r = await this.update(
      q,
      UpdateArgs.safeParse({
        path: a.data.path,
        language: a.data.language,
        fields: [
          { name: '__Renderings', value: xml },
          { name: '__Final Renderings', value: '' },
        ],
      }),
      lang,
    );
    if (r.code !== 200) return r;
    const count = (xml.match(/<r\b[^>]*\bph=/gi) ?? []).length;
    return {
      ...r,
      body: { ...(r.body as object), renderings: count },
      summary: `Placed ${count} component${count === 1 ? '' : 's'} on ${a.data.path}, read back`,
    };
  }

  private async media(
    q: Gql,
    a: Parsed<typeof MediaArgs>,
    facts: TenantFacts,
    ctx: ToolCallContext,
    lang: Lang,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const { projectId, token } = ctx;
    let bytes: Uint8Array;
    let type: string;
    let name: string;
    let from: string;
    if (a.data.ref) {
      // A file the browser downloaded for this project; its host was checked there.
      if (!a.data.ref.startsWith(`blob://${projectId}/assets/`))
        return bad(`${a.data.ref} isn't a file downloaded for this project.`);
      if (!this.opts.blobs) return bad('Stored files are not available here; give sourceUrl.', 501);
      try {
        bytes = await this.opts.blobs.get(a.data.ref);
      } catch {
        return bad(
          `No stored file at ${a.data.ref}; download it again with browser.fetch.asset.`,
          404,
        );
      }
      const ext = /\.([a-z0-9]{2,5})$/i.exec(a.data.ref)?.[1]?.toLowerCase() ?? 'bin';
      type = MEDIA_TYPES[ext] ?? 'application/octet-stream';
      name = a.data.fileName ?? `${a.data.itemPath.split('/').pop() || 'file'}.${ext}`;
      from = a.data.ref;
    } else {
      const source = new URL(a.data.sourceUrl!);
      if (!facts.sourceHosts.includes(source.hostname)) {
        return bad(
          `${source.hostname} is not the project's source site. Download it with browser.fetch.asset and upload its ref instead.`,
        );
      }
      const file = await this.fetch(source, { signal: AbortSignal.timeout(60_000) });
      if (!file.ok)
        return {
          code: 424,
          body: { error: `The source answered ${file.status} for ${source.href}` },
        };
      bytes = new Uint8Array(await file.arrayBuffer());
      type = file.headers.get('content-type') ?? 'application/octet-stream';
      name = decodeURIComponent(source.pathname.split('/').pop() || 'file');
      from = source.href;
    }
    if (bytes.length > MAX_MEDIA_BYTES) return bad(`${from} is larger than 25 MB.`);
    const relative = a.data.itemPath.slice(MEDIA_ROOT.length);
    const d = await q.run<{ uploadMedia: { presignedUploadUrl: string } }>(
      `mutation { uploadMedia(input: { itemPath: ${gql(relative)} }) { presignedUploadUrl } }`,
    );
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
    const up = await this.fetch(d.uploadMedia.presignedUploadUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    if (!up.ok) {
      return {
        code: up.status,
        body: {
          error: `The media upload answered ${up.status}: ${(await up.text()).slice(0, 200)}`,
        },
      };
    }
    // Images carry alt text; a file (a PDF, a document) has no Alt field, and its link text
    // describes it where it's used.
    let alt = a.data.alt ?? null;
    if (alt) {
      try {
        await this.update(
          q,
          UpdateArgs.safeParse({ path: a.data.itemPath, fields: [{ name: 'Alt', value: alt }] }),
          lang,
        );
      } catch (err) {
        if (!(err instanceof GqlError) || !/field with the name Alt/i.test(err.message)) throw err;
        alt = null;
      }
    }
    return {
      code: 200,
      body: { itemPath: a.data.itemPath, bytes: bytes.length, alt },
      summary: `Uploaded ${a.data.itemPath} (${Math.round(bytes.length / 1024)} KB)${a.data.alt && !alt ? '; no Alt field on this media type, so no alt text' : ''}`,
    };
  }

  private async publish(
    q: Gql,
    a: Parsed<typeof PublishArgs>,
    facts: TenantFacts,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const ids = await Promise.all(a.data.paths.map((p) => this.idOf(q, p)));
    const languages = a.data.languages ?? (facts.languages.length ? facts.languages : ['en']);
    const d = await q.run<{ publishItem: { operationId: string } }>(
      `mutation { publishItem(input: {
        sourceDatabase: "master", targetDatabases: ["experienceedge"],
        rootItemIds: ${JSON.stringify(ids)}, publishSubItems: ${a.data.subItems ?? true},
        publishRelatedItems: false, publishItemMode: SMART, languages: ${JSON.stringify(languages)},
        displayName: ${gql(`Launchworks: ${a.data.paths.join(', ')}`.slice(0, 200))}
      }) { operationId } }`,
    );
    const id = d.publishItem.operationId;
    const s = await q
      .run<{ publishingStatus: { state: string; isDone: boolean; isFailed: boolean } }>(
        `query { publishingStatus(publishingOperationId: ${gql(id)}) { state isDone isFailed } }`,
      )
      .catch(() => null);
    return {
      code: 200,
      body: { operationId: id, status: s?.publishingStatus ?? null, languages },
      summary: `Publishing ${a.data.paths.length} item${a.data.paths.length === 1 ? '' : 's'} to Experience Edge (${s?.publishingStatus.state ?? 'queued'})`,
    };
  }

  private async publishStatus(q: Gql, a: Parsed<typeof PublishStatusArgs>): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const s = await q.run<{
      publishingStatus: { state: string; isDone: boolean; isFailed: boolean } | null;
    }>(
      `query { publishingStatus(publishingOperationId: ${gql(a.data.operationId)}) { state isDone isFailed } }`,
    );
    const st = s.publishingStatus;
    if (!st) return { code: 404, body: { error: 'No such publishing operation.' } };
    return {
      code: 200,
      body: { operationId: a.data.operationId, ...st },
      summary: `Publishing ${st.isFailed ? 'failed' : st.isDone ? 'done' : 'in progress'} (${st.state})`,
    };
  }

  private async edgeRoutes(
    projectId: string,
    a: Parsed<typeof EdgeRoutesArgs>,
    facts: TenantFacts,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const live = a.data.live ?? true;
    const contextId = await this.opts.edgeContextId?.(projectId, live);
    if (!contextId) {
      const error = `No Experience Edge ${live ? 'live' : 'preview'} Context ID is stored for this project.`;
      return { code: 409, body: { error }, summary: error };
    }
    const url = new URL('/v1/content/api/graphql/v1', this.opts.edgeUrl ?? EDGE_URL);
    url.searchParams.set('sitecoreContextId', contextId);
    const found: string[] = [];
    const missing: string[] = [];
    for (const path of [...new Set(a.data.paths)]) {
      const res = await this.fetch(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query:
            'query($site: String!, $path: String!, $lang: String!) { layout(site: $site, routePath: $path, language: $lang) { item { name } } }',
          variables: { site: facts.site, path, lang: facts.languages[0] ?? 'en' },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const b = (await res.json().catch(() => ({}))) as {
        data?: { layout?: { item?: { name?: string } | null } | null };
      };
      (b.data?.layout?.item ? found : missing).push(path);
    }
    return {
      code: 200,
      body: { endpoint: live ? 'live' : 'preview', found, missing },
      summary: `${found.length} of ${found.length + missing.length} routes resolve on Experience Edge (${live ? 'live' : 'preview'})${missing.length ? `; missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}` : ''}`,
    };
  }

  private async site(q: Gql, a: Parsed<typeof SiteArgs>, facts: TenantFacts): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const collection = a.data.collection ?? facts.siteCollection;
    const site = a.data.site ?? facts.site;
    const d = await q.run<{ sites: { name: string; rootPath: string }[] }>(
      'query { sites { name rootPath } }',
    );
    const want = `/sitecore/content/${collection}/${site}`.toLowerCase();
    const found = d.sites.find((s) => s.rootPath.toLowerCase() === want);
    if (found)
      return {
        code: 200,
        body: { exists: true, ...found },
        summary: `Site ${found.rootPath} exists`,
      };
    return {
      code: 409,
      body: {
        error: `There is no site ${site} in collection ${collection}. Create it in SitecoreAI Sites (it scaffolds the site from a site template), then retry.`,
        sites: d.sites,
      },
    };
  }

  private async language(q: Gql, a: Parsed<typeof LanguageArgs>): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const path = `/sitecore/system/Languages/${a.data.code}`;
    const existing = await q.run<{ item: { itemId: string } | null }>(
      `query { item(where: { database: "master", path: ${gql(path)} }) { itemId } }`,
    );
    if (existing.item)
      return {
        code: 200,
        body: { code: a.data.code, existed: true },
        summary: `${a.data.code} already exists`,
      };
    const iso = a.data.code.split('-')[0]!;
    return this.create(
      q,
      CreateArgs.safeParse({
        parentPath: '/sitecore/system/Languages',
        name: a.data.code,
        templatePath: LANGUAGE_TEMPLATE,
        language: 'en',
        fields: [
          { name: 'Iso', value: iso },
          { name: 'Regional Iso Code', value: a.data.code },
        ],
      }),
      (l) => l ?? 'en',
    );
  }

  /** The site's Site Grouping item and its rendering host field. */
  private async grouping(q: Gql, facts: TenantFacts) {
    const root = `/sitecore/content/${facts.siteCollection}/${facts.site}/Settings/Site Grouping`;
    const d = await q.run<{
      item: {
        children: {
          nodes: {
            itemId: string;
            name: string;
            path: string;
            fields: { nodes: { name: string; value: string }[] };
          }[];
        };
      } | null;
    }>(
      `query { item(where: { database: "master", path: ${gql(root)} }) {
        children { nodes { itemId name path fields(ownFields: false, excludeStandardFields: true) { nodes { name value } } } }
      } }`,
    );
    const items = d.item?.children.nodes ?? [];
    const site = facts.site.toLowerCase();
    const value = (it: (typeof items)[number], name: RegExp) =>
      it.fields.nodes.find((f) => name.test(f.name));
    const item =
      items.find((it) => value(it, /^site ?name$/i)?.value.toLowerCase() === site) ??
      items.find((it) => it.name.toLowerCase() === site) ??
      items[0];
    if (!item) return { root, item: null, field: null };
    // Named `RenderingHost` on SitecoreAI's Site Grouping template; shown as "Predefined
    // application rendering host".
    const field = value(item, /^rendering ?host$/i) ?? value(item, /rendering ?host/i) ?? null;
    return { root, item, field };
  }

  /** The rendering host items, with their fields. */
  private async hosts(q: Gql) {
    const d = await q.run<{
      item: {
        children: {
          nodes: {
            itemId: string;
            name: string;
            path: string;
            template: { templateId: string };
            fields: { nodes: { name: string; value: string }[] };
          }[];
        };
      } | null;
    }>(
      `query { item(where: { database: "master", path: ${gql(HOSTS)} }) {
        children { nodes { itemId name path template { templateId } fields(ownFields: false, excludeStandardFields: true) { nodes { name value } } } }
      } }`,
    );
    return d.item?.children.nodes ?? [];
  }

  private async hostRead(q: Gql, facts: TenantFacts): Promise<ToolResult> {
    const [g, hosts] = await Promise.all([this.grouping(q, facts), this.hosts(q)]);
    const urls = (h: (typeof hosts)[number]) =>
      Object.fromEntries(
        h.fields.nodes.filter((f) => /url/i.test(f.name)).map((f) => [f.name, f.value]),
      );
    const chosen = g.field?.value ?? null;
    return {
      code: 200,
      body: {
        siteGrouping: g.item?.path ?? null,
        settingField: g.field?.name ?? null,
        renderingHost: chosen,
        hosts: hosts.map((h) => ({ name: h.name, itemId: h.itemId, urls: urls(h) })),
      },
      summary: g.item
        ? `${facts.site} renders through ${chosen ? `"${chosen}"` : 'the default host (no setting)'}; ${hosts.length} rendering host${hosts.length === 1 ? '' : 's'}: ${hosts.map((h) => h.name).join(', ')}`
        : `No Site Grouping item under ${g.root}`,
    };
  }

  private async hostSet(
    q: Gql,
    a: Parsed<typeof HostArgs>,
    facts: TenantFacts,
    lang: Lang,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const origin = new URL(a.data.url).origin;
    const hosts = await this.hosts(q);
    // Copy the environment's own host: its template and field names, with this head's URLs.
    const model = hosts.find((h) => h.name.toLowerCase() === 'default') ?? hosts[0];
    if (!model) return bad(`No rendering host under ${HOSTS} to copy.`, 404);
    const url = (name: string) =>
      /endpoint/i.test(name)
        ? `${origin}/api/editing/render`
        : /config/i.test(name)
          ? `${origin}/api/editing/config`
          : /application/i.test(name)
            ? origin
            : null;
    const fields = model.fields.nodes.flatMap((f) => {
      const v = url(f.name);
      return v ? [{ name: f.name, value: v }] : [];
    });
    if (!fields.length)
      return bad(
        `${model.path} has no URL fields to set (fields: ${model.fields.nodes.map((f) => f.name).join(', ')}).`,
      );
    // The site's setting first: when it can't be set, nothing is created.
    const g = await this.grouping(q, facts);
    if (!g.item) return bad(`No Site Grouping item under ${g.root}.`, 404);
    if (!g.field)
      return bad(
        `${g.item.path} has no rendering host field (fields: ${g.item.fields.nodes.map((f) => f.name).join(', ')}).`,
      );
    const name = facts.site;
    const path = `${HOSTS}/${name}`;
    const existing = hosts.find((h) => h.name.toLowerCase() === name.toLowerCase());
    const host = existing
      ? await this.update(q, UpdateArgs.safeParse({ path: existing.path, fields }), lang)
      : await this.create(
          q,
          CreateArgs.safeParse({
            parentPath: HOSTS,
            name,
            templateId: model.template.templateId,
            fields,
          }),
          lang,
        );
    if (host.code !== 200) return host;

    // The setting holds a host's name, or its ID: write it the way it is stored.
    const hostId = (host.body as { itemId?: string }).itemId ?? existing?.itemId ?? '';
    const value = /^\{?[0-9a-f-]{36}\}?$/i.test(g.field.value.trim()) ? hostId : name;
    const set = await this.update(
      q,
      UpdateArgs.safeParse({ path: g.item.path, fields: [{ name: g.field.name, value }] }),
      lang,
    );
    if (set.code !== 200) return set;
    return {
      code: 200,
      body: {
        renderingHost: path,
        url: origin,
        fields,
        siteGrouping: g.item.path,
        setting: g.field.name,
        value,
      },
      summary: `${facts.site} now renders through ${origin} in Page builder: rendering host ${path} (${fields.map((f) => f.name).join(', ')}), and ${g.item.path} "${g.field.name}" set to ${value}; both read back`,
    };
  }

  /** An item's ID by path, or a 404 the agent can act on. */
  /** The item's ID when an item has it, else 404. */
  private async idExists(q: Gql, id: string): Promise<string> {
    const d = await q.run<{ item: { itemId: string } | null }>(
      `query { item(where: { database: "master", itemId: ${gql(sitecoreId(id))} }) { itemId } }`,
    );
    if (!d.item) throw new GqlError(404, `No item with ID ${id}`);
    return d.item.itemId;
  }

  private async idOf(q: Gql, path: string): Promise<string> {
    const d = await q.run<{ item: { itemId: string } | null }>(
      `query { item(where: { database: "master", path: ${gql(path)} }) { itemId } }`,
    );
    if (!d.item) throw new GqlError(404, `No item at ${path}`);
    return d.item.itemId;
  }
}

type Lang = (l?: string) => string;

const bare = (id: string) => id.replace(/[{}-]/g, '').toLowerCase();
const braced = (id: string) => {
  const h = bare(id).toUpperCase();
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
};

/**
 * TemplatesMapping as template → page design (bare IDs). Sitecore stores it URL-encoded twice over:
 * `%7b<template>%7d%3d%257B<design>%257D%26…`.
 */
function templatesMapping(value: string): Map<string, string> {
  let v = value;
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(v); i++) v = decodeURIComponent(v);
  return new Map(
    v
      .split(/[&|]/)
      .map((pair) => pair.split('='))
      .filter((kv): kv is [string, string] => kv.length === 2)
      .map(([t, d]) => [bare(t), bare(d)]),
  );
}

/**
 * An item's field values, inherited ones included (a rendering's Datasource Template, a group's
 * Renderings), or null when there is no item at the path. Named fields are asked for one by one:
 * the item's whole field list comes back in pages, and on an item with many standard fields (a
 * template's standard values) the ones written can fall outside the first page.
 */
async function readBack(
  q: Gql,
  path: string,
  language: string,
  names: string[] = [],
): Promise<{ itemId: string; path: string; fields: Map<string, string> } | null> {
  const where = `where: { database: "master", path: ${gql(path)}, language: ${gql(language)} }`;
  let found: { itemId: string; path: string; fields: Map<string, string> } | null = null;
  if (names.length) {
    try {
      const d = await q.run<{
        item: ({ itemId: string; path: string } & Record<string, { value: string } | null>) | null;
      }>(
        `query { item(${where}) {
          itemId path ${names.map((n, i) => `f${i}: field(name: ${gql(n)}) { value }`).join(' ')}
        } }`,
      );
      if (!d.item) return null;
      const fields = new Map<string, string>();
      names.forEach((n, i) => {
        const f = d.item![`f${i}`] as { value: string } | null | undefined;
        if (f) fields.set(n.toLowerCase(), f.value);
      });
      found = { itemId: d.item.itemId, path: d.item.path, fields };
      if (names.every((n) => fields.has(n.toLowerCase()))) return found;
    } catch (err) {
      // An API without single-field reads: fall back to the field list.
      if (!(err instanceof GqlError)) throw err;
    }
  }
  // The whole field list, asking for a page large enough for every standard field, or the
  // API's default page where it doesn't take a size.
  type Listed = {
    item: {
      itemId: string;
      path: string;
      fields: { nodes: { name: string; value: string }[] };
    } | null;
  };
  const list = (size: string) =>
    q.run<Listed>(
      `query { item(${where}) {
        itemId path fields(ownFields: false, excludeStandardFields: false${size}) { nodes { name value } }
      } }`,
    );
  let d: Listed;
  try {
    d = await list(', first: 1000');
  } catch (err) {
    if (!(err instanceof GqlError)) throw err;
    d = await list('');
  }
  if (!d.item) return found;
  const fields = new Map(d.item.fields.nodes.map((f) => [f.name.toLowerCase(), f.value]));
  // What the single-field reads found stands; the list fills in the rest.
  for (const [k, v] of found?.fields ?? []) fields.set(k, v);
  return { itemId: d.item.itemId, path: d.item.path, fields };
}

/** A value inside a double-quoted XML attribute. */
const xmlAttr = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A stored value as written: IDs and ID lists Sitecore keeps uppercase in braces compare equal. */
const canonical = (v: string) => {
  const t = v.trim();
  if (/^<r[\s>]/i.test(t)) return layoutKey(t);
  return t.split('|').every((p) => HEX_ID.test(p)) ? t.replace(/[{}-]/g, '').toLowerCase() : t;
};

/**
 * Layout XML as what it means: each device's layout and its renderings (rendering, placeholder,
 * datasource). Sitecore rewrites the XML it stores (braces, case, attribute order, attributes it
 * adds), so comparing the text would call a good write a mismatch.
 */
function layoutKey(xml: string): string {
  const attrs = (tag: string) =>
    Object.fromEntries(
      [...tag.matchAll(/(?:s:)?([a-z]+)="([^"]*)"/gi)].map((m) => [
        m[1]!.toLowerCase(),
        HEX_ID.test(m[2]!) ? m[2]!.replace(/[{}-]/g, '').toLowerCase() : m[2]!.toLowerCase(),
      ]),
    );
  const devices = [...xml.matchAll(/<d\b([^>]*)>([\s\S]*?)<\/d>|<d\b([^>]*)\/>/gi)].map((m) => {
    const d = attrs(m[1] ?? m[3] ?? '');
    const renderings = [...(m[2] ?? '').matchAll(/<r\b([^>]*)>/gi)]
      .map((r) => {
        const a = attrs(r[1]!);
        return [a.id ?? '', a.ph ?? '', a.ds ?? ''].join(' ');
      })
      .sort();
    return `${d.id ?? ''} ${d.l ?? ''}: ${renderings.join('; ')}`;
  });
  return `layout ${devices.sort().join(' / ')}`;
}

/** Fields whose stored value isn't what was written, with what was read back. */
function compare(
  written: { name: string; value: string }[],
  stored: Map<string, string>,
): string[] {
  return written
    .filter((f) => canonical(stored.get(f.name.toLowerCase()) ?? '') !== canonical(f.value))
    .map((f) => {
      const back = stored.get(f.name.toLowerCase());
      return back === undefined
        ? `${f.name} (no such field on this item)`
        : `${f.name} (reads "${back.length > 80 ? `${back.slice(0, 80)}…` : back}")`;
    });
}
type Parsed<S extends z.ZodType> = z.ZodSafeParseResult<z.infer<S>>;

const fieldsOf = (fields: { name: string; value: string }[]) =>
  `[${fields.map((f) => `{ name: ${gql(f.name)}, value: ${gql(stored(f.value))} }`).join(', ')}]`;

const HEX_ID = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;

/**
 * An ID as Sitecore keeps it in a field: `{8-4-4-4-12}`, uppercase. The authoring API answers with
 * 32 bare hex digits; written into a field or a layout that way, Sitecore can't read it as an ID,
 * and a layout's renderings point at nothing (an empty Controls list, an empty page in Page builder).
 */
function sitecoreId(id: string): string {
  const h = id.replace(/[{}-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(h)) throw new GqlError(422, `${id} is not an item ID`);
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
}

/** A field value with its IDs in the form Sitecore reads: a single ID, an ID list, layout XML. */
function stored(value: string): string {
  const t = value.trim();
  if (/^<r[\s>]/i.test(t))
    return value.replace(/(\s(?:s:)?(?:id|ds|l|uid)=")([^"]*)"/gi, (m, pre: string, v: string) =>
      HEX_ID.test(v) ? `${pre}${sitecoreId(v)}"` : m,
    );
  const parts = t.split('|');
  return t && parts.every((p) => HEX_ID.test(p)) ? parts.map(sitecoreId).join('|') : value;
}

class GqlError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** One GraphQL endpoint with a bearer token. GraphQL errors become a 422 with their messages. */
class Gql {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly url: string,
    private readonly token: string,
  ) {}

  async run<T>(query: string): Promise<T> {
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let body: { data?: T; errors?: { message: string }[] } = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok && !body.errors) {
      throw new GqlError(
        res.status,
        `The Authoring API answered ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    if (body.errors?.length) {
      throw new GqlError(
        res.status === 200 ? 422 : res.status,
        `The Authoring API refused it: ${body.errors
          .map((e) => e.message)
          .join('; ')
          .slice(0, 500)}`,
      );
    }
    return body.data as T;
  }
}
