/*
 * Agents write route maps as flowcharts, and a route is a path: `H[/ Home] --> A[/about]`. In
 * mermaid `[/` opens a parallelogram that has to close with `/]` or `\]`, so an unquoted path
 * label fails the whole diagram. Quoting the label keeps the text and makes it a plain box.
 */

const FLOWCHART = /^\s*(?:%%[^\n]*\n\s*)*(?:graph|flowchart)\b/;

// A node with a square-bracket label that isn't quoted and has no brackets inside: `id[label]`.
const SQUARE = /(\b[\w-]+)\[(?!\[|\()([^\]"\n[]*)\](?!\])/g;

/** The diagram with path-like labels quoted, or the same text when there is nothing to repair. */
export function quotePathLabels(src: string): string {
  if (!FLOWCHART.test(src)) return src;
  return src.replace(SQUARE, (whole, id: string, label: string) => {
    const text = label.trim();
    const starts = text.startsWith('/') || text.startsWith('\\');
    // `[/x/]`, `[/x\]`, `[\x\]` and `[\x/]` are shapes on purpose; leave them alone.
    const ends = text.length > 1 && (text.endsWith('/') || text.endsWith('\\'));
    if (!starts || ends) return whole;
    return `${id}["${label}"]`;
  });
}
