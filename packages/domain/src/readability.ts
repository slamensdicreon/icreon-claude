/*
 * Is a document's opening readable by the Director? The Workbench shows documents to a reader who
 * isn't technical, so a Markdown document should open with a few plain sentences before the detail.
 * This looks only at that opening (the text before the second heading, or the first 160 words) and
 * names what makes it hard: long sentences, file paths, code, identifiers, version strings, ids.
 * It never refuses a save; the notes go back to the author, who can save a plainer version.
 */

export interface Readability {
  ok: boolean;
  notes: string[];
}

const PATH =
  /(?:^|[\s(])[\w./-]+\.(?:ts|tsx|js|jsx|json|ya?ml|cs|md|css|scss|html|config|lock)\b/gi;
const CODE = /`[^`]+`/g;
const IDENT = /\b[a-z]+[A-Z][A-Za-z]+\b|\b[A-Z][a-z]+[A-Z][A-Za-z]+\b/g;
const VERSION = /\bv?\d+\.\d+(?:\.\d+)?\b/g;
const ID = /\b[A-Z]{1,4}-\d{1,4}\b/g;

/** The opening: everything before the second heading, at most 160 words. */
export function openingOf(markdown: string): string {
  const lines = markdown.split('\n');
  let headings = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      headings++;
      if (headings > 1 || (headings === 1 && kept.join(' ').trim().split(/\s+/).length > 40)) break;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').split(/\s+/).filter(Boolean).slice(0, 160).join(' ');
}

export function readabilityOf(content: string, format: 'markdown' | 'json'): Readability {
  if (format !== 'markdown') return { ok: true, notes: [] };
  const opening = openingOf(content);
  const notes: string[] = [];
  const words = opening.split(/\s+/).filter(Boolean);
  if (words.length < 12)
    notes.push(
      'It opens with no plain summary: start with two or three sentences for the Director.',
    );
  const sentences = opening
    .split(/[.!?](?:\s|$)/)
    .map((x) => x.trim())
    .filter((x) => x.split(/\s+/).length > 2);
  const longest = Math.max(0, ...sentences.map((x) => x.split(/\s+/).length));
  if (longest > 32)
    notes.push(`A sentence in the opening runs ${longest} words: keep them under twenty-five.`);
  const count = (re: RegExp) => opening.match(re)?.length ?? 0;
  const technical = count(PATH) + count(CODE) + count(IDENT) + count(VERSION) + count(ID);
  if (technical > 2)
    notes.push(
      `The opening carries ${technical} technical terms (file names, code, identifiers, versions or ids): say what they mean for the site, the editors or the schedule instead, and keep them for the detail below.`,
    );
  return { ok: notes.length === 0, notes };
}
