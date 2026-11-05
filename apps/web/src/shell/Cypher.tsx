/*
 * Cypher in Everything (design system §8): a fixed eye button at the bottom right that opens the
 * conversation as a sheet over the content. Nothing docks beside the content, and nothing here
 * exists in Bliss, where Cypher's judgment is already inside the cards.
 *
 * Phase 0 puts the existing Chief of Staff conversation (dock/Dock.tsx) inside the sheet as it is;
 * phase 2 rebuilds the sheet's contents (status block, bubbles, quick prompts) on affectUI.
 * The sheet's open state is the old dock's (`layout.dockOpen`), so Ctrl or Cmd /, Esc and the
 * phone's bottom bar keep working.
 */
import { useEffect, useRef } from 'react';
import { Dock } from '../dock/Dock';
import { CypherHome } from '../surfaces/CypherHome';
import { useApp } from '../state';
import { Icon } from '../theme/icons';
import { Eye } from '../ui/Eye';
import { useEyeState } from '../voice/eye';
import styles from './Shell.module.css';

export function CypherLauncher() {
  const { layout, setLayout } = useApp();
  const eye = useEyeState();
  const open = layout.dockOpen;
  return (
    <button
      className={styles.launcher}
      aria-expanded={open}
      aria-controls="cypher-sheet"
      aria-label={
        open ? 'Close Cypher' : eye.yours ? `Open Cypher, ${eye.yours} yours` : 'Open Cypher'
      }
      onClick={() => setLayout({ dockOpen: !open, dockCollapsed: false })}
    >
      <Eye state={eye.state} blink={eye.blink} size={40} tone="onInk" decorative />
      {eye.yours > 0 && (
        <span className={`${styles.launcherBadge} type-label`} aria-hidden="true">
          {eye.yours}
        </span>
      )}
    </button>
  );
}

export function CypherSheet() {
  const { layout, setLayout, projectId } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const open = layout.dockOpen;
  // Opening moves focus into the sheet; the composer takes it when Ctrl or Cmd / opened it.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const el = ref.current;
      if (el && !el.contains(document.activeElement))
        el.querySelector<HTMLElement>('textarea')?.focus();
    }, 50);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!open) return null;
  return (
    <div id="cypher-sheet" ref={ref} className={styles.sheet} role="dialog" aria-label="Cypher">
      <button
        className={styles.sheetClose}
        aria-label="Close Cypher"
        onClick={() => setLayout({ dockOpen: false })}
      >
        <Icon name="close" size={18} />
      </button>
      {/* Inside a project, the Chief of Staff's conversation; above them all, the portfolio chat. */}
      {projectId ? (
        <Dock />
      ) : (
        <div className={styles.sheetHome}>
          <CypherHome />
        </div>
      )}
    </div>
  );
}
