/*
 * Engagement: every working day of the build, week by week; each phase as a span filled by how
 * much of it is done, in the hue of the team that owns it, with its Director gate; each activity
 * as a bar that opens its task; a marker at today.
 */
import type { ScheduleActivity, ScheduleSnapshot, TaskState } from '@lw/contracts';
import { useRef } from 'react';
import { shortDay, zoneLabel } from '../../lib/fmt';
import { useApp, useNow, useRoster } from '../../state';
import { hueOf, Panel } from '../../ui/cypher/parts';
import {
  at,
  vars,
  engagementAxis,
  ownerOf,
  PHASE_WORD,
  phaseState,
  plural,
  roleOf,
  shortHour,
  stateOf,
  WORK_HOURS,
} from './model';
import { GateMark, Glyph, Legend, Who } from './parts';
import { TaskBar } from './TaskBar';
import { useTimelineZoom, useWidth, ZoomControl } from './zoom';
import s from './plan.module.css';

/** Room an hour label needs inside a day before the day shows its hours. */
const TICK_ROOM_PX = 64;
const UNDER_WAY: TaskState[] = [
  'running',
  'validating',
  'waiting',
  'blocked',
  'paused',
  'rejected',
];

export function Engagement({
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
  const now = useNow(60_000);
  const scroll = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const { zoomTo } = useTimelineZoom(scroll, track, zoom, setZoom);
  const axis = engagementAxis(sched);
  const width = useWidth(track);
  const hourPx = width / axis.days / WORK_HOURS;
  const step = hourPx >= TICK_ROOM_PX ? 1 : hourPx * 2 >= TICK_ROOM_PX ? 2 : 0;
  const hourTicks = axis.hourTicks(step);
  const all = sched.phases.flatMap((p) => p.activities);
  const gates = sched.phases.filter((p) => p.gateAt && p.gateLabel);
  const nextGate = gates.find((p) => p.state !== 'done');
  const stateOfTask = new Map(sched.tasks.map((t) => [t.taskId, t.state]));
  const weeks = sched.days.flatMap((d, i) => (d.weekStart ? [(i / axis.days) * 100] : []));
  const weekLines = weeks.map((x) => (
    <i key={x} className={s.week} style={at(x)} aria-hidden="true" />
  ));

  /** The task an activity's bar opens: the one under way, else the next open one, else the last. */
  const taskOf = (a: ScheduleActivity) =>
    a.taskIds.find((id) => UNDER_WAY.includes(stateOfTask.get(id) ?? 'planned')) ??
    a.taskIds.find((id) => stateOfTask.get(id) !== 'done') ??
    a.taskIds.at(-1);

  return (
    <Panel
      title="Engagement"
      chips={
        <span className={`${s.summary} type-meta`}>
          {sched.days[0]?.label} to {sched.days.at(-1)?.label} · {zoneLabel(tz)} ·{' '}
          {plural(all.length, 'activity', 'activities')} in {sched.phases.length} phases ·{' '}
          {all.filter((a) => a.state === 'done').length} done
          {nextGate?.gateAt
            ? ` · ${nextGate.gateLabel?.split(':')[0]} ${shortDay(nextGate.gateAt, tz)}`
            : ''}
        </span>
      }
      meta={<ZoomControl zoom={zoom} set={zoomTo} />}
    >
      <div className={s.scroll} ref={scroll}>
        <div
          className={`${s.timeline} type-table`}
          data-view="engagement"
          data-hours={step ? true : undefined}
          style={vars({
            '--zoom': zoom,
            '--days': axis.days,
            '--cells': axis.days * axis.cellsPerDay(step),
          })}
        >
          <div className={s.head}>
            <div className={`${s.corner} type-label`}>Phase and activity</div>
            <div className={s.days} ref={track}>
              {sched.days.map((d, i) => (
                <span
                  key={d.date}
                  className={`${s.day} type-meta`}
                  data-today={d.today || undefined}
                  data-week={d.weekStart || undefined}
                  style={at((i / axis.days) * 100, 100 / axis.days)}
                >
                  {d.label}
                  {d.today ? ', today' : ''}
                </span>
              ))}
              {hourTicks.map((t) => (
                <span key={t.key} className={`${s.hour} type-meta`} style={at(t.x)}>
                  {shortHour(t.h)}
                </span>
              ))}
            </div>
          </div>
          <div className={s.body}>
            {sched.phases.map((p) => {
              const st = phaseState(p.activities);
              const done = p.activities.filter((a) => a.state === 'done').length;
              const hue = hueOf(ownerOf(p.activities, byId));
              const x0 = p.start ? axis.x(p.start) : 0;
              return (
                <div key={p.phase} role="group" aria-label={`${p.phase}. ${p.name}`}>
                  <div className={s.row} data-phase>
                    <div className={s.name}>
                      <span className={s.nameText}>
                        <b>
                          {p.phase}. {p.name}
                        </b>
                        <span className="type-meta">
                          {plural(p.activities.length, 'activity', 'activities')} ·{' '}
                          <span className={s.phaseWord} data-state={st}>
                            {PHASE_WORD[st]}
                          </span>
                        </span>
                      </span>
                    </div>
                    <div className={s.track}>
                      {weekLines}
                      {p.start && p.end && (
                        <span
                          className={s.span}
                          style={at(x0, axis.x(p.end) - x0, {
                            '--hue': hue,
                            '--done': p.activities.length ? (done / p.activities.length) * 100 : 0,
                          })}
                          aria-hidden="true"
                        >
                          <i />
                        </span>
                      )}
                      {p.gateAt && p.gateLabel && (
                        <GateMark label={p.gateLabel} x={axis.x(p.gateAt)} />
                      )}
                    </div>
                  </div>
                  {p.activities.map((a) => {
                    const who = byId(a.agentId);
                    const { word, look } = stateOf(a.state);
                    const x = axis.x(a.start);
                    const id = taskOf(a);
                    const name = who?.persona ?? a.agentId;
                    return (
                      <div className={s.row} key={a.key}>
                        <div className={s.name} data-sub>
                          <Who agent={who} id={a.agentId} size="xs" />
                          <span className={s.nameText}>
                            <span className={s.activityTitle}>{a.title}</span>
                            <span className="type-meta">
                              {name}, {roleOf(who)}
                            </span>
                          </span>
                          <span className={s.nameState} data-look={look} title={word}>
                            <Glyph look={look} />
                            <span className="sr-only">{word}</span>
                          </span>
                        </div>
                        <div className={s.track}>
                          {weekLines}
                          <TaskBar
                            thin
                            x={x}
                            w={axis.x(a.end) - x}
                            look={look}
                            hue={hueOf(who?.workstream)}
                            text={a.title}
                            label={`${a.title}, ${name}, ${shortDay(a.start, tz)} to ${shortDay(a.end, tz)}, ${word}${a.taskIds.length > 1 ? `, ${a.taskIds.length} tasks` : ''}`}
                            onOpen={() => (id ? inspect('task', id) : inspect('agent', a.agentId))}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <span className={s.nowLine} style={at(axis.x(now))} aria-hidden="true" />
          </div>
        </div>
      </div>
      <div className={s.foot}>
        <Legend now={false} />
        <span className={`${s.todayKey} type-meta`}>
          <span className={s.nowKey} aria-hidden="true" />
          Today
        </span>
      </div>
    </Panel>
  );
}
