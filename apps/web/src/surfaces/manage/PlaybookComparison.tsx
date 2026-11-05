/*
 * Projects on one playbook side by side on the scorecard's headline numbers: the next site
 * against the last. Rebuilt from PlaybookComparison in surfaces/Scorecard.tsx on Cypher's table.
 */
import type { PlaybookScorecard } from '@lw/contracts';
import { usd } from '../../lib/fmt';
import s from './manage.module.css';

const num = (n: number) => n.toLocaleString('en-US');
const pctOf = (n: number | null) => (n === null ? '–' : `${n}%`);

export function PlaybookComparison({ data }: { data: PlaybookScorecard }) {
  if (!data.projects.length) return null;
  return (
    <div className={s.tableWrap}>
      <table className={`${s.table} type-table`}>
        <caption className="sr-only">How the projects on this playbook went</caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col" className={s.num}>
              Cards per task
            </th>
            <th scope="col" className={s.num}>
              Settled without you
            </th>
            <th scope="col" className={s.num}>
              Recommendation taken
            </th>
            <th scope="col" className={s.num}>
              Lead rejections
            </th>
            <th scope="col" className={s.num}>
              Repeats
            </th>
            <th scope="col" className={s.num}>
              Spent
            </th>
          </tr>
        </thead>
        <tbody>
          {data.projects.map((p) => (
            <tr key={p.projectId}>
              <th scope="row" className={s.strong}>
                {p.name}
                {p.version && <span className={`${s.under} type-meta`}>Version {p.version}</span>}
              </th>
              <td className={s.num}>{p.totals.cardsPerTask}</td>
              <td className={s.num}>{p.totals.settledWithoutDirectorPct}%</td>
              <td className={s.num}>{pctOf(p.totals.recommendedTakenPct)}</td>
              <td className={s.num}>{pctOf(p.totals.rejectionRate)}</td>
              <td className={s.num}>{num(p.totals.repeats)}</td>
              <td className={s.num}>{usd(p.totals.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
