/*
 * Today: one lane per workstream, one row per agent, the day's tasks on an hour axis with the now
 * line, opened scrolled to now. Under it, what is up next and what each waits for.
 */
import type { ScheduleSnapshot, ScheduledTask } from '@lw/contracts';
import { useEffect, useRef } from 'react';
import { clock, localDate, shortDay, zoneLabel } from '../../lib/fmt';
import { useApp, useNow, useRoster } from '../../state';
import { hueOf, Panel } from '../../ui/cypher/parts';
import {
  at,
  byStart,
  hourLabel,
  hueVar,
  LANES,
  plural,
  roleOf,
  stateOf,
  todayAxis,
  vars,
} from './model';
import { Glyph, Legend, StateWord, Who } from './parts';
import { TaskBar } from './TaskBar';
import { useTimelineZoom, useWidth, ZoomControl } from './zoom';
import s from './plan.module.css';

/** Room an hour label needs before half and quarter hours are marked too. */
const TICK_ROOM_PX = 110;
const OPEN = ['planned', 'ready', 'waiting'];

export function Today({
  s: sched,
  zoom,
  setZoom,
}: {
  s: ScheduleSnapshot;
  zoom: number;
  setZoom: (z: number) => void;
}) {
  const { inspect } = useApp();
  const { byId } = useRoster();
  const tz = sched.timezone;
  const now = useNow(30_000);
  const scroll = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const { zoomTo, reveal } = useTimelineZoom(scroll, track, zoom, setZoom);
  const axis = todayAxis(sched);
  const width = useWidth(track);
  const hourPx = width / axis.hours;
  const step = hourPx / 4 >= TICK_ROOM_PX ? 0.25 : hourPx / 2 >= TICK_ROOM_PX ? 0.5 : 1;
  const todays = sched.tasks.filter(
    (t) => Date.parse(t.end) > axis.from && Date.parse(t.start) < axis.to,
  );
  const nowIn = now >= axis.from && now <= axis.to;

  useEffect(() => {
    // Once, when the view opens: bring now into view.
    if (nowIn) reveal(axis.x(now));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lanes = LANES.map(([lane, label]) => {
    const tasks = todays.filter((t) => (t.workstream ?? byId(t.agentId)?.workstream) === lane);
    const ids = [...new Set(tasks.map((t) => t.agentId))];
    return { lane, label, tasks, ids, active: tasks.filter((t) => t.state === 'running').length };
  })
    .filter((l) => l.ids.length)
    .sort((a, b) => b.active - a.active || b.tasks.length - a.tasks.length);

  const running = todays.filter((t) => t.state === 'running').length;
  const left = todays.filter((t) => OPEN.includes(t.state)).length;
  const done = todays.filter((t) => t.state === 'done').length;
  const agents = new Set(todays.map((t) => t.agentId)).size;
  const upcoming = byStart(sched.tasks.filter((t) => OPEN.includes(t.state))).slice(0, 6);
  const task = new Map(sched.tasks.map((t) => [t.taskId, t]));
  const when = (t: string) =>
    localDate(t, tz) === localDate(now, tz) ? clock(t, tz) : shortDay(t, tz);
  const barLabel = (t: ScheduledTask) =>
    `${t.title}, ${clock(t.start, tz)} to ${clock(t.end, tz)}, ${stateOf(t.state).word}${t.basis === 'forecast' ? ' (forecast)' : ''}`;

  return (
    <>
      <Panel
        title="Today"
        chips={
          <span className={`${s.summary} type-meta`}>
            {sched.today.label} · {zoneLabel(tz)} ·{' '}
            {plural(todays.length, 'activity', 'activities')}, {plural(agents, 'agent', 'agents')} ·{' '}
            {done} done · {running} running · {left} to go
          </span>
        }
        meta={<ZoomControl zoom={zoom} set={zoomTo} />}
      >
        <div className={s.scroll} ref={scroll}>
          <div
            className={`${s.timeline} type-table`}
            data-view="today"
            style={vars({ '--zoom': zoom, '--cells': axis.hours / step })}
          >
            <div className={s.head}>
              <div className={`${s.corner} type-label`}>Agent</div>
              <div className={s.ticks} ref={track}>
                {axis.ticks(step).map((t, i) => {
                  const into = (i * step) % 1;
                  return (
                    <span
                      key={t}
                      className={`${s.tick} type-meta`}
                      data-minor={into ? true : undefined}
                      data-first={i === 0 || undefined}
                      style={at(axis.x(t))}
                    >
                      {into
                        ? `:${String(Math.round(into * 60)).padStart(2, '0')}`
                        : hourLabel(t, tz)}
                    </span>
                  );
                })}
                {nowIn && (
                  <span className={`${s.nowTag} type-meta`} style={at(axis.x(now))}>
                    Now {clock(now, tz)}
                  </span>
                )}
              </div>
            </div>
            <div className={s.body}>
              {lanes.map((l) => (
                <div key={l.lane} role="group" aria-label={l.label}>
                  <div className={s.laneHead}>
                    <span className={s.laneLabel}>
                      <i style={hueVar(hueOf(l.lane))} aria-hidden="true" />
                      <span className="type-label">{l.label}</span>
                      <span className="type-meta">
                        {plural(l.tasks.length, 'activity', 'activities')}
                        {l.active ? ` · ${l.active} running` : ''}
                      </span>
                    </span>
                  </div>
                  {l.ids.map((id) => {
                    const a = byId(id);
                    const mine = l.tasks.filter((t) => t.agentId === id);
                    return (
                      <div className={s.row} key={id}>
                        <button
                          type="button"
                          className={s.name}
                          onClick={() => inspect('agent', id)}
                        >
                          <Who agent={a} id={id} />
                          <span className={s.nameText}>
                            <b>{a?.persona ?? id}</b>
                            <span className="type-meta">{roleOf(a)}</span>
                          </span>
                          <span className={`${s.nameCount} type-meta`}>
                            {mine.filter((t) => t.state === 'done').length} of {mine.length} done
                          </span>
                        </button>
                        <div className={s.track}>
                          {mine.map((t) => {
                            const x = axis.x(t.start);
                            return (
                              <TaskBar
                                key={t.taskId}
                                x={x}
                                w={axis.x(t.end) - x}
                                look={stateOf(t.state).look}
                                hue={hueOf(t.workstream ?? a?.workstream)}
                                text={t.title}
                                label={barLabel(t)}
                                onOpen={() => inspect('task', t.taskId)}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
              {lanes.length === 0 && (
                <p className={`${s.empty} type-body-small`}>Nothing is scheduled today.</p>
              )}
              {nowIn && <span className={s.nowLine} style={at(axis.x(now))} aria-hidden="true" />}
            </div>
          </div>
        </div>
        <div className={s.foot}>
          <Legend gate={false} />
        </div>
      </Panel>

      <Panel title="Up next and what each waits for">
        {upcoming.length ? (
          <div className={s.tableWrap}>
            <table className={`${s.table} type-table`}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Activity</th>
                  <th>Owner</th>
                  <th>Waits for</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((t) => {
                  const a = byId(t.agentId);
                  return (
                    <tr key={t.taskId}>
                      <td className={s.when}>{when(t.start)}</td>
                      <td>
                        <button
                          type="button"
                          className={s.rowLink}
                          onClick={() => inspect('task', t.taskId)}
                        >
                          {t.title}
                        </button>
                      </td>
                      <td>
                        <span className={s.ownerPlain}>
                          <Who agent={a} id={t.agentId} size="xs" />
                          {a?.persona ?? t.agentId}
                        </span>
                      </td>
                      <td>
                        {t.dependsOn.length ? (
                          <span className={s.deps}>
                            {t.dependsOn.map((d) => {
                              const dep = task.get(d);
                              return (
                                <button
                                  key={d}
                                  type="button"
                                  className={s.dep}
                                  onClick={() => inspect('task', d)}
                                  aria-label={`${dep?.title ?? d}, ${dep ? stateOf(dep.state).word : 'unknown'}`}
                                >
                                  {dep && (
                                    <span
                                      className={s.depGlyph}
                                      data-look={stateOf(dep.state).look}
                                    >
                                      <Glyph look={stateOf(dep.state).look} />
                                    </span>
                                  )}
                                  {dep?.title ?? d}
                                </button>
                              );
                            })}
                          </span>
                        ) : (
                          <span className={s.quietText}>Its start time</span>
                        )}
                      </td>
                      <td>
                        <StateWord state={t.state} gaps={t.gaps} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={`${s.empty} type-body-small`}>Nothing is queued.</p>
        )}
      </Panel>
    </>
  );
}
