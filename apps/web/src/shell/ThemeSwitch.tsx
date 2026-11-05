import { useApp } from '../state';
import { SegmentedControl } from '../ui/segmented-control';

type Choice = 'system' | 'light' | 'dark';

const OPTIONS: { value: Choice; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Light, dark, or the system's setting (design system §5), remembered on this device. */
export function ThemeSwitch({ onShell = false }: { onShell?: boolean }) {
  const { theme, setTheme } = useApp();
  return (
    <SegmentedControl
      aria-label="Theme"
      memory={onShell ? 'theme-shell' : 'theme'}
      size="sm"
      fullWidth
      variant="tray"
      tone={onShell ? 'onInk' : 'default'}
      value={theme ?? 'system'}
      onChange={(v) => setTheme(v === 'system' ? null : v)}
      options={OPTIONS}
    />
  );
}
