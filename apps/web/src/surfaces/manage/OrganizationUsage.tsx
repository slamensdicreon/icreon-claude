/*
 * What one organization has cost Icreon (Icreon only): Claude, the time its agents' tools ran,
 * and its Vercel builds, project by project.
 */
import { usd } from '../../lib/fmt';
import { Notice } from '../intake/shared';
import { Pending, useResource } from './shared';
import s from './manage.module.css';

interface Usage {
  totals: {
    claudeUsd: number;
    claudeTokens: number;
    sandboxMinutes: number;
    toolMinutes: number;
    vercelDeployments: number;
    vercelBuildMinutes: number;
  };
  projects: {
    projectId: string;
    name: string;
    claude: { usd: number; tokens: number };
    toolMinutes: Record<string, number>;
    vercel: {
      hostingProject: string | null;
      deployments: number;
      failed: number;
      buildMinutes: number;
    };
    vercelNote: string | null;
  }[];
  cachedForMinutes: number;
}

const n = (x: number) => x.toLocaleString('en-US');

export function OrganizationUsage({ id }: { id: string }) {
  const { data, error } = useResource<Usage>(
    `/admin/organizations/${id}/usage`,
    null,
    'Usage could not be loaded.',
  );
  if (!data) return <Pending error={error} loading="Reading usage (Vercel can take a moment)…" />;
  const t = data.totals;
  return (
    <>
      <p className={`${s.quiet} type-body-small`}>
        {usd(t.claudeUsd)} of Claude ({n(t.claudeTokens)} tokens) · {n(t.sandboxMinutes)} sandbox
        minutes ({n(t.toolMinutes)} minutes of tools in all) · {n(t.vercelDeployments)} Vercel
        builds, {n(t.vercelBuildMinutes)} build minutes.
      </p>
      {data.projects.length ? (
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <caption className="sr-only">Usage by project</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col" className={s.num}>
                  Claude
                </th>
                <th scope="col" className={s.num}>
                  Sandbox min
                </th>
                <th scope="col" className={s.num}>
                  Builds
                </th>
                <th scope="col" className={s.num}>
                  Build min
                </th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p) => (
                <tr key={p.projectId}>
                  <th scope="row" className={s.strong}>
                    {p.name}
                    {(p.vercel.hostingProject || p.vercelNote) && (
                      <span className={`${s.under} type-meta`}>
                        {p.vercelNote ?? p.vercel.hostingProject}
                      </span>
                    )}
                  </th>
                  <td className={s.num}>{usd(p.claude.usd)}</td>
                  <td className={s.num}>{n(p.toolMinutes.sandbox ?? 0)}</td>
                  <td className={s.num}>
                    {n(p.vercel.deployments)}
                    {p.vercel.failed ? ` (${p.vercel.failed} failed)` : ''}
                  </td>
                  <td className={s.num}>{n(p.vercel.buildMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Notice tone="idle">No projects yet.</Notice>
      )}
      <p className={`${s.quiet} type-meta`}>
        Vercel's figures are kept {data.cachedForMinutes} minutes. Its API gives no bandwidth or
        function time per project, so those aren't counted.
      </p>
    </>
  );
}
