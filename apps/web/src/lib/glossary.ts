/*
 * Words a Director will meet in the team's documents, each in one plain line. Cypher's plain
 * version of a document adds the terms that document uses; these cover the ones every Sitecore
 * migration does. Shown as a dotted underline with the meaning on hover or focus.
 */
import { createContext, useContext } from 'react';

export interface Term {
  term: string;
  meaning: string;
}

export const BASE_GLOSSARY: Term[] = [
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
  { term: 'parity', meaning: 'How closely the new site matches the old one, page by page.' },
  {
    term: 'Lighthouse',
    meaning:
      "Google's site check: it scores speed, accessibility, good practice and search readiness out of 100.",
  },
  {
    term: 'conformance',
    meaning: 'An automatic check that the work follows the agreed Sitecore rules.',
  },
  { term: 'pull request', meaning: 'A proposed change to the code, reviewed before it is merged.' },
  { term: 'merge', meaning: 'Accepting a reviewed change into the main code.' },
  { term: 'deploy', meaning: 'Putting a new version of the site where people can open it.' },
  {
    term: 'headless',
    meaning:
      'A site whose content comes from the content system and whose pages are built separately.',
  },
  { term: 'Media Library', meaning: 'Where Sitecore keeps images, videos and files.' },
  {
    term: 'CDN',
    meaning:
      'A network that serves images and video from servers near each visitor, so they load faster.',
  },
];

/** The terms a document view defines: the base list plus the plain version's own. */
export const GlossaryContext = createContext<Term[]>([]);
export const useGlossary = () => useContext(GlossaryContext);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    const re = new RegExp(`\\b${escapeRe(t.term)}s?\\b`, 'i');
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
