/*
 * "On this page": the open document's headings, read from the Workbench's own document container
 * (a ref, never a global class name). Nothing is written into the document: no ids are added, and
 * a click scrolls to the heading element it was read from. The container is watched only so that
 * content arriving later (a fetched version, a Markdown diagram, a loaded table) is picked up.
 */
import { useEffect, useRef, useState } from 'react';
import s from './workbench.module.css';

export interface Heading {
  text: string;
  level: 2 | 3;
}

/** Elements inside `[data-toc-skip]` (a document's own title bar) are not part of the page. */
const SKIP = '[data-toc-skip]';

/** The headings of the document in `el`, re-read when `key` (the open page) changes. */
export function useHeadings(el: HTMLElement | null, key: string) {
  const [items, setItems] = useState<Heading[]>([]);
  const nodes = useRef<HTMLElement[]>([]);

  useEffect(() => {
    setItems([]);
    nodes.current = [];
    if (!el) return;
    let frame = 0;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const found = [...el.querySelectorAll<HTMLElement>('h2, h3')].filter(
          // Hidden headings (a reused component's own title, folded away here) are left out.
          (h) => !h.closest(SKIP) && h.getClientRects().length > 0 && h.textContent?.trim(),
        );
        const next = found.map<Heading>((h) => ({
          text: h.textContent!.trim(),
          level: h.tagName === 'H3' ? 3 : 2,
        }));
        nodes.current = found;
        setItems((prev) =>
          prev.length === next.length &&
          prev.every((p, i) => p.text === next[i]!.text && p.level === next[i]!.level)
            ? prev
            : next,
        );
      });
    };
    read();
    const watch = new MutationObserver(read);
    watch.observe(el, { childList: true, subtree: true });
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [el, key]);

  const go = (i: number) => {
    const h = nodes.current[i];
    if (!h?.isConnected) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    h.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  };

  return { items, go };
}

export function Toc({ items, go }: { items: Heading[]; go: (i: number) => void }) {
  return (
    <nav className={s.toc} aria-label="On this page">
      <h2 className={`${s.tocTitle} type-label`}>On this page</h2>
      <ul className={s.tocList}>
        {items.map((t, i) => (
          <li key={`${i}-${t.text}`} data-level={t.level}>
            <button type="button" className={`${s.tocLink} type-meta`} onClick={() => go(i)}>
              {t.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
