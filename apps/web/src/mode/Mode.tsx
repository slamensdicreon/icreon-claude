import type { ReactNode } from 'react';
import { useMode } from './mode';

/**
 * A screen's two faces: renders the one the dial has chosen for this screen. Every surface ends
 * as `<Mode bliss={…} everything={…}/>` before it leaves the old shell (PLAN.md › rule 3).
 */
export function Mode({ bliss, everything }: { bliss: ReactNode; everything: ReactNode }) {
  return <>{useMode().mode === 'bliss' ? bliss : everything}</>;
}
