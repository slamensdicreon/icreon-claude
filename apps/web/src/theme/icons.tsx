/*
 * Cypher's line icons (design system §9): drawn on a 24 grid at 1.8 stroke, round caps and joins,
 * in the current text color. 20px by default, 22 in the rail. Paths are the reference boards' own.
 *
 * In navigation an icon always sits beside a word. On its own it needs a 44px-or-larger button
 * with an accessible name, so the icon itself is always hidden from assistive technology.
 * The eye is not here: it is only ever Cypher (theme/marks.tsx, ui/Eye.tsx).
 */
import type { ReactNode } from 'react';

const ICONS = {
  home: (
    <path d="M4 5a1 1 0 0 1 1-1h5v7H4zM14 4h5a1 1 0 0 1 1 1v3h-6zM14 11h6v8a1 1 0 0 1-1 1h-5zM4 14h6v6H5a1 1 0 0 1-1-1z" />
  ),
  inbox: <path d="M4 4h16v11l-2 5H6l-2-5zM4 15h5l1.5 2h3L15 15h5" />,
  projects: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  team: (
    <path d="M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M17 11.5a3 3 0 1 0 0-6M22 19a5.5 5.5 0 0 0-5.5-5.5" />
  ),
  plan: <path d="M4 6h12M4 12h16M4 18h8M19 15l2 2-2 2" />,
  workbench: <path d="M6 3h9l4 4v14H6zM15 3v4h4M9 12h6M9 16h6" />,
  site: (
    <path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 9h18M7 6.5h.01" />
  ),
  activity: <path d="M3 12h4l3 7 4-14 3 7h4" />,
  scorecard: <path d="M4 20h16M7 16V9M12 16V4M17 16v-6" />,
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="17" r="2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  check: <path d="m5 12 5 5L20 7" />,
  send: <path d="M12 19V5M6 11l6-6 6 6" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export function Icon({
  name,
  size = 20,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
