import { fileURLToPath } from 'node:url';
import type { IntakeFacts } from '@lw/contracts';
import {
  optimizelyCmsUrl,
  optimizelyToken,
  verifyCmsApiClient,
  verifyGraphHmac,
  verifyGraphSingleKey,
  type OptimizelyVerifyConfig,
} from '@lw/connectors';
import type { PlatformPack } from '../src/index';
import { list, text, type TargetValues } from '../src/values';

/**
 * Optimizely CMS (SaaS): one instance reached through the CMS REST API v1 (content types,
 * display templates, content, applications), Optimizely Graph for delivery and preview, Visual
 * Builder for marketers, and a Next.js head on the SDK (`@optimizely/cms-sdk`) hosted on Vercel.
 */

export function hostOf(cmsUrl: string): string {
  try {
    return new URL(/^https?:\/\//.test(cmsUrl) ? cmsUrl : `https://${cmsUrl}`).host;
  } catch {
    return cmsUrl;
  }
}

/** Optimizely's target values, typed. */
export interface OptimizelyTarget {
  /** The instance's origin, `https://app-<id>.cms.optimizely.com`. */
  cmsUrl: string;
  /** The application (website) in Settings → Applications this project builds. */
  application: string;
  /** Content type and display template keys start with it: types are instance-wide. */
  typePrefix: string;
  languages: string[];
  hostingProject: string | null;
}

export function optimizelyTarget(intake: Pick<IntakeFacts, 'target'>): OptimizelyTarget {
  const t = intake.target;
  return {
    cmsUrl: text(t, 'cmsUrl'),
    application: text(t, 'application'),
    typePrefix: text(t, 'typePrefix'),
    languages: list(t, 'languages'),
    hostingProject: text(t, 'hostingProject') || null,
  };
}

/**
 * Scope placeholders. Content types, display templates and media are instance-wide on
 * Optimizely, so a project owns the ones carrying its prefix; content is owned through the
 * application's own tree, which the CMS tool server addresses as `/content/<application>/…`
 * (a key's container chain, as a path).
 */
export function optimizelyBindings(t: TargetValues): Record<string, string> {
  const { application, typePrefix } = optimizelyTarget({ target: t });
  return {
    application,
    typePrefix,
    project: application,
    contentRoot: `/content/${application}`,
  };
}

/** The paths a project may write in. */
export function optimizelyOwnedPaths(t: TargetValues): string[] {
  const b = optimizelyBindings(t);
  return [
    `${b.contentRoot}`,
    `/contenttypes/${b.typePrefix}*`,
    `/displaytemplates/${b.typePrefix}*`,
    `/media/${b.application}`,
    `/applications/${b.application}`,
  ];
}

export function createOptimizely(cfg: OptimizelyVerifyConfig): PlatformPack {
  const clientToken = async (secret: Record<string, string>) => {
    const r = await optimizelyToken(cfg, secret.clientId ?? '', secret.clientSecret ?? '');
    if (!('token' in r)) throw new Error(r.detail);
    return {
      token: r.token,
      expiresAt: r.expiresAt ? Date.parse(r.expiresAt) : Date.now() + 4 * 60_000,
    };
  };
  const headVars = async (
    t: TargetValues,
    credential: (id: string) => Promise<Record<string, string> | null>,
  ) => {
    const s = optimizelyTarget({ target: t });
    const vars = [
      { key: 'OPTIMIZELY_CMS_URL', value: s.cmsUrl, sensitive: false },
      { key: 'OPTIMIZELY_GRAPH_GATEWAY', value: new URL(cfg.graphUrl).origin, sensitive: false },
      { key: 'OPTIMIZELY_DEFAULT_LOCALE', value: s.languages[0] ?? 'en', sensitive: false },
    ];
    const missing: string[] = [];
    const single = await credential('graph-single-key');
    if (single?.singleKey) {
      // Reads published content only; Optimizely designs it to be safe in a browser.
      vars.push({ key: 'OPTIMIZELY_GRAPH_SINGLE_KEY', value: single.singleKey, sensitive: false });
    } else missing.push('the Graph single key was not given');
    const hmac = await credential('graph-hmac');
    if (hmac?.appKey && hmac.secret) {
      vars.push(
        { key: 'OPTIMIZELY_GRAPH_APP_KEY', value: hmac.appKey, sensitive: true },
        { key: 'OPTIMIZELY_GRAPH_SECRET', value: hmac.secret, sensitive: true },
      );
    } else {
      missing.push(
        'the Graph app key and secret were not given: the head reads drafts only through preview tokens',
      );
    }
    return { vars, missing };
  };
  return {
    id: 'optimizely',
    name: 'Optimizely CMS (SaaS)',
    about: {
      vendor: 'Optimizely',
      category: 'Headless CMS, SaaS',
      description:
        'Content types defined in code, pages composed in Visual Builder, delivered through Optimizely Graph, with a Next.js head on the JavaScript SDK.',
    },
    fields: {
      cmsUrl: {
        label: 'CMS instance URL',
        kind: 'text',
        required: true,
        placeholder: 'https://app-abc123def456.cms.optimizely.com',
        hint: 'The address you open the CMS at. Its scripts and preview come from this host.',
        pattern: null,
        defaultValue: null,
        defaultFrom: null,
      },
      application: {
        label: 'Application',
        kind: 'text',
        required: true,
        placeholder: 'cablecom-website',
        hint: 'The website in Settings → Applications this project builds. Created in Foundation if it does not exist.',
        pattern: '^[A-Za-z][A-Za-z0-9 _-]{1,99}$',
        defaultValue: null,
        defaultFrom: null,
      },
      typePrefix: {
        label: 'Content type prefix',
        kind: 'text',
        required: true,
        placeholder: 'Cablecom',
        hint: 'Content types and display templates are shared by every site on the instance. This project’s start with this prefix (CablecomHero), and it changes nothing else.',
        pattern: '^[A-Z][A-Za-z0-9]{1,19}$',
        defaultValue: null,
        defaultFrom: null,
      },
      languages: {
        label: 'Locales',
        kind: 'list',
        required: true,
        placeholder: 'en, es',
        hint: 'As Settings → Languages lists them.',
        pattern: null,
        defaultValue: 'en',
        defaultFrom: null,
      },
      hostingProject: {
        label: 'Vercel project for the head',
        kind: 'slug',
        required: true,
        placeholder: 'cablecom-website',
        hint: 'Lowercase letters, digits and dashes. Its address becomes a hostname of the application.',
        pattern: null,
        defaultValue: null,
        defaultFrom: 'name',
      },
    },
    // One instance hosts many applications: its URL, locales, API key and Graph keys are the
    // instance's; the application, its type prefix and its Vercel project are each project's.
    connection: {
      fields: ['cmsUrl', 'languages'],
      credentials: ['cms-api-client', 'graph-single-key', 'graph-hmac'],
    },
    credentials: {
      'cms-api-client': {
        system: 'Optimizely CMS REST API key',
        description:
          'In the CMS, Settings → API Keys → Create API Key. Copy the Client ID and Secret before closing the window; they are not shown again.',
        fields: [
          { key: 'clientId', label: 'Client ID', secret: false },
          { key: 'clientSecret', label: 'Secret', secret: true },
        ],
        uses: [],
        hintField: 'clientSecret',
        scope: (t) => `CMS REST API v1, ${hostOf(text(t, 'cmsUrl'))}`,
        check: (s) =>
          verifyCmsApiClient(cfg, {
            clientId: s.clientId ?? '',
            clientSecret: s.clientSecret ?? '',
          }),
      },
      'graph-single-key': {
        system: 'Optimizely Graph single key',
        description:
          'Settings → API Keys, the Render Content section: the single key reads published content.',
        fields: [{ key: 'singleKey', label: 'Single key', secret: true }],
        uses: [],
        hintField: 'singleKey',
        scope: () => 'Optimizely Graph, published content',
        check: (s) => verifyGraphSingleKey(cfg, { singleKey: s.singleKey ?? '' }),
      },
      'graph-hmac': {
        system: 'Optimizely Graph app key and secret',
        description:
          'Same page as the single key. Signed requests read draft content and run the Graph-side checks; optional until migration.',
        fields: [
          { key: 'appKey', label: 'App key', secret: false },
          { key: 'secret', label: 'Secret', secret: true },
        ],
        uses: [],
        hintField: 'secret',
        scope: () => 'Optimizely Graph, drafts (signed)',
        check: async (s) => verifyGraphHmac({ appKey: s.appKey ?? '', secret: s.secret ?? '' }),
      },
    },
    normalize: (t) => {
      const url = t.cmsUrl ? optimizelyCmsUrl(cfg, text(t, 'cmsUrl')) : null;
      return {
        ...t,
        ...(url instanceof URL ? { cmsUrl: url.origin } : {}),
        ...(t.application ? { application: text(t, 'application').trim() } : {}),
      };
    },
    describe: (t) => {
      const s = optimizelyTarget({ target: t });
      return {
        label: `${hostOf(s.cmsUrl)}, ${s.application}`,
        target: {
          collection: hostOf(s.cmsUrl),
          site: s.application,
          hosting: s.hostingProject ? `Vercel, ${s.hostingProject}` : null,
        },
      };
    },
    bindings: optimizelyBindings,
    context: (t) => {
      const s = optimizelyTarget({ target: t });
      return [
        `Optimizely CMS (SaaS) target: application "${s.application}" on ${hostOf(s.cmsUrl)} (${s.cmsUrl}); locales ${s.languages.join(', ')}. Content types and display templates this project creates start with "${s.typePrefix}".`,
        `Content types, display templates and Graph are shared by every application on the instance. This project owns only its application's content tree, the types and templates carrying its prefix, and its own media folder: ${optimizelyOwnedPaths(t).join('; ')}. Never change a type without the prefix, and never push with --force.`,
        `The CMS REST API is v1 on https://api.cms.optimizely.com (preview3 was retired on 1 August 2026). Delivery and preview read Optimizely Graph; the editing host is a hostname of the application with live preview on /preview.`,
      ];
    },
    toolCredential: (server) =>
      server === 'optimizely-cms'
        ? { credentialId: 'cms-api-client', token: clientToken }
        : server === 'optimizely-graph'
          ? {
              credentialId: 'graph-single-key',
              token: async (s) => ({
                token: s.singleKey ?? '',
                expiresAt: Date.now() + 10 * 60_000,
              }),
            }
          : undefined,
    knowledgeDir: fileURLToPath(new URL('./knowledge', import.meta.url)),
    // No starter until the template repository exists (entities.md, O3): a project that needs a
    // build repository is refused at intake rather than given Sitecore's.
    buildRecipe: { generate: [], build: 'build', readOnly: [] },
    // Platform checks (structural.*, graph.published, …) land with the optimizely-cms and
    // optimizely-graph tool servers; until then review records them as pending, never as passed.
    headEnv: async (t, _which, deps) => headVars(t, deps.credential),
    // The sandbox also runs `optimizely-cms-cli config push`, which signs in with the REST API
    // key. The head never needs that key, so it stays off the hosting project.
    buildEnv: async (t, deps) => {
      const head = await headVars(t, deps.credential);
      const client = await deps.credential('cms-api-client');
      const vars = [
        ...head.vars,
        { key: 'OPTIMIZELY_CMS_API_URL', value: cfg.apiUrl, sensitive: false },
      ];
      const missing = [...head.missing];
      if (client?.clientId && client.clientSecret) {
        vars.push(
          { key: 'OPTIMIZELY_CMS_CLIENT_ID', value: client.clientId, sensitive: true },
          { key: 'OPTIMIZELY_CMS_CLIENT_SECRET', value: client.clientSecret, sensitive: true },
        );
      } else missing.push('the CMS REST API key was not given: content types cannot be pushed');
      return { vars, missing };
    },
  };
}
