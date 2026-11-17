/*
 * The pages above any project (Everything only), opened from Settings in the sidebar: People,
 * Connections, Playbooks and Your playbooks (the organization's own rules and lessons). Icreon's own administration is in its admin console, apart from the
 * product. The top bar carries each page's title and line (MANAGE in state.tsx), so a page starts
 * with its own sentence.
 */
import type { ManagePage as Page } from '../../state';
import { Connections } from './Connections';
import { Playbooks } from './Playbooks';
import { Variants } from './Variants';
import { PeoplePanel } from '../settings/PeoplePanel';
import { LicensePanel } from '../settings/LicensePanel';
import { Lead, usePortfolio } from './shared';
import s from './manage.module.css';

export { GithubAppPanel } from './GithubApp';

export function ManagePage({ page }: { page: Page }) {
  // Only the pages that name projects need the portfolio.
  const projects = usePortfolio(page === 'connections' || page === 'playbooks');
  return (
    <div className={s.manage}>
      {page === 'people' && (
        <div className={s.page}>
          <Lead>
            Who can see and run your organization’s projects. Directors decide; Watchers follow
            along.
          </Lead>
          <PeoplePanel />
          <LicensePanel />
        </div>
      )}
      {page === 'connections' && <Connections projects={projects} />}
      {page === 'playbooks' && <Playbooks projects={projects} />}
      {page === 'variants' && <Variants />}
    </div>
  );
}
