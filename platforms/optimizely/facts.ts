import type { FactDraft } from '@lw/contracts';

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** A path below the project's own root (`/content/<application>/about` is `/about`), or null. */
const below = (path: string, root: string | undefined) => {
  if (!root) return null;
  const p = path.toLowerCase();
  const r = root.toLowerCase().replace(/\/$/, '');
  return p === r ? '/' : p.startsWith(`${r}/`) ? path.slice(r.length) : null;
};

/**
 * What a call on the Optimizely tool servers made, as facts later tasks look up: the application,
 * a page by its route, a shared block by its name, a media item by where it came from, the
 * content model once pushed. Read from the call's own result, so it records what the CMS
 * answered, not what the agent meant to do.
 */
export function optimizelyFacts(
  call: { server: string; op: string; args: Record<string, unknown> },
  body: unknown,
  bindings: Record<string, string>,
): FactDraft[] {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const a = call.args;

  if (call.server === 'sandbox' && call.op === 'exec.optimizely-cli') {
    if (b.sent !== true || !Array.isArray(b.contentTypes)) return [];
    const types = (b.contentTypes as unknown[]).map(String);
    const templates = Array.isArray(b.displayTemplates) ? b.displayTemplates.map(String) : [];
    return [
      {
        kind: 'content-model',
        key: 'pushed',
        value: {
          contentTypes: types.join(', '),
          displayTemplates: templates.join(', '),
          count: types.length,
        },
        summary: `${types.length} content types and ${templates.length} display templates are in the CMS`,
      },
    ];
  }
  if (call.server !== 'optimizely-cms') return [];

  /** A page or shared block the call wrote, keyed the way the next task will ask for it. */
  const item = (status: string | null): FactDraft[] => {
    const path = text(b.path);
    const key = text(b.key);
    if (!path || !key) return [];
    const value = {
      path,
      key,
      ref: text(b.ref) ?? `cms://content/${key}`,
      contentType: text(b.contentType) ?? text(a.contentType),
      status,
    };
    const route = below(path, bindings.contentRoot);
    if (route)
      return [
        {
          kind: 'page',
          key: route,
          value,
          summary: `Page ${route} is ${path}${status ? ` (${status})` : ''}`,
        },
      ];
    const shared = below(path, bindings.sharedRoot);
    if (shared && shared !== '/') {
      const name = shared.replace(/^\//, '');
      return [
        {
          kind: 'shared-block',
          key: name,
          value,
          summary: `Shared block ${name} is ${path}${status ? ` (${status})` : ''}`,
        },
      ];
    }
    return [{ kind: 'item', key: path, value, summary: `${path} is ${key}` }];
  };

  switch (call.op) {
    case 'application.create': {
      const key = text(b.key);
      const start = b.startPage as { key?: unknown } | undefined;
      if (!key) return [];
      return [
        {
          kind: 'application',
          key,
          value: {
            key,
            startPage: bindings.contentRoot ?? null,
            startPageKey: text(start?.key),
            assetsRoot: text(b.assetsRoot),
          },
          summary: `Application ${key}; its start page is ${bindings.contentRoot ?? 'its entry point'}`,
        },
      ];
    }
    case 'hostname.add': {
      const host = text(a.host);
      const hosts = (b.hosts as { host?: unknown; type?: unknown }[] | undefined) ?? [];
      if (!host || !hosts.some((h) => text(h.host)?.toLowerCase() === host.toLowerCase()))
        return [];
      return [
        {
          kind: 'host',
          key: 'primary',
          value: { host, url: `https://${host}` },
          summary: `The application answers on https://${host}`,
        },
      ];
    }
    case 'content.create':
    case 'content.update':
      return item(text(b.status) ?? 'draft');
    case 'content.publish':
      return item('published');
    case 'composition.write': {
      const path = text(b.path);
      const sections = Array.isArray(b.sections)
        ? (b.sections as { name?: unknown; contentType?: unknown }[])
        : [];
      if (!path || !sections.length) return [];
      const route = below(path, bindings.contentRoot) ?? path;
      const names = sections.map((s) => text(s.contentType) ?? '?');
      return [
        {
          kind: 'layout',
          key: route,
          value: { components: names.join(', '), count: sections.length },
          summary: `${route} has ${names.join(', ')}`,
        },
      ];
    }
    case 'media.upload': {
      const path = text(b.path);
      const key = text(b.key);
      if (!path || !key) return [];
      // Found again by where it came from: the next task has the source's URL, not our path.
      const from = text(a.sourceUrl) ?? text(a.ref) ?? path;
      return [
        {
          kind: 'media',
          key: from,
          value: { path, key, ref: text(b.ref) ?? `cms://content/${key}`, alt: text(b.alt) },
          summary: `Media ${from} at ${path}`,
        },
      ];
    }
    case 'blueprint.create': {
      const name = text(b.name);
      const key = text(b.key);
      if (!name || !key) return [];
      return [
        {
          kind: 'blueprint',
          key: name,
          value: { key, contentType: text(b.contentType) },
          summary: `Blueprint ${name} for ${text(b.contentType) ?? 'an experience type'}`,
        },
      ];
    }
  }
  return [];
}
