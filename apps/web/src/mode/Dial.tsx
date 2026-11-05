import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../ui/eye/geometry';
import { SegmentedControl } from '../ui/segmented-control';
import { useMode, type ModeName } from './mode';

const OPTIONS: { value: ModeName; label: string }[] = [
  { value: 'bliss', label: 'Bliss' },
  { value: 'everything', label: 'Everything' },
];

/**
 * The Bliss / Everything switch (Dial guideline), on affectUI's Segmented Control: a group of two
 * pressed-state buttons that decides how much the screen shows, remembered per screen; arrow keys
 * move between them. Hidden where a screen has one face.
 */
export function Dial({ tone = 'light' }: { tone?: 'light' | 'onInk' }) {
  const { mode, setMode, fixed } = useMode();
  // The pill moves the moment it is chosen; the eye's scene starts a beat later, so the glide is seen.
  const [shown, setShown] = useState(mode);
  useEffect(() => setShown(mode), [mode]);
  const choose = (next: ModeName) => {
    if (next === mode) return;
    setShown(next);
    if (prefersReducedMotion()) setMode(next);
    else window.setTimeout(() => setMode(next), 220);
  };
  if (fixed) return null;
  return (
    <SegmentedControl
      kind="toggle"
      tone={tone === 'onInk' ? 'onInk' : 'default'}
      aria-label="How much to show"
      memory="dial"
      value={shown}
      onChange={choose}
      options={OPTIONS}
    />
  );
}
