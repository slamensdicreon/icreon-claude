/**
 * A page template's field mapping, in a form the bulk import can run without an agent: each entry
 * says which item and field it fills (`component`: "page" for the page item, else the name of a
 * datasource item under the example page's Data folder) and where the value comes from on each
 * source page (`from`):
 *
 * - `title`, `description`: the page's <title> and meta description
 * - `h1`: the text of the page's first h1
 * - `path`: the page's path (`/resources/learn/what-is-payroll`)
 * - `css:<selector>`: the text of the first element it matches; `css:<selector> @html` its
 *   cleaned inner HTML (for Rich Text); `css:<selector> @<attribute>` an attribute (`@src` and
 *   `@href` as absolute URLs)
 * - `data:<Component>.<field>[.<key>...]`: from the layout data the page embeds (Next.js sites on
 *   Sitecore): the first component of that name, that field's value (`.src` or `.href` for an
 *   image or link field's URL)
 * - `same`: the example page's own value, the same on every page (a call to action's label);
 *   with `field: "*"` the whole datasource is copied as it is, child items included
 *
 * `as` says what the field stores: `text` (default), `html` (Rich Text), `image` (the value is an
 * image URL: uploaded to the template's mediaFolder, and the field gets the media item), `link`
 * (a URL, stored as a General Link). `optional: true` lets a page without the value through;
 * otherwise a page whose source has nothing there is an exception, for an agent.
 */
export interface MappingEntry {
  component: string;
  field: string;
  from: string;
  as?: 'text' | 'html' | 'image' | 'link';
  optional?: boolean;
}

export type Source =
  | { kind: 'title' | 'description' | 'path' | 'same' }
  | { kind: 'css'; selector: string; attr: string | null }
  | { kind: 'data'; component: string; field: string[] };

/** The source a `from` names, or the reason it isn't one the import can run. */
export function parseSource(from: unknown): Source | { error: string } {
  if (typeof from !== 'string' || !from.trim()) return { error: 'no source' };
  const f = from.trim();
  if (['title', 'description', 'path', 'same'].includes(f))
    return { kind: f as 'title' | 'description' | 'path' | 'same' };
  if (f === 'h1') return { kind: 'css', selector: 'h1', attr: null };
  const css = /^css:\s*(.+?)(?:\s+@([a-z][a-z0-9-]*))?$/i.exec(f);
  if (css) return { kind: 'css', selector: css[1]!.trim(), attr: css[2]?.toLowerCase() ?? null };
  const data = /^data:\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)$/.exec(f);
  if (data) return { kind: 'data', component: data[1]!, field: data[2]!.split('.') };
  return {
    error: `"${f}" isn't a source the import can read: use title, description, h1, path, same, css:<selector> (with @html or @<attribute>), or data:<Component>.<field>`,
  };
}

/** What's wrong with a mapping's entries, one line each; empty when the import can run it. */
export function mappingProblems(entries: unknown, mediaFolder?: unknown): string[] {
  if (!Array.isArray(entries) || !entries.length) return ['the mapping has no entries'];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of entries.entries()) {
    const e = (raw ?? {}) as Partial<MappingEntry>;
    const where = `entry ${i + 1}${e.component && e.field ? ` (${e.component}.${e.field})` : ''}`;
    if (typeof e.component !== 'string' || !e.component.trim())
      problems.push(`${where} names no component ("page", or a datasource item's name)`);
    if (typeof e.field !== 'string' || !e.field.trim()) problems.push(`${where} names no field`);
    const src = parseSource(e.from);
    if ('error' in src) problems.push(`${where}: ${src.error}`);
    if (e.as && !['text', 'html', 'image', 'link'].includes(e.as))
      problems.push(`${where}: as "${e.as}" isn't text, html, image or link`);
    if (e.field === '*' && e.from !== 'same')
      problems.push(`${where}: field "*" (the whole datasource) only goes with from "same"`);
    const key = `${e.component}/${e.field}`.toLowerCase();
    if (seen.has(key)) problems.push(`${where} fills a field another entry already fills`);
    seen.add(key);
  }
  if (
    entries.some((e) => (e as MappingEntry)?.as === 'image') &&
    (typeof mediaFolder !== 'string' || !mediaFolder.startsWith('/sitecore/media library/'))
  )
    problems.push(
      'image fields need mediaFolder: the media library folder their uploads go in (/sitecore/media library/Project/...)',
    );
  return problems;
}
