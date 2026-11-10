/**
 * A page's content as its CMS delivered it, when the page embeds its layout data. Next.js sites on
 * Sitecore (SitecoreAI, XM Cloud, JSS) write every component's fields into the HTML: in the App
 * Router's flight payload (`self.__next_f.push`) or the Pages Router's `__NEXT_DATA__`. That
 * includes content the page renders only in the browser (carousels, tabs, team lists), which a
 * text snapshot never sees, and link targets a snapshot shows only as button text.
 */
export interface LayoutComponent {
  name: string;
  dataSource: string | null;
  fields: unknown;
  /**
   * False when the layout service couldn't fill it (`isContentResolved: false`): its rendering's
   * Component Query failed or its datasource didn't resolve. Absent when it resolved.
   */
  contentResolved?: false;
}

/** The page's components in order, with their datasource and fields; none when it embeds no layout data. */
export function layoutData(html: string): LayoutComponent[] {
  const flight = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]!) as string;
      } catch {
        return '';
      }
    })
    .join('');
  if (flight.includes('"componentName"')) return fromText(flight);
  const next = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (next) {
    try {
      const out: LayoutComponent[] = [];
      walk(JSON.parse(next), out);
      return out;
    } catch {
      /* not JSON: no layout data */
    }
  }
  return [];
}

/** Components in a JSON text, each read once (a head may also serialize an error boundary per component, without fields). */
function fromText(text: string): LayoutComponent[] {
  const byUid = [...text.matchAll(/"uid":"([0-9a-f-]{36})","componentName":"([A-Za-z0-9_-]+)"/g)];
  const seen = new Set<string>();
  const found = byUid.length
    ? byUid
        .filter((m) => !seen.has(m[1]!) && !!seen.add(m[1]!))
        .map((m) => ({ name: m[2]!, index: m.index! }))
    : [...text.matchAll(/"componentName":"([A-Za-z0-9_-]+)"/g)].map((m) => ({
        name: m[1]!,
        index: m.index!,
      }));
  return found.map(({ name, index }) => {
    const nextComponent = text.indexOf(
      '"componentName":',
      text.indexOf('"componentName":', index) + 1,
    );
    const end = nextComponent < 0 ? text.length : nextComponent;
    const ds = /"dataSource":"([^"]*)"/.exec(text.slice(index, end));
    const unresolved = /"isContentResolved":false/.test(text.slice(index, end));
    const at = text.indexOf('"fields":', index);
    let fields: unknown = null;
    if (at >= 0 && at < end) {
      const obj = balanced(text, at + '"fields":'.length);
      try {
        fields = obj ? compact(JSON.parse(obj)) : null;
      } catch {
        fields = null;
      }
    }
    return {
      name,
      dataSource: ds?.[1] || null,
      fields,
      ...(unresolved ? { contentResolved: false as const } : {}),
    };
  });
}

function walk(v: unknown, out: LayoutComponent[]): void {
  if (Array.isArray(v)) return v.forEach((x) => walk(x, out));
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  if (typeof o.componentName === 'string') {
    out.push({
      name: o.componentName,
      dataSource: typeof o.dataSource === 'string' && o.dataSource ? o.dataSource : null,
      fields: o.fields === undefined ? null : compact(o.fields),
      ...(o.isContentResolved === false ? { contentResolved: false as const } : {}),
    });
    // Nested components sit in its placeholders.
    if (o.placeholders) walk(o.placeholders, out);
    return;
  }
  for (const x of Object.values(o)) walk(x, out);
}

/** Field values without the editing chrome: text, rich text, images and links as their values, child items as name and fields. */
export function compact(v: unknown, depth = 0): unknown {
  if (depth > 12) return '…';
  if (Array.isArray(v)) return v.map((x) => compact(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => k !== 'editable' && k !== 'metadata');
  if (keys.length === 1 && keys[0] === 'value') return valueOf(o.value, depth);
  if (keys.length === 1 && keys[0] === 'jsonValue') return compact(o.jsonValue, depth + 1);
  if ('fields' in o && ('name' in o || 'displayName' in o)) {
    return {
      name: o.displayName ?? o.name,
      fields: compact(o.fields, depth + 1),
    };
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = compact(o[k], depth + 1);
  return out;
}

const KEPT = ['src', 'alt', 'width', 'height', 'href', 'text', 'target', 'anchor', 'querystring'];

function valueOf(v: unknown, depth: number): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const o = v as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const k of KEPT) if (o[k] !== undefined && o[k] !== '') kept[k] = o[k];
  return Object.keys(kept).length ? kept : compact(o, depth + 1);
}

function balanced(s: string, from: number): string | null {
  if (s[from] !== '{' && s[from] !== '[') return null;
  const open = s[from];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return s.slice(from, i + 1);
  }
  return null;
}
