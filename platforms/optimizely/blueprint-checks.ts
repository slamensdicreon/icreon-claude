import type { CheckResult, PlatformCheck, PlatformCheckContext } from '../src/index';
import { optimizelyTarget } from './pack';

/**
 * Gate 1's model contract on Optimizely, as the Solution Architect's prompt sets it: every
 * inventoried page placed on a page type, every component specified the way its builder needs it
 * (content type key with the project's prefix, properties with their types, composition
 * behaviour, display templates with one default, limits on child items), the shared blocks
 * marked, and a pilot slice chosen where the plan proves one first. It reads the Blueprint and
 * the page inventory only: nothing is in the CMS yet.
 */

type Item = NonNullable<PlatformCheckContext['blueprint']>['collections'][string][number];

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const fail = (problems: string[]): CheckResult => ({
  status: 'fail',
  detail: `${problems.slice(0, 8).join('; ')}${problems.length > 8 ? `; and ${problems.length - 8} more` : ''}.`,
});
const pending = (detail: string): CheckResult => ({ status: 'pending', detail });

/** The property types the SDK's content types take. */
const PROPERTY_TYPES = [
  'string',
  'richText',
  'url',
  'link',
  'contentReference',
  'content',
  'component',
  'array',
  'boolean',
  'integer',
  'float',
  'dateTime',
  'json',
  'binary',
];

/** The composition behaviours a component's contract names. */
const ADDABLE = ['section', 'element', 'both'];

const dropped = (i: Item) => ['drop', 'dropped', 'out-of-scope'].includes(i.status ?? '');
/** An item that ships as part of another gets no contract of its own. */
const merged = (i: Item) => i.status === 'merge';

