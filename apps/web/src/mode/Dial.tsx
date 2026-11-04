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
  if (fixed) return null;
  return (
    <SegmentedControl
      kind="toggle"
      tone={tone === 'onInk' ? 'onInk' : 'default'}
      aria-label="How much to show"
      value={mode}
      onChange={setMode}
      options={OPTIONS}
    />
  );
}
