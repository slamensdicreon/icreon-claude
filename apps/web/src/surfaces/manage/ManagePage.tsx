/*
 * The pages above any project (Everything only), opened from Settings in the sidebar: Global
 * settings, Connections, Playbooks, In force, Rules, Knowledge and Diagnostics. The top bar carries each
 * page's title and line (MANAGE in state.tsx), so a page starts with its own sentence.
 */
import type { ManagePage as Page } from '../../state';
import { Connections } from './Connections';
import { Diagnostics } from './Diagnostics';
import { GithubAppPanel } from './GithubApp';
import { InForce } from './InForce';
import { Knowledge } from './Knowledge';
import { Playbooks } from './Playbooks';
import { Rules } from './Rules';
import { PeoplePanel } from '../settings/PeoplePanel';
import { LicensePanel } from '../settings/LicensePanel';
import { Organizations } from './Organizations';
import { Lead, usePortfolio } from './shared';
import s from './manage.module.css';

export { GithubAppPanel } from './GithubApp';
export { LessonsLearned } from './LessonsLearned';

export function ManagePage({ page }: { page: Page }) {
  // Only the pages that name projects need the portfolio.
  const projects = usePortfolio(
    !['settings', 'diagnostics', 'people', 'organizations'].includes(page),
  );
  return (
    <div className={s.manage}>
      {page === 'settings' && (
        <div className={s.page}>
          <Lead>
            Settings every project shares. Each project’s own policies, budgets and credentials are
            in its Settings.
          </Lead>
          <GithubAppPanel />
        </div>
      )}
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
      {page === 'organizations' && <Organizations />}
      {page === 'connections' && <Connections projects={projects} />}
      {page === 'playbooks' && <Playbooks projects={projects} />}
      {page === 'in-force' && <InForce />}
      {page === 'rules' && <Rules projects={projects} />}
      {page === 'knowledge' && <Knowledge projects={projects} />}
      {page === 'diagnostics' && <Diagnostics />}
    </div>
  );
}
