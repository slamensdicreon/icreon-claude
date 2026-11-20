/*
 * Words a Director will meet in the team's documents, each in one plain line. Cypher's plain
 * version of a document adds the terms that document uses; these cover the ones every project on
 * a platform meets: a shared list, plus the platform's own. Shown as a dotted underline with the
 * meaning on hover or focus.
 */
import { createContext, useContext } from 'react';

export interface Term {
  term: string;
  meaning: string;
  /** Matched as written only, for a word whose capitalised form means something else here. */
  caseSensitive?: boolean;
}

/** Terms every project meets, whatever it builds on. */
const SHARED: Term[] = [
  { term: 'parity', meaning: 'How closely the new site matches the old one, page by page.' },
  {
    term: 'Lighthouse',
    meaning:
      "Google's site check: it scores speed, accessibility, good practice and search readiness out of 100.",
  },
  {
    term: 'conformance',
    meaning: 'An automatic check that the work follows the agreed rules for the platform.',
  },
  { term: 'pull request', meaning: 'A proposed change to the code, reviewed before it is merged.' },
  { term: 'merge', meaning: 'Accepting a reviewed change into the main code.' },
  { term: 'deploy', meaning: 'Putting a new version of the site where people can open it.' },
  {
    term: 'headless',
    meaning:
      'A site whose content comes from the content system and whose pages are built separately.',
  },
  {
    term: 'CDN',
    meaning:
      'A network that serves images and video from servers near each visitor, so they load faster.',
  },
];

const SITECOREAI: Term[] = [
  {
    term: 'rendering',
    meaning:
      'A building block of a page, like a hero banner or a footer, that editors place and fill in.',
  },
  {
    term: 'datasource',
    meaning: 'The content item that holds the words and images one building block shows.',
  },
  {
    term: 'Page builder',
    meaning: 'Where editors put pages together in Sitecore by dropping building blocks onto them.',
  },
  {
    term: 'Experience Edge',
    meaning: "Sitecore's delivery service: it serves published content to the live site quickly.",
  },
  { term: 'Content SDK', meaning: "Sitecore's toolkit the new site is built with." },
  { term: 'placeholder', meaning: 'A slot on a page where building blocks can be placed.' },
  {
    term: 'template',
    meaning:
      'The pattern a kind of content follows: which fields it has and how they are filled in.',
  },
  {
    term: 'partial design',
    meaning: 'A reusable piece of page layout, like a header or footer, shared by many pages.',
  },
  {
    term: 'page design',
    meaning: 'A layout that combines partial designs; every page of a kind uses one.',
  },
  {
    term: 'insert options',
    meaning: 'Which kinds of pages or items an editor may create in a given place.',
  },
  { term: 'standard values', meaning: 'The default content a new item of a kind starts with.' },
  { term: 'SXA', meaning: "Sitecore's set of rules and building blocks for consistent sites." },
  {
    term: 'serialization',
    meaning:
      'Saving Sitecore items as files, so they can be versioned and moved between environments.',
  },
  { term: 'Media Library', meaning: 'Where Sitecore keeps images, videos and files.' },
];

const OPTIMIZELY: Term[] = [
  {
    term: 'Visual Builder',
    meaning: 'Where editors put pages together in Optimizely by arranging building blocks on them.',
  },
  {
    term: 'experience',
    meaning: 'A page editors compose freely in Visual Builder, out of sections.',
  },
  {
    term: 'section',
    meaning: 'A band of a page in Visual Builder that holds building blocks in rows and columns.',
  },
  {
    term: 'display template',
    meaning:
      'A look an editor picks for a building block, with its settings, such as layout or colour.',
  },
  {
    term: 'content type',
    meaning:
      'A kind of building block or page and the fields it has, defined in code and pushed to the CMS.',
  },
  {
    // Lowercase only: "Blueprint" is the project's own plan of what gets built.
    term: 'blueprint',
    meaning: 'A starting layout editors create new pages from in Visual Builder.',
    caseSensitive: true,
  },
  {
    term: 'shared block',
    meaning: 'Content many pages point at, like the header or footer: change it once, everywhere.',
  },
  {
    term: 'application',
    meaning: 'A website on the Optimizely instance, with its start page and its addresses.',
  },
  {
    term: 'Optimizely Graph',
    meaning: "Optimizely's delivery service: the live site reads published content from it.",
  },
  {
    term: 'live preview',
    meaning: 'The page as editors see it in Visual Builder, changing as they type.',
  },
  {
    term: 'preview token',
    meaning: 'A short-lived pass that lets the site show an editor content not yet published.',
  },
  {
    term: 'type prefix',
    meaning:
      "The start of every content type's name in this project: it keeps them apart from other sites' on a shared instance.",
  },
  { term: 'single key', meaning: 'The Optimizely Graph key that reads published content only.' },
  {
    term: 'app key',
    meaning: 'With its secret, the Optimizely Graph key that also reads drafts.',
  },
];

const BY_PLATFORM: Record<string, Term[]> = { sitecoreai: SITECOREAI, optimizely: OPTIMIZELY };

/**
 * The terms every document of a project defines: the platform's own (by the pack's id,
 * `project.platform?.id`) and the shared ones. An unknown platform gets the shared ones only.
 */
export const baseGlossary = (platformId: string | null | undefined): Term[] => [
  ...((platformId && BY_PLATFORM[platformId]) || []),
  ...SHARED,
];

/** The terms a document view defines: the base list plus the plain version's own. */
export const GlossaryContext = createContext<Term[]>([]);
export const useGlossary = () => useContext(GlossaryContext);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What finds a term in running text: whole words, a plural "s" allowed, any case unless it says. */
export const termPattern = (t: Term) =>
  new RegExp(`\\b${escapeRe(t.term)}s?\\b`, t.caseSensitive ? '' : 'i');

/**
 * Marks the first use of each term in an HTML fragment (outside code, links and headings) with an
 * <abbr> carrying its meaning. Works on sanitized HTML through the DOM, so meanings are attribute
 * values, never markup.
 */
export function glossHtml(html: string, terms: Term[]): string {
  if (!terms.length || typeof document === 'undefined') return html;
  const box = document.createElement('div');
  box.innerHTML = html;
  const seen = new Set<string>();
  const sorted = [...terms].sort((a, b) => b.term.length - a.term.length);
  const skip = (n: Node | null): boolean => {
    for (let p = n?.parentElement; p && p !== box; p = p.parentElement)
      if (/^(CODE|PRE|A|ABBR|H1|H2|H3|H4|H5|H6|SVG|BUTTON)$/i.test(p.tagName)) return true;
    return false;
  };
  for (const t of sorted) {
    const key = t.term.toLowerCase();
    if (seen.has(key)) continue;
    const re = termPattern(t);
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? '';
      const m = re.exec(text);
      if (!m || skip(node)) continue;
      const before = document.createTextNode(text.slice(0, m.index));
      const abbr = document.createElement('abbr');
      abbr.setAttribute('title', t.meaning);
      abbr.setAttribute('tabindex', '0');
      abbr.setAttribute('data-term', '');
      abbr.textContent = m[0];
      const after = document.createTextNode(text.slice(m.index + m[0].length));
      node.parentNode!.replaceChild(after, node);
      after.parentNode!.insertBefore(abbr, after);
      after.parentNode!.insertBefore(before, abbr);
      seen.add(key);
      break;
    }
  }
  return box.innerHTML;
}
