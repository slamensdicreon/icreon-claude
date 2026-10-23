import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
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
}

const MEDIA_ROOT = '/sitecore/media library/';
const JSON_RENDERING = '/sitecore/templates/Foundation/JavaScript Services/Json Rendering';
const LANGUAGE_TEMPLATE = '/sitecore/templates/System/Language';
const MAX_MEDIA_BYTES = 25_000_000;

const Path = z.string().startsWith('/sitecore/').max(500);
const Field = z.object({ name: z.string().min(1), value: z.string() });
const ReadArgs = z.object({
  path: Path,
  language: z.string().optional(),
  children: z.boolean().optional(),
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
const UpdateArgs = z.object({
  path: Path,
  language: z.string().optional(),
  fields: z.array(Field).min(1).max(200),
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
const LayoutArgs = z.object({
  path: Path,
  renderingsXml: z.string().min(1).max(500_000),
  shared: z.boolean().optional(),
  language: z.string().optional(),
});
const MediaArgs = z.object({
  itemPath: z.string().startsWith(MEDIA_ROOT).max(500),
  sourceUrl: z.url({ protocol: /^https$/ }),
  alt: z.string().max(500).optional(),
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
const LanguageArgs = z.object({
  /** e.g. "es-US" */
  code: z.string().regex(/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/),
});

const bad = (message: string): ToolResult => ({
  code: 422,
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
        'Read an item by absolute path (fields, template, and with children:true its children).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          language: { type: 'string' },
          children: { type: 'boolean' },
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
        "Set a page's presentation: renderingsXml is the layout definition XML (<r><d id=... l=...><r uid=... s=... ph=... ds=... /></d></r>). Writes Final Renderings unless shared:true.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          renderingsXml: { type: 'string' },
          shared: { type: 'boolean' },
          language: { type: 'string' },
        },
        required: ['path', 'renderingsXml'],
        additionalProperties: false,
      },
      mutates: true,
      pathArgs: ['path'],
    },
    'media.upload': {
      description:
        'Upload an image or file from the source site into the media library. itemPath is the absolute media item path (under /sitecore/media library/); sourceUrl must be on the source site.',
      inputSchema: {
        type: 'object',
        properties: {
          itemPath: { type: 'string' },
          sourceUrl: { type: 'string' },
          alt: { type: 'string' },
        },
        required: ['itemPath', 'sourceUrl'],
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
        case 'template.create':
          return await this.template(q, TemplateArgs.safeParse(args));
        case 'rendering.create':
          return await this.rendering(q, RenderingArgs.safeParse(args), lang);
        case 'layout.compose':
          return await this.layout(q, LayoutArgs.safeParse(args), lang);
        case 'media.upload':
          return await this.media(q, MediaArgs.safeParse(args), facts, ctx.token, lang);
        case 'publish':
          return await this.publish(q, PublishArgs.safeParse(args), facts);
        case 'site.verify':
        case 'site.create':
          return await this.site(q, SiteArgs.safeParse(args), facts);
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
    const d = await q.run<{ item: unknown }>(
      `query { item(where: { database: "master", path: ${gql(a.data.path)}, language: ${gql(lang(a.data.language))} }) {
        itemId name path template { name templateId }
        fields(ownFields: true, excludeStandardFields: true) { nodes { name value } }
        ${a.data.children ? 'children { nodes { itemId name path template { name } } }' : ''}
      } }`,
    );
    if (!d.item) return { code: 404, body: { error: `No item at ${a.data.path}` } };
    return { code: 200, body: d.item, summary: `Read ${a.data.path}` };
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
    const back = await readBack(q, path, language);
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
    const back = await readBack(q, a.data.path, language);
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
        value: await this.idOf(q, a.data.parametersTemplatePath),
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
    const field = a.data.shared ? '__Renderings' : '__Final Renderings';
    const r = await this.update(
      q,
      UpdateArgs.safeParse({
        path: a.data.path,
        language: a.data.language,
        fields: [{ name: field, value: a.data.renderingsXml }],
      }),
      lang,
    );
    return r.code === 200 ? { ...r, summary: `Set ${field} on ${a.data.path}` } : r;
  }

  private async media(
    q: Gql,
    a: Parsed<typeof MediaArgs>,
    facts: TenantFacts,
    token: string,
    lang: Lang,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const source = new URL(a.data.sourceUrl);
    if (!facts.sourceHosts.includes(source.hostname)) {
      return bad(
        `${source.hostname} is not the project's source site; media comes only from there.`,
      );
    }
    const file = await this.fetch(source, { signal: AbortSignal.timeout(60_000) });
    if (!file.ok)
      return {
        code: 424,
        body: { error: `The source answered ${file.status} for ${source.href}` },
      };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) return bad(`${source.href} is larger than 25 MB.`);
    const relative = a.data.itemPath.slice(MEDIA_ROOT.length);
    const d = await q.run<{ uploadMedia: { presignedUploadUrl: string } }>(
      `mutation { uploadMedia(input: { itemPath: ${gql(relative)} }) { presignedUploadUrl } }`,
    );
    const name = decodeURIComponent(source.pathname.split('/').pop() || 'file');
    const form = new FormData();
    form.append(
      'file',
      new Blob([bytes], { type: file.headers.get('content-type') ?? 'application/octet-stream' }),
      name,
    );
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
    if (a.data.alt) {
      await this.update(
        q,
        UpdateArgs.safeParse({
          path: a.data.itemPath,
          fields: [{ name: 'Alt', value: a.data.alt }],
        }),
        lang,
      );
    }
    return {
      code: 200,
      body: { itemPath: a.data.itemPath, bytes: bytes.length, alt: a.data.alt ?? null },
      summary: `Uploaded ${a.data.itemPath} (${Math.round(bytes.length / 1024)} KB)`,
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

  /** An item's ID by path, or a 404 the agent can act on. */
  private async idOf(q: Gql, path: string): Promise<string> {
    const d = await q.run<{ item: { itemId: string } | null }>(
      `query { item(where: { database: "master", path: ${gql(path)} }) { itemId } }`,
    );
    if (!d.item) throw new GqlError(404, `No item at ${path}`);
    return d.item.itemId;
  }
}

type Lang = (l?: string) => string;

/** An item's own field values, or null when there is no item at the path. */
async function readBack(
  q: Gql,
  path: string,
  language: string,
): Promise<{ itemId: string; path: string; fields: Map<string, string> } | null> {
  const d = await q.run<{
    item: {
      itemId: string;
      path: string;
      fields: { nodes: { name: string; value: string }[] };
    } | null;
  }>(
    `query { item(where: { database: "master", path: ${gql(path)}, language: ${gql(language)} }) {
      itemId path fields(ownFields: true, excludeStandardFields: false) { nodes { name value } }
    } }`,
  );
  if (!d.item) return null;
  return {
    itemId: d.item.itemId,
    path: d.item.path,
    fields: new Map(d.item.fields.nodes.map((f) => [f.name.toLowerCase(), f.value])),
  };
}

/** Fields whose stored value isn't what was written. */
function compare(
  written: { name: string; value: string }[],
  stored: Map<string, string>,
): string[] {
  return written
    .filter((f) => (stored.get(f.name.toLowerCase()) ?? '').trim() !== f.value.trim())
    .map((f) => f.name);
}
type Parsed<S extends z.ZodType> = z.ZodSafeParseResult<z.infer<S>>;

const fieldsOf = (fields: { name: string; value: string }[]) =>
  `[${fields.map((f) => `{ name: ${gql(f.name)}, value: ${gql(f.value)} }`).join(', ')}]`;

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
