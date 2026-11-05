import { EyeNeedsAWord, EyeResting, EyeWatching, type MarkTone } from '../theme/marks';
import { EYE_WORDS, type EyeState } from '../voice/eye';
import styles from './Eye.module.css';

const MARK = {
  resting: EyeResting,
  watching: EyeWatching,
  'needs-a-word': EyeNeedsAWord,
} as const;

/**
 * Cypher's presence as a mark (Eye guideline). The consumer provides the state and the size:
 * 20 beside a label, 22 in the rail, 34–46 in the shell, 44 in a project ring, 102–118 as a Bliss
 * hero. `halo` is for the hero only. `decorative` hides it where a word beside it already says
 * the state; otherwise it is an image named by its state.
 */
export function Eye({
  state,
  size = 20,
  tone = 'light',
  blink = false,
  halo = false,
  decorative = false,
  label,
}: {
  state: EyeState;
  size?: number;
  /** Where it sits: the page, an ink-filled control (the Cypher button), or the shell. */
  tone?: MarkTone;
  blink?: boolean;
  halo?: boolean;
  decorative?: boolean;
  /** The accessible name, when it should say more than the state ("Cypher, needs a word"). */
  label?: string;
}) {
  const Mark = MARK[state];
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': label ?? `Cypher: ${EYE_WORDS[state]}` } as const);
  const mark = (
    <span className={`${styles.eye} ${blink ? styles.blink : ''}`} {...a11y}>
      <Mark size={size} tone={tone} aria-hidden="true" focusable="false" />
    </span>
  );
  if (!halo) return mark;
  return (
    <span
      className={styles.hero}
      data-yours={state === 'needs-a-word' || undefined}
      style={{ '--eye': `${size}px` } as React.CSSProperties}
    >
      <span className={styles.halo} aria-hidden="true" />
      <span className={styles.disc} aria-hidden="true" />
      {mark}
    </span>
  );
}
