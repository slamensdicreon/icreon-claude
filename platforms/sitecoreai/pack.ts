import { fileURLToPath } from 'node:url';
import type { IntakeFacts } from '@lw/contracts';
import {
  sitecoreToken,
  verifyContextId,
  verifyEnvironmentClient,
  verifyOrganizationClient,
  type VerifyConfig,
} from '@lw/connectors';
import type { PlatformPack } from '../src/index';
import { sitecoreChecks } from './checks';
import { list, text, type TargetValues } from '../src/values';

/** The SitecoreAI pack's id, as projects record it at intake. */
export const SITECOREAI = 'sitecoreai';

/**
 * SitecoreAI: a CM environment reached through its Authoring and Management API, the Deploy API
 * for the organization, Experience Edge for delivery, and a Next.js head on Vercel.
 */

const CLIENT_FIELDS = [
  { key: 'clientId', label: 'Client ID', secret: false },
  { key: 'clientSecret', label: 'Client secret', secret: true },
];

export function hostOf(cmHost: string): string {
  try {
    return new URL(/^https?:\/\//.test(cmHost) ? cmHost : `https://${cmHost}`).host;
  } catch {
    return cmHost;
  }
}

/** SitecoreAI's target values, typed. */
export interface SitecoreTarget {
  cmHost: string;
  siteCollection: string;
  site: string;
  languages: string[];
  hostingProject: string | null;
}

export function sitecoreTarget(intake: Pick<IntakeFacts, 'target'>): SitecoreTarget {
  const t = intake.target;
  return {
    cmHost: text(t, 'cmHost'),
    siteCollection: text(t, 'siteCollection'),
    site: text(t, 'site'),
    languages: list(t, 'languages'),
    hostingProject: text(t, 'hostingProject') || null,
  };
}

/**
 * Scope placeholders. A collection can hold other teams' sites (a shared tenant), so `{project}`
 * and `{module}` name a folder of this site's own inside the collection's Project folders, never
 * the collection's folder itself.
 */
export function sitecoreBindings(t: TargetValues): Record<string, string> {
  const { siteCollection, site } = sitecoreTarget({ target: t });
  const own = `${siteCollection}/${site}`;
  return {
    sitePath: `/sitecore/content/${siteCollection}/${site}`,
    collection: siteCollection,
    project: own,
    module: own,
  };
}

/** The paths a project may write in. */
export function ownedPaths(t: TargetValues): string[] {
  const b = sitecoreBindings(t);
  return [
    b.sitePath!,
    `/sitecore/templates/Project/${b.project}`,
    `/sitecore/layout/Renderings/Project/${b.module}`,
    `/sitecore/media library/Project/${b.project}`,
  ];
}

export function createSitecoreAI(cfg: VerifyConfig): PlatformPack {
  const clientToken = async (secret: Record<string, string>) => {
    const r = await sitecoreToken(cfg, secret.clientId ?? '', secret.clientSecret ?? '');
    if (!('token' in r)) throw new Error(r.detail);
    return {
      token: r.token,
      expiresAt: r.expiresAt ? Date.parse(r.expiresAt) : Date.now() + 10 * 60_000,
    };
  };
  return {
    id: SITECOREAI,
    name: 'SitecoreAI',
    about: {
      vendor: 'Sitecore',
      category: 'Headless CMS, SaaS',
      description:
        'SXA sites marketers build in Page builder, delivered through Experience Edge, with a Next.js head on the Content SDK.',
    },
    fields: {
      cmHost: {
        label: 'CM host',
        kind: 'text',
        required: true,
        placeholder: 'xmc-cablecom-abc123.sitecorecloud.io',
        hint: 'From the environment’s Details tab.',
        pattern: null,
        defaultValue: null,
        defaultFrom: null,
      },
      siteCollection: {
        label: 'Site collection',
        kind: 'text',
        required: true,
        placeholder: 'cablecom',
        hint: null,
        pattern: '^.{1,100}$',
        defaultValue: null,
        defaultFrom: null,
      },
      site: {
        label: 'Site',
        kind: 'text',
        required: true,
        placeholder: 'cablecom',
        hint: null,
        pattern: '^.{1,100}$',
        defaultValue: null,
        defaultFrom: null,
      },
      languages: {
        label: 'Languages',
        kind: 'list',
        required: true,
        placeholder: 'en, es-US',
        hint: null,
        pattern: null,
        defaultValue: 'en',
        defaultFrom: null,
      },
      hostingProject: {
        label: 'Vercel project for the head',
        kind: 'slug',
        required: true,
        placeholder: 'cablecom-website',
        hint: 'Lowercase letters, digits and dashes. The editing secret is generated when the head is deployed.',
        pattern: null,
        defaultValue: null,
        defaultFrom: 'name',
      },
    },
    // One environment hosts many sites: its CM host, collection, languages, clients, Context IDs
    // and editing secret are the environment's; the site and its Vercel project are each project's.
    connection: {
      fields: ['cmHost', 'siteCollection', 'languages'],
      credentials: [
        'sitecore-environment',
        'sitecore-organization',
        'edge-preview',
        'edge-live',
        'editing-secret',
      ],
    },
    credentials: {
      'sitecore-environment': {
        system: 'SitecoreAI environment client',
        description:
          'In the Deploy app, create an environment automation client for this environment and paste its ID and secret.',
        fields: CLIENT_FIELDS,
        uses: ['cmHost'],
        hintField: 'clientSecret',
        scope: (t) => `Authoring API, ${hostOf(text(t, 'cmHost'))}`,
        check: (s, t) =>
          verifyEnvironmentClient(cfg, {
            cmHost: text(t, 'cmHost'),
            clientId: s.clientId ?? '',
            clientSecret: s.clientSecret ?? '',
          }),
      },
      'sitecore-organization': {
        system: 'SitecoreAI organization client',
        description: 'For the Deploy API; it reaches every environment in the organization.',
        fields: CLIENT_FIELDS,
        // Checked against the project's environment, found by its CM host.
        uses: ['cmHost'],
        hintField: 'clientSecret',
        scope: () => 'Deploy API, all environments',
        check: (s, t) =>
          verifyOrganizationClient(
            cfg,
            { clientId: s.clientId ?? '', clientSecret: s.clientSecret ?? '' },
            sitecoreTarget({ target: t }).cmHost,
          ),
      },
      'edge-preview': {
        system: 'Experience Edge, preview',
        description: 'The preview Context ID, from the environment’s Developer settings.',
        fields: [{ key: 'contextId', label: 'Preview Context ID', secret: true }],
        uses: [],
        hintField: 'contextId',
        scope: () => 'Context ID (preview)',
        check: (s) => verifyContextId(cfg, { contextId: s.contextId ?? '', label: 'preview' }),
      },
      // Only when the Deploy API can't provide it: the Director copies it from the Deploy app.
      'editing-secret': {
        system: 'SitecoreAI editing secret',
        description:
          'SITECORE_EDITING_SECRET from the Deploy app: the environment’s Developer settings, Preview. Only needed when the organization client can’t read it.',
        fields: [{ key: 'secret', label: 'Editing secret', secret: true }],
        uses: [],
        hintField: 'secret',
        scope: () => 'Editing secret, for the editing host',
        check: async (s) =>
          /^\S{16,}$/.test(s.secret ?? '')
            ? { ok: true, detail: 'Stored. The head uses it as SITECORE_EDITING_SECRET.' }
            : {
                ok: false,
                detail: 'That doesn’t look like an editing secret: copy the whole value.',
              },
      },
      'edge-live': {
        system: 'Experience Edge, live',
        description: 'The live Context ID, from the environment’s Developer settings.',
        fields: [{ key: 'contextId', label: 'Live Context ID', secret: true }],
        uses: [],
        hintField: 'contextId',
        scope: () => 'Context ID (live)',
        check: (s) => verifyContextId(cfg, { contextId: s.contextId ?? '', label: 'live' }),
      },
    },
    normalize: (t) => ({ ...t, ...(t.cmHost ? { cmHost: hostOf(text(t, 'cmHost')) } : {}) }),
    describe: (t) => {
      const s = sitecoreTarget({ target: t });
      return {
        label: `${s.cmHost}, ${s.siteCollection} / ${s.site}`,
        target: {
          collection: s.siteCollection,
          site: s.site,
          hosting: s.hostingProject ? `Vercel, ${s.hostingProject}` : null,
        },
      };
    },
    bindings: sitecoreBindings,
    context: (t) => {
      const s = sitecoreTarget({ target: t });
      return [
        `SitecoreAI target: site "${s.site}" in collection "${s.siteCollection}" on ${s.cmHost}, at /sitecore/content/${s.siteCollection}/${s.site}; languages ${s.languages.join(', ')}.`,
        `This project owns only these paths; other sites in the collection belong to other teams, so never change anything outside them: ${ownedPaths(t).join('; ')}.`,
      ];
    },
    toolCredential: (server) =>
      server === 'sitecore-authoring'
        ? { credentialId: 'sitecore-environment', token: clientToken }
        : server === 'sitecore-deploy'
          ? { credentialId: 'sitecore-organization', token: clientToken }
          : undefined,
    knowledgeDir: fileURLToPath(new URL('./knowledge', import.meta.url)),
    starter: { owner: 'Sitecore', repo: 'xmcloud-starter-js', appPath: 'examples/basic-nextjs' },
    // The starter generates .sitecore/ (sites, import maps, metadata) during its build, and its
    // type-check needs those files: generate first. Older starters have a plain `build` only.
    buildRecipe: {
      generate: ['sitecore-tools:generate-map', 'sitecore-tools:build'],
      build: 'next:build',
      readOnly: ['sitecore.json', 'nuget.config'],
    },
    checks: sitecoreChecks(cfg),
    // The Content SDK head (examples/basic-nextjs). Our Vercel project is the editing host and
    // the stable preview, so both targets read draft content: the preview Context ID. The live
    // Context ID belongs to the delivery host the client runs after handover.
    headEnv: async (t, _which, deps) => {
      const s = sitecoreTarget({ target: t });
      const vars = [
        { key: 'NEXT_PUBLIC_DEFAULT_SITE_NAME', value: s.site, sensitive: false },
        { key: 'NEXT_PUBLIC_DEFAULT_LANGUAGE', value: s.languages[0] ?? 'en', sensitive: false },
        // Draft content renders per request: edits show at once, and its signed media links
        // never sit in a cached page past their expiry.
        { key: 'SITECORE_RENDER_ON_REQUEST', value: 'true', sensitive: false },
      ];
      const missing: string[] = [];
      const preview = await deps.credential('edge-preview');
      if (preview?.contextId) {
        vars.push(
          { key: 'SITECORE_EDGE_CONTEXT_ID', value: preview.contextId, sensitive: true },
          // Read by the browser by design (client-side Edge calls).
          {
            key: 'NEXT_PUBLIC_SITECORE_EDGE_CONTEXT_ID',
            value: preview.contextId,
            sensitive: false,
          },
        );
      } else {
        missing.push('the preview Context ID (Experience Edge, preview) was not given');
      }
      // The one the Director stored wins; otherwise the Deploy API's.
      const stored = (await deps.credential('editing-secret'))?.secret;
      const secret = stored ? { secret: stored } : await deps.editingSecret();
      if ('secret' in secret)
        vars.push({ key: 'SITECORE_EDITING_SECRET', value: secret.secret, sensitive: true });
      else missing.push(`the editing secret: ${secret.problem}`);
      return { vars, missing };
    },
  };
}
