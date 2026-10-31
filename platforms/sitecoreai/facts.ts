import type { FactDraft } from '@lw/contracts';

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const under = (path: string, root: string) => {
  const p = path.toLowerCase();
  const r = root.toLowerCase().replace(/\/$/, '');
  return p === r || p.startsWith(`${r}/`) ? path.slice(r.length) || '/' : null;
};

/**
 * What a SitecoreAI authoring call made, as facts later tasks look up: a rendering's ID, a
 * template's path, a page's item, a datasource, a media item. Read from the call's own result,
 * so it records what Sitecore answered, not what the agent meant to do.
 */
export function sitecoreFacts(
  call: { server: string; op: string; args: Record<string, unknown> },
  body: unknown,
  bindings: Record<string, string>,
): FactDraft[] {
  if (call.server !== 'sitecore-authoring') return [];
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const a = call.args;
  switch (call.op) {
    case 'rendering.create': {
      const id = text(b.itemId);
      const path = text(b.path);
      const name = text(a.name);
      if (!id || !path || !name) return [];
      const component = text(a.componentName);
      return [
        {
          kind: 'rendering',
          key: name,
          value: {
            id,
            path,
            componentName: component,
            datasourceTemplate: text(a.datasourceTemplatePath),
            datasourceLocation: text(a.datasourceLocation),
          },
          summary: `Rendering ${name}${component ? ` (${component})` : ''} is ${id}`,
        },
      ];
    }
    case 'template.create': {
      const name = text(a.name);
      const parent = text(a.parentPath);
      if (!name || !parent) return [];
      const path = `${parent.replace(/\/$/, '')}/${name}`;
      const nodes = (b.ownFields as { nodes?: { name?: string }[] } | undefined)?.nodes ?? [];
      const fields = nodes.map((n) => n.name).filter(Boolean);
      return [
        {
          kind: 'template',
          key: name,
          value: { path, fields: fields.join(', ') || null },
          summary: `Template ${name} at ${path}`,
        },
      ];
    }
    case 'item.create': {
      const id = text(b.itemId);
      const path = text(b.path);
      if (!id || !path) return [];
      const value = { id, path, template: text(a.templatePath) ?? text(a.templateId) };
      const site = bindings.sitePath;
      const route = site ? under(path, `${site}/Home`) : null;
      if (route) return [{ kind: 'page', key: route, value, summary: `Page ${route} is ${id}` }];
      for (const [root, kind] of [
        ['Data', 'datasource'],
        ['Presentation', 'presentation'],
        ['Settings', 'setting'],
      ] as const) {
        const rest = site ? under(path, `${site}/${root}`) : null;
        if (rest && rest !== '/') {
          const key = rest.replace(/^\//, '');
          return [{ kind, key, value, summary: `${path} is ${id}` }];
        }
      }
      return [{ kind: 'item', key: path, value, summary: `${path} is ${id}` }];
    }
    case 'layout.compose': {
      const path = text(a.path);
      const list = Array.isArray(a.renderings)
        ? (a.renderings as { rendering?: unknown; placeholder?: unknown }[])
        : null;
      if (!path || !list?.length) return [];
      // A rendering given by path reads as its name; one given by ID stays the ID.
      const names = list.map((r) => (text(r.rendering) ?? '?').split('/').pop()!);
      const site = bindings.sitePath;
      const route = (site ? under(path, `${site}/Home`) : null) ?? path;
      return [
        {
          kind: 'layout',
          key: route,
          value: {
            components: names.join(', '),
            placeholders: [...new Set(list.map((r) => text(r.placeholder) ?? '?'))].join(', '),
            count: list.length,
          },
          summary: `${route} has ${names.join(', ')}`,
        },
      ];
    }
    case 'media.upload': {
      const path = text(b.itemPath);
      if (!path) return [];
      const key = text(a.sourceUrl) ?? text(a.fileName) ?? path;
      return [
        {
          kind: 'media',
          key,
          value: { path, id: text(b.itemId), alt: text(b.alt) },
          summary: `Media ${key} at ${path}`,
        },
      ];
    }
  }
  return [];
}
