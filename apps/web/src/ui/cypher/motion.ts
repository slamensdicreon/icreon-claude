/*
 * Functional motion helpers. A glide is one indicator inside a group that travels to whichever item
 * is chosen (a filter chip, the active section in the rail or sidebar), so the eye follows the
 * change instead of seeing one thing switch off and another on. It sits behind the items; the items
 * show their chosen colors through it. Under reduced motion it moves in one step.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Keeps `indicator` over the item in `group` that matches `selector`. `key` is what changes when the
 * choice does. The first placement and any resize jump; a change of choice glides (CSS transitions
 * on transform, width and height, with the spring). The group gets `data-glide` once placed, which
 * is when items drop their own chosen background.
 */
export function useGlide(
  group: RefObject<HTMLElement | null>,
  indicator: RefObject<HTMLElement | null>,
  key: unknown,
  selector = '[aria-pressed="true"], [aria-current="page"]',
) {
  const placed = useRef(false);
  // Until this time a glide is under way: a resize then re-aims it rather than snapping it.
  const glidingUntil = useRef(0);
  useLayoutEffect(() => {
    const g = group.current;
    const i = indicator.current;
    if (!g || !i) return;
    const place = (animate: boolean) => {
      const el = g.querySelector<HTMLElement>(selector);
      if (!el || !el.offsetWidth) {
        i.style.opacity = '0';
        return;
      }
      const gr = g.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      const instant =
        (!animate && performance.now() > glidingUntil.current) || !placed.current || reducedMotion();
      if (!instant && animate) glidingUntil.current = performance.now() + 600;
      if (instant) i.style.transition = 'none';
      i.style.opacity = '1';
      i.style.width = `${er.width}px`;
      i.style.height = `${er.height}px`;
      i.style.transform = `translate(${er.left - gr.left + g.scrollLeft}px, ${er.top - gr.top + g.scrollTop}px)`;
      if (instant) {
        void i.offsetWidth;
        i.style.transition = '';
      }
      placed.current = true;
      g.setAttribute('data-glide', '');
    };
    place(true);
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => place(false));
    });
    ro.observe(g);
    g.querySelectorAll(':scope > *').forEach((c) => ro.observe(c));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
    // The selector is fixed per use; key carries the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/**
 * Keeps something mounted for its exit: `mounted` stays true for `ms` after `open` turns false, with
 * `closing` true meanwhile, so it can play its leaving animation. Under reduced motion it goes at
 * once.
 */
export function usePresence(open: boolean, ms = 200): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), ms);
    return () => window.clearTimeout(t);
  }, [open, ms]);
  return { mounted: open || mounted, closing: !open && mounted };
}
