/*
 * The tab's icon is Cypher's eye and says what the eye says: ink and open while it watches, coral
 * when something is the Director's, so a background tab shows when it needs a word. It blinks now
 * and then. Drawn from the marks (theme/marks/*.svg), as a data URL on the SVG icon link.
 */
import { useEffect } from 'react';
import { useEyeState, type EyeState } from '../voice/eye';

/** The marks' literal colours (an icon can't read CSS variables): ink, coral, white. */
const INK = '#141433';
const CORAL = '#e8553d';
const WHITE = '#ffffff';

function svg(state: EyeState, closed: boolean): string {
  const coral = state === 'needs-a-word';
  const ball = `<circle cx="36" cy="36" r="34" fill="${coral ? CORAL : INK}"/>`;
  const eye = closed
    ? `<path d="M17 37 Q36 50 55 37" fill="none" stroke="${WHITE}" stroke-width="5" stroke-linecap="round"/>`
    : state === 'resting'
      ? `<path d="M18 36 Q36 51 54 36" fill="none" stroke="${WHITE}" stroke-width="5" stroke-linecap="round"/>`
      : coral
        ? `<path d="M15 36 Q36 16 57 36 Q36 56 15 36 Z" fill="${WHITE}"/><circle cx="36" cy="36" r="8.5" fill="${INK}"/>`
        : `<path d="M16 36 Q36 18 56 36 Q36 54 16 36 Z" fill="none" stroke="${WHITE}" stroke-width="4.5" stroke-linejoin="round"/><circle cx="36" cy="36" r="6.5" fill="${WHITE}"/>`;
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72">${ball}${eye}</svg>`)}`;
}

export function LiveFavicon() {
  const { state } = useEyeState();
  useEffect(() => {
    const link = document.getElementById('favicon') as HTMLLinkElement | null;
    if (!link) return;
    link.href = svg(state, false);
    if (state === 'resting' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer = 0;
    const blink = () => {
      link.href = svg(state, true);
      window.setTimeout(() => (link.href = svg(state, false)), 160);
      timer = window.setTimeout(blink, 6000 + Math.random() * 6000);
    };
    timer = window.setTimeout(blink, 4000 + Math.random() * 4000);
    return () => window.clearTimeout(timer);
  }, [state]);
  return null;
}
