import type { PortfolioProject } from '@lw/contracts';

/**
 * "Build a SitecoreAI website" → "Website": the platform sits beside it, so the playbook is named
 * by what it builds.
 */
export function playbookShort(p: PortfolioProject): string {
  if (!p.playbook) return 'No playbook';
  let name = p.playbook.name.replace(/^build an? /i, '');
  if (p.platform && name.toLowerCase().startsWith(`${p.platform.name.toLowerCase()} `))
    name = name.slice(p.platform.name.length + 1);
  return name.charAt(0).toUpperCase() + name.slice(1);
}
export const platformOf = (p: PortfolioProject) => p.platform?.name ?? 'Other';
