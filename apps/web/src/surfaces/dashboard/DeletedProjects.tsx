/*
 * What is left of deleted projects: who they were, who asked, when they went, and what happened to
 * the build repository and the hosting project. Shown under the Dashboard's Archived filter.
 */
import { usePoll } from '../../lib/poll';
import { Panel } from '../../ui/cypher/parts';
import { DeletionReady } from '../settings/DeletionReady';
import s from './dashboard.module.css';

/** A purge step's record, as `GET /portfolio/deleted` serves it. */
interface Step {
  at: string;
  result: { outcome?: string; detail?: string } & Record<string, unknown>;
}
interface Tombstone {
  projectId: string;
  name: string;
  client: string;
  requestedBy: string;
  finishedAt: string | null;
  steps: Record<string, Step>;
}

const OUTCOME: Record<string, string> = {
  deleted: 'Deleted',
  not_found: 'Already gone',
  handed_over: 'Handed over, left',
  refused: 'Refused',
  skipped: 'Left',
  kept: 'Kept',
};
const day = (t: string) =>
  new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function Outcome({ step }: { step?: Step }) {
  if (!step) return <span className="type-meta">Not yet</span>;
  const o = step.result.outcome ?? 'deleted';
  return (
    <span title={step.result.detail} className={o === 'refused' ? s.refused : undefined}>
      {OUTCOME[o] ?? o}
    </span>
  );
}

export function DeletedProjects() {
  const { data, error } = usePoll<Tombstone[]>('/portfolio/deleted', 60_000);
  if (error || !data?.length) return null;
  return (
    <Panel title="Deleted projects" meta={`${data.length} · what is left after a deletion`}>
      <div className={s.readyWrap}>
        <DeletionReady />
      </div>
      <div className={s.tableWrap}>
        <table className={`${s.table} type-table`}>
          <thead>
            <tr>
              <th>Project</th>
              <th>Asked by</th>
              <th>Deleted</th>
              <th>Build repository</th>
              <th>Hosting project</th>
            </tr>
          </thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.projectId}>
                <td>
                  <span className="type-body-small">{t.name}</span>
                  <span className="type-meta"> · {t.client}</span>
                </td>
                <td>{t.requestedBy}</td>
                <td>{t.finishedAt ? day(t.finishedAt) : 'Under way'}</td>
                <td>
                  <Outcome step={t.steps.repository} />
                </td>
                <td>
                  <Outcome step={t.steps.hosting} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
