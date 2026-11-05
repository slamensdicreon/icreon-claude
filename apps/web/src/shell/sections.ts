/*
 * The shell's sections as data, shared by the Rail (Bliss) and the Sidebar (Everything) so the two
 * never drift. Names are the same in both modes (design system §8); the rail uses its short word
 * under the icon ("Yours" for Needs you).
 */
import type { IconName } from '../theme/icons';
import type { PortfolioPage, Surface } from '../state';

export interface Section {
  surface: Surface;
  icon: IconName;
  label: string;
  /** The word under the icon in the rail. */
  short: string;
  /** Carries the count of what is yours. */
  yours?: boolean;
}

export const PROJECT_SECTIONS: Section[] = [
  { surface: 'mission', icon: 'home', label: 'Mission Control', short: 'Mission' },
  { surface: 'inbox', icon: 'inbox', label: 'Needs you', short: 'Yours', yours: true },
  { surface: 'team', icon: 'team', label: 'Team', short: 'Team' },
  { surface: 'plan', icon: 'plan', label: 'Plan', short: 'Plan' },
  { surface: 'workbench', icon: 'workbench', label: 'Workbench', short: 'Workbench' },
  { surface: 'preview', icon: 'site', label: 'Site preview', short: 'Site' },
  { surface: 'activity', icon: 'activity', label: 'Activity', short: 'Activity' },
  { surface: 'scorecard', icon: 'scorecard', label: 'Scorecard', short: 'Scorecard' },
];

/** The portfolio's own sections, after Dashboard, Needs you and Projects (design system §8). */
export const PORTFOLIO_SECTIONS: {
  page: PortfolioPage;
  icon: IconName;
  label: string;
  short: string;
}[] = [
  { page: 'team', icon: 'team', label: 'Team', short: 'Team' },
  { page: 'workbench', icon: 'workbench', label: 'Workbench', short: 'Workbench' },
  { page: 'activity', icon: 'activity', label: 'Activity', short: 'Activity' },
  { page: 'scorecard', icon: 'scorecard', label: 'Scorecard', short: 'Scorecard' },
];
