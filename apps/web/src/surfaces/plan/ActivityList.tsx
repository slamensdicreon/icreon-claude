/*
 * The activity list: every activity of the engagement, filtered by state (remembered as
 * `ui.planFilter`), with its phase, owner, window and state. An activity of several tasks folds
 * open to them, and can send every finished one back for a fresh attempt.
 */
import type { ScheduleSnapshot, TaskState } from '@lw/contracts';
import { useState } from 'react';
import { post } from '../../lib/api';
import { clock, shortDay } from '../../lib/fmt';
import { TextForm } from '../../overlays/Dialogs';
import { useApp, useRoster } from '../../state';
import { Icon } from '../../theme/icons';
import { Button, Chips, Panel } from '../../ui/cypher/parts';
import { plural } from './model';
import { Owner, StateWord } from './parts';
import s from './plan.module.css';

type Filter = 'all' | 'open' | 'running' | 'waiting' | 'done';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'running', label: 'Running' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'done', label: 'Done' },
];
const match = (state: TaskState, f: string) =>
  f === 'all'
    ? true
    : f === 'open'
      ? state !== 'done'
      : f === 'running'
        ? state === 'running' || state === 'validating'
        : state === f;

export function ActivityList({ s: sched }: { s: ScheduleSnapshot }) {
  const { ui, setUi, inspect, projectId, run, openOverlay, closeOverlay } = useApp();
  const { byId } = useRoster();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const tz = sched.timezone;
  const task = new Map(sched.tasks.map((t) => [t.taskId, t]));
  const filter = (FILTERS.some((f) => f.value === ui.planFilter) ? ui.planFilter : 'all') as Filter;
  const all = sched.phases.flatMap((p) =>
    p.activities.map((a) => ({ ...a, phase: p.phase, phaseName: p.name })),
  );
  const shown = all.filter((a) => match(a.state, filter));
  const when = (t: string) => `${shortDay(t, tz)}, ${clock(t, tz)}`;
  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  // Every finished task in a group goes back to its agent, one after another, with the same
  // instructions; unfinished ones aren't touched.
  const rerunAll = (title: string, ids: string[]) => {
    const done = ids.filter((id) => task.get(id)?.state === 'done');
    openOverlay(
      <TextForm
        title={`Re-run ${done.length} of ${title}`}
        body={`The ${plural(done.length, 'finished task', 'finished tasks')} in this group start a fresh attempt with these instructions. Unfinished ones aren't touched.`}
        label="Instructions"
        placeholder="What should change this time?"
        submitLabel={`Re-run ${done.length}`}
        onSubmit={(instructions) => {
          closeOverlay();
          void run(async () => {
            for (const id of done)
              await post(`/projects/${projectId}/tasks/${encodeURIComponent(id)}/rerun`, {
                instructions,
              });
          }, `Re-running ${done.length} tasks`);
        }}
      />,
    );
  };

  return (
    <Panel
      title="Activities"
      chips={
        <Chips<Filter>
          label="Show activities"
          value={filter}
          onChange={(v) => setUi({ planFilter: v })}
          options={FILTERS.map((f) => ({
            ...f,
            count: all.filter((a) => match(a.state, f.value)).length,
          }))}
        />
      }
      meta="Select an activity or an owner for detail"
    >
      <div className={s.tableWrap}>
        <table className={`${s.table} ${s.list} type-table`}>
          <thead>
            <tr>
              <th>Phase</th>
              <th>Activity</th>
              <th>Owner</th>
              <th>Start</th>
              <th>Finish</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {shown.flatMap((a) => {
              const many = a.taskIds.length > 1;
              const expanded = many && open.has(a.key);
              const finished = a.taskIds.filter((id) => task.get(id)?.state === 'done').length;
              const rows = [
                <tr key={a.key} data-open={expanded || undefined}>
                  <td className={s.secondary}>
                    {a.phase}. {a.phaseName}
                  </td>
                  <td>
                    {many ? (
                      <button
                        type="button"
                        className={s.fold}
                        aria-expanded={expanded}
                        onClick={() => toggle(a.key)}
                      >
                        <Icon name="chevron" size={18} className={s.foldIcon} />
                        <span>{a.title}</span>
                        <span className={s.quietText}>{a.taskIds.length} tasks</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={s.rowLink}
                        onClick={() => a.taskIds[0] && inspect('task', a.taskIds[0])}
                      >
                        {a.title}
                      </button>
                    )}
                  </td>
                  <td>
                    <Owner agent={byId(a.agentId)} id={a.agentId} compact />
                  </td>
                  <td className={s.secondary}>{when(a.start)}</td>
                  <td className={s.secondary}>{when(a.end)}</td>
                  <td>
                    <StateWord state={a.state} />
                  </td>
                </tr>,
              ];
              if (expanded) {
                for (const id of a.taskIds) {
                  const t = task.get(id);
                  rows.push(
                    <tr key={`${a.key}/${id}`} className={s.subRow}>
                      <td />
                      <td colSpan={4}>
                        <button
                          type="button"
                          className={s.rowLink}
                          onClick={() => inspect('task', id)}
                        >
                          {t?.title ?? id}
                        </button>
                      </td>
                      <td>{t && <StateWord state={t.state} />}</td>
                    </tr>,
                  );
                }
                if (finished)
                  rows.push(
                    <tr key={`${a.key}/rerun`} className={s.subRow}>
                      <td />
                      <td colSpan={5}>
                        <Button kind="secondary" onClick={() => rerunAll(a.title, a.taskIds)}>
                          Re-run all finished…
                        </Button>
                      </td>
                    </tr>,
                  );
              }
              return rows;
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className={s.empty}>
                  No activities here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
