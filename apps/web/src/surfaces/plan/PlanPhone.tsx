/*
 * Plan on a phone (640px and under): the timelines become an agenda. Today groups the day's
 * tasks by what they are doing; Engagement folds each phase open to its activities and gate.
 */
import type { ScheduleSnapshot, ScheduledTask, TaskState } from '@lw/contracts';
import { useState } from 'react';
import { clock, shortDay, zoneLabel } from '../../lib/fmt';
import { useApp, useRoster } from '../../state';
import { Icon } from '../../theme/icons';
import { Panel } from '../../ui/cypher/parts';
import { byStart, PHASE_WORD, phaseState, plural, todayAxis } from './model';
import { StateWord, Who } from './parts';
import s from './plan.module.css';

const GROUPS: [string, TaskState[]][] = [
  ['Running now', ['running', 'validating']],
  ['Waiting', ['waiting', 'blocked']],
  ['Up next', ['planned', 'ready']],
  ['Done today', ['done']],
];

export function PlanPhone({
  s: sched,
  view,
}: {
  s: ScheduleSnapshot;
  view: 'today' | 'engagement';
}) {
  const { inspect } = useApp();
  const { byId } = useRoster();
  const tz = sched.timezone;
  const axis = todayAxis(sched);
  const todays = sched.tasks.filter(
    (t) => Date.parse(t.end) > axis.from && Date.parse(t.start) < axis.to,
  );
  const [shut, setShut] = useState<ReadonlySet<number>>(new Set());
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());

  const row = (t: ScheduledTask) => {
    const a = byId(t.agentId);
    return (
      <button
        type="button"
        key={t.taskId}
        className={`${s.agendaRow} type-table`}
        onClick={() => inspect('task', t.taskId)}
      >
        <span className={`${s.agendaTime} type-meta`}>{clock(t.start, tz)}</span>
        <span className={s.nameText}>
          <b>{t.title}</b>
          <span className={`${s.agendaWho} type-meta`}>
            <Who agent={a} id={t.agentId} size="xs" />
            {a?.persona ?? t.agentId}
          </span>
        </span>
        <StateWord state={t.state} gaps={t.gaps} />
      </button>
    );
  };

  if (view === 'today')
    return (
      <div className={s.phone}>
        <p className={`${s.phoneSum} type-meta`}>
          {sched.today.label} · {zoneLabel(tz)}
        </p>
        {GROUPS.map(([title, states]) => {
          const list = byStart(todays.filter((t) => states.includes(t.state)));
          return list.length ? (
            <Panel key={title} title={title} meta={String(list.length)}>
              {list.map(row)}
            </Panel>
          ) : null;
        })}
        {todays.length === 0 && (
          <p className={`${s.empty} type-body-small`}>Nothing is scheduled today.</p>
        )}
      </div>
    );

  return (
    <div className={s.phone}>
      {sched.phases.map((p) => {
        const st = phaseState(p.activities);
        const isOpen = st === 'running' ? !shut.has(p.phase) : opened.has(p.phase);
        const flip = () =>
          (st === 'running' ? setShut : setOpened)((was) => {
            const next = new Set(was);
            if (!next.delete(p.phase)) next.add(p.phase);
            return next;
          });
        const from = p.start ? shortDay(p.start, tz) : '';
        const to = p.end ? shortDay(p.end, tz) : '';
        return (
          <section key={p.phase} className={s.phase} aria-label={`${p.phase}. ${p.name}`}>
            <button
              type="button"
              className={`${s.phaseHead} type-table`}
              aria-expanded={isOpen}
              onClick={flip}
            >
              <span className={s.nameText}>
                <b>
                  {p.phase}. {p.name}
                </b>
                <span className="type-meta">
                  {from}
                  {to && to !== from ? ` to ${to}` : ''}
                  {from ? ' · ' : ''}
                  {plural(p.activities.length, 'activity', 'activities')}
                </span>
              </span>
              <span className={`${s.phaseWord} type-meta`} data-state={st}>
                {PHASE_WORD[st]}
              </span>
              <Icon name="chevron" size={18} className={s.foldIcon} />
            </button>
            {isOpen && (
              <div>
                {p.activities.map((a) => {
                  const who = byId(a.agentId);
                  return (
                    <button
                      type="button"
                      key={a.key}
                      className={`${s.agendaRow} type-table`}
                      onClick={() =>
                        a.taskIds[0] ? inspect('task', a.taskIds[0]) : inspect('agent', a.agentId)
                      }
                    >
                      <span className={s.nameText}>
                        <b>{a.title}</b>
                        <span className={`${s.agendaWho} type-meta`}>
                          <Who agent={who} id={a.agentId} size="xs" />
                          {who?.persona ?? a.agentId}
                        </span>
                      </span>
                      <StateWord state={a.state} />
                    </button>
                  );
                })}
                {p.gateLabel && (
                  <div className={`${s.gateRow} type-meta`}>
                    <span className={s.gateKey} aria-hidden="true" />
                    {p.gateLabel}
                    {p.gateAt ? ` · ${shortDay(p.gateAt, tz)}` : ''}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