const pathOf = (v: unknown) => String(v ?? '').replace(/\/$/, '') || '/';
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const named = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function blueprintChecks(): Record<string, PlatformCheck> {
  return {
    'blueprint.coverage': async (ctx) => {
      const bp = ctx.blueprint;
      if (!bp?.collections) return fail(['No Blueprint has been written']);
      const { typePrefix } = optimizelyTarget({ target: ctx.target });
      if (!typePrefix)
        return pending('The project records no content type prefix to check the keys against.');
      const inv = (await ctx.document('page-inventory')) as {
        pages?: { path?: string; url?: string }[];
        crawl?: { pagesFound?: number; pagesInventoried?: number; partial?: boolean };
        siteAudit?: { pagesFound?: number; pages?: unknown[] };
      } | null;
      const all = (c: string) => bp.collections[c] ?? [];
      const kept = (c: string) => all(c).filter((i) => !dropped(i));
      const problems: string[] = [];

      // Keys are shared by every site on the instance: each carries the prefix, and no two items
      // of this Blueprint claim the same one.
      const owners = new Map<string, string>();
      const keyProblems = (
        owner: string,
        say: { none: string; its: string },
        key: unknown,
        own = true,
      ) => {
        if (!named(key)) {
          problems.push(
            `${say.none} (${typePrefix} and its name in PascalCase, such as ${typePrefix}Hero)`,
          );
          return;
        }
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key))
          problems.push(
            `${say.its} "${key}" is not a key the CMS takes (letters, digits and underscores)`,
          );
        else if (!key.startsWith(typePrefix) || key === typePrefix)
          problems.push(
            `${say.its} ${key} doesn't start with the project's prefix ${typePrefix}: keys are shared by every site on the instance`,
          );
        if (!own) return;
        const other = owners.get(key.toLowerCase());
        if (other && other !== owner)
          problems.push(`${other} and ${owner} both use the key ${key}`);
        else owners.set(key.toLowerCase(), owner);
      };
      let typesNamed = false;
      const propertyProblems = (owner: string, properties: unknown[]) => {
        for (const raw of properties) {
          const p = record(raw);
          if (!p || !named(p.name)) {
            problems.push(`${owner} has a property with no name`);
            continue;
          }
          if (!named(p.type)) problems.push(`${owner}'s property ${p.name} has no type`);
          else if (!PROPERTY_TYPES.includes(p.type)) {
            problems.push(
              `${owner}'s property ${p.name} has the type "${p.type}", which is not an Optimizely property type${typesNamed ? '' : ` (${PROPERTY_TYPES.join(', ')})`}`,
            );
            typesNamed = true;
          } else if (
            ['content', 'contentReference'].includes(p.type) &&
            !list(p.allowedTypes).length &&
            !list(p.restrictedTypes).length &&
            !named(p.contentType)
          )
            problems.push(
              `${owner}'s property ${p.name} (${p.type}) names no allowedTypes: the push fails without them`,
            );
        }
      };

      // Pages: every inventoried page mapped or dropped, every kept one on a page type.
      const pages = all('pages');
      const placed = new Set(pages.map((p) => pathOf(p.attrs?.path)));
      for (const p of inv?.pages ?? []) {
        let path = p.path ?? '';
        try {
          if (!path && p.url) path = new URL(p.url).pathname;
        } catch {
          /* as given */
        }
        if (!placed.has(pathOf(path)))
          problems.push(`page ${pathOf(path)} is neither mapped nor dropped`);
      }
      const templates = kept('templates').filter((t) => !merged(t));
      const templateKeys = new Set(templates.map((t) => t.key));
      const ownPages = kept('pages').filter((p) => !merged(p));
      for (const p of ownPages) {
        const t = p.attrs?.template;
        if (!named(p.attrs?.path)) problems.push(`page ${p.key} has no path (attrs.path)`);
        if (!named(t)) problems.push(`page ${p.key} is on no page type (attrs.template)`);
        else if (!templateKeys.has(t)) problems.push(`page ${p.key} uses unknown template ${t}`);
      }
      if (ownPages.length && !ownPages.some((p) => pathOf(p.attrs?.path) === '/'))
        problems.push(
          'no home page (a page with attrs.path "/"): the application is created on it, as its start page',
        );
      // A sample isn't the site: when Discovery read only part of it, the Blueprint says what it
      // covers and how the rest is handled. The homepage demo's site audit is that decision.
      const found = Number(inv?.crawl?.pagesFound ?? 0);
      const listed = Number(inv?.crawl?.pagesInventoried ?? inv?.pages?.length ?? 0);
      const sampled = Boolean(inv?.crawl?.partial) || (found > 0 && found > listed);
      const scope = (bp as { scope?: { pagesFound?: number; approach?: string } }).scope;
      const audit = inv?.siteAudit;
      const audited =
        audit &&
        (Number(audit.pagesFound) > 0 || (Array.isArray(audit.pages) && audit.pages.length))
          ? Number(audit.pagesFound) || found || audit.pages?.length || 0
          : 0;
      if (sampled && !scope?.approach && !audited)
        problems.push(
          `the inventory covers ${listed} of ${found || 'more'} pages found: write the Blueprint's \`scope\` (pagesFound, and how the other pages are handled: built from these page types later, or left out, and why) so the Director sees it at Gate 1`,
        );

      // Page types: each with its key and whether editors compose it or it is a fixed form.
      const components = kept('components').filter((c) => !merged(c));
      const componentKeys = new Set(components.map((c) => c.key));
      if (!templates.length) problems.push('no templates (the page types)');
      for (const t of templates) {
        const a = t.attrs ?? {};
        const owner = `template ${t.key}`;
        keyProblems(
          owner,
          { none: `${owner} has no content type key`, its: `${owner}'s content type key` },
          a.contentType,
        );
        if (!['experience', 'page'].includes(String(a.kind ?? '')))
          problems.push(
            `${owner} has no kind (attrs.kind: "experience", composed in Visual Builder, or "page", a fixed form)`,
          );
        if (Array.isArray(a.properties)) propertyProblems(owner, a.properties);
        for (const k of list(a.defaultSections))
          if (typeof k === 'string' && !componentKeys.has(k))
            problems.push(
              `${owner}'s default section ${k} is not a component the Blueprint builds`,
            );
        for (const s of list(a.shell)) {
          const k = record(s)?.component;
          if (typeof k === 'string' && !componentKeys.has(k))
            problems.push(
              `${owner}'s shell names ${k}, which is not a component the Blueprint builds`,
            );
        }
      }

      // Components: the contract each builder works from.
      if (!components.length) problems.push('no components');
      const templateOwners = new Map<string, string>();
      for (const c of components) {
        const a = c.attrs ?? {};
        keyProblems(
          c.key,
          { none: `${c.key} has no content type key`, its: `${c.key}'s content type key` },
          a.contentType,
        );
        const behaviour = String(a.behaviour ?? a.behavior ?? '');
        // An item that only lives inside another component is never added to a page by itself.
        const inline = a.inline === true;
        if (!inline && ![...ADDABLE, 'shell'].includes(behaviour))
          problems.push(
            `${c.key} has no composition behaviour (attrs.behaviour: "section", "element", "both", or "shell" for a shared block the page refers to)`,
          );
        const children = record(a.children);
        const properties = list(a.properties);
        if (!properties.length && !children) problems.push(`${c.key} has no properties`);
        propertyProblems(c.key, properties);
        if (children) {
          if (typeof children.max !== 'number')
            problems.push(`${c.key}'s child items have no limit (children.max)`);
          keyProblems(
            c.key,
            {
              none: `${c.key}'s child items have no content type key (children.contentType)`,
              its: `${c.key}'s child type`,
            },
            children.contentType,
            false,
          );
          if (Array.isArray(children.properties))
            propertyProblems(`${c.key}'s child items`, children.properties);
        }
        const displayTemplates = list(a.displayTemplates).map((t) => record(t) ?? {});
        if (ADDABLE.includes(behaviour) && !displayTemplates.length)
          problems.push(
            `${c.key} has no display template: a component editors add needs a default of its own (attrs.displayTemplates, one marked default: true), or it takes whatever default the instance already holds`,
          );
        if (displayTemplates.length) {
          const defaults = displayTemplates.filter(
            (t) => t.default === true || t.isDefault === true,
          ).length;
          if (defaults !== 1)
            problems.push(
              `${c.key} has ${defaults} default display templates: exactly one is marked default: true`,
            );
          for (const t of displayTemplates) {
            if (!named(t.key)) {
              problems.push(`${c.key} has a display template with no key`);
              continue;
            }
            if (!t.key.startsWith(typePrefix) || t.key === typePrefix)
              problems.push(
                `${c.key}'s display template ${t.key} doesn't start with the project's prefix ${typePrefix}`,
              );
            const other = templateOwners.get(t.key.toLowerCase());
            if (other && other !== c.key)
              problems.push(`${other} and ${c.key} both define the display template ${t.key}`);
            else templateOwners.set(t.key.toLowerCase(), c.key);
          }
        }
        if (behaviour === 'shell' && a.shared !== true)
          problems.push(
            `${c.key} is a shared block (behaviour "shell") not marked shared: true: shared blocks are built first, and the page types refer to their types`,
          );
      }
      if (components.length && !components.some((c) => c.attrs?.shared === true))
        problems.push(
          'no component is marked shared: true: mark the header, the footer and the navigation, the blocks every page shows',
        );

      // The pilot slice, where the plan proves one before the rest is built: its sections are
      // what the pilot experience is composed from.
      if (ctx.plan?.pilot !== false && components.length) {
        const pilots = components.filter((c) => c.pilot);
        if (!pilots.length)
          problems.push(
            'no pilot components: mark 2 to 4 representative components the home page shows pilot: true',
          );
        else if (
          !pilots.some((c) => ADDABLE.includes(String(c.attrs?.behaviour ?? c.attrs?.behavior)))
        )
          problems.push(
            'no pilot component can be added to a page (behaviour "section", "element" or "both"): the pilot experience is composed from them',
          );
      }

      // A media entry names one file: a folder leaves the media migrator guessing.
      const media = kept('media').map((m) => ({ key: m.key, url: String(m.attrs?.url ?? '') }));
      for (const m of media) {
        if (!/^https?:\/\//.test(m.url)) continue;
        const bare = m.url.replace(/[?#].*$/, '');
        const folder =
          bare.endsWith('/') ||
          media.some((o) => o !== m && o.url.replace(/[?#].*$/, '').startsWith(`${bare}/`));
        if (folder)
          problems.push(
            `media ${m.key}'s url is a folder (${m.url}): give the full URL of the one file it is`,
          );
      }

      if (problems.length) return fail(problems);
      if (!inv?.pages?.length)
        return pending(
          `${components.length} components and ${templates.length} page types, each with a model contract; no page inventory could be read, so its pages weren't compared with the Blueprint's.`,
        );
      const kinds = kept('pages').length;
      return pass(
        `${kinds} ${kinds === 1 ? 'page' : 'pages'}, ${templates.length} page ${templates.length === 1 ? 'type' : 'types'} and ${components.length} components, each with a model contract: keys with the prefix ${typePrefix}, typed properties, a composition behaviour and display templates.${scope?.approach ? ` Covers ${kinds} of ${scope.pagesFound ?? found} pages found: ${scope.approach}` : sampled && audited ? ` Covers ${kinds} of ${audited} pages found; the site audit counts the rest.` : ''}`,
      );
    },
  };
}
