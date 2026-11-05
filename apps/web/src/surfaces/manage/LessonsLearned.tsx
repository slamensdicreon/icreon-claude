/*
 * A project's retrospectives, in its Workbench: each phase, what its retrospective proposed, and
 * the proposals to approve, edit or reject on the same card as the Knowledge page. The Workbench
 * gives the page its heading; this renders what goes under it.
 */
import type { KnowledgeEntry, LessonsSnapshot } from '@lw/contracts';
import { useState } from 'react';
import { messageOf, postFor } from '../../lib/api';
import { useApp } from '../../state';
import { Action, Notice, usePlaybooks } from '../intake/shared';
import { EntryGroups, KnowledgeCard } from './Knowledge';
import { catalogNames, Lead, Pending, useResource } from './shared';
import s from './manage.module.css';

export function LessonsLearned({ projectId }: { projectId: string }) {
  const { toast, projects } = useApp();
  const names = catalogNames(usePlaybooks().playbooks);
  const { data, error, reload } = useResource<LessonsSnapshot>(
    `/projects/${projectId}/lessons`,
    null,
    'Lessons could not be loaded.',
  );
  const [running, setRunning] = useState<number | null>(null);

  const run = (phase: number) => {
    setRunning(phase);
    postFor<{ summary: string; proposed: KnowledgeEntry[] }>(
      `/projects/${projectId}/retrospectives`,
      { phase },
    )
      .then((r) => {
        toast(
          r.proposed.length
            ? `${r.proposed.length} proposed. ${r.summary}`
            : `Nothing new to propose. ${r.summary}`,
        );
        void reload();
      })
      .catch((err: unknown) => toast(messageOf(err, 'The retrospective did not run.')))
      .finally(() => setRunning(null));
  };

  return (
    <div className={s.lessons}>
      <Lead>
        At the end of each phase, a retrospective reads what it cost (your cards, the Leads’
        rejections, waits, failed checks) and proposes what the team should know next time. Nothing
        reaches a brief until you approve it; approved lessons carry to every project they fit.
      </Lead>
      {!data ? (
        <Pending error={error} loading="Loading…" />
      ) : (
        <>
          {!data.available && (
            <Notice tone="idle">Retrospectives need Claude, and none is configured.</Notice>
          )}
          <div className={s.tableWrap}>
            <table className={`${s.table} ${s.stackOnPhone} type-table`}>
              <caption className="sr-only">Retrospectives by phase</caption>
              <thead>
                <tr>
                  <th scope="col">Phase</th>
                  <th scope="col" className={s.num}>
                    Proposed
                  </th>
                  <th scope="col">
                    <span className="sr-only">Retrospective</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.phases.map((p) => (
                  <tr key={p.phase}>
                    <th scope="row" className={s.strong}>
                      {p.phase}. {p.name}
                    </th>
                    <td className={s.num}>
                      {p.exited ? p.proposed : <span className={s.quietInline}>Not finished</span>}
                    </td>
                    <td className={s.actionsCell}>
                      {p.exited && (
                        <Action
                          disabled={!data.available || running !== null}
                          label={`${p.proposed ? 'Run again' : 'Run retrospective'}: ${p.name}`}
                          onClick={() => run(p.phase)}
                        >
                          {running === p.phase
                            ? 'Reading the phase…'
                            : p.proposed
                              ? 'Run again'
                              : 'Run retrospective'}
                        </Action>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.entries.length > 0 ? (
            <EntryGroups
              entries={data.entries}
              noun="proposal"
              render={(e) => (
                <KnowledgeCard
                  key={e.id}
                  e={e}
                  projects={projects}
                  names={names}
                  onChange={() => void reload()}
                />
              )}
            />
          ) : (
            <p className={`${s.quiet} type-body-small`}>No proposals yet.</p>
          )}
        </>
      )}
    </div>
  );
}
