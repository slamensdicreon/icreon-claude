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
import { useEffect, useRef, useState } from 'react';
import { Dock } from '../dock/Dock';
import { CypherHome } from '../surfaces/CypherHome';
import { useApp, useConversation } from '../state';
import { Icon } from '../theme/icons';
import { usePresence } from '../ui/cypher/motion';
import { Ticker } from '../ui/cypher/parts';
import { SmallEye } from '../ui/eye/SmallEye';
import { useEyeState } from '../voice/eye';
import styles from './Shell.module.css';

export function CypherLauncher() {
  const { layout, setLayout } = useApp();
  const eye = useEyeState();
  const open = layout.dockOpen;
  // Hovered or focused, the eye perks up; while Cypher composes a reply it looks about.
  const [perk, setPerk] = useState(false);
  const thinking = useConversation().data?.presence === 'thinking';
  return (
    <button
      className={styles.launcher}
      aria-expanded={open}
      aria-controls="cypher-sheet"
      aria-label={
        open ? 'Close Cypher' : eye.yours ? `Open Cypher, ${eye.yours} yours` : 'Open Cypher'
      }
      onClick={() => setLayout({ dockOpen: !open, dockCollapsed: false })}
      onPointerEnter={() => setPerk(true)}
      onPointerLeave={() => setPerk(false)}
      onFocus={() => setPerk(true)}
      onBlur={() => setPerk(false)}
    >
      <SmallEye
        state={eye.state}
        blink={eye.blink}
        size={40}
        tone="onInk"
        lively
        perk={perk}
        attending={open}
        thinking={thinking}
      />
      {eye.yours > 0 && (
        <span className={`${styles.launcherBadge} type-label`} aria-hidden="true">
          <Ticker value={eye.yours} />
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
  // It springs up out of the eye button and sinks back into it when closed.
  const { mounted, closing } = usePresence(open, 180);
  if (!mounted) return null;
  return (
    <div
      id={closing ? undefined : 'cypher-sheet'}
      ref={ref}
      className={styles.sheet}
      role="dialog"
      aria-label="Cypher"
      data-closing={closing || undefined}
      inert={closing || undefined}
    >
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
