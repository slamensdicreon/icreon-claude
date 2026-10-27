import type { ScheduleActivity, ScheduledTask, ScheduleSnapshot } from '@lw/contracts';
import { useEffect, useRef, useState } from 'react';
import { clock, localDate, shortDay } from '../lib/fmt';
import { AgentCell, Chip } from '../parts/bits';
import { useApp, useNow, useProjectResource, useRoster } from '../state';

const LANES: [string, string][] = [
  ['engineering', 'Engineering'],
  ['quality', 'Quality'],
  ['discovery', 'Discovery'],
  ['content', 'Content'],
];

const hourOf = (t: string | number, tz: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(t));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h + m / 60;
};

function useIsPhone() {
  const [phone, setPhone] = useState(() => matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const mq = matchMedia('(max-width: 640px)');
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

const Legend = () => (
  <div className="legend">
    <span>
      <i style={{ background: 'var(--web-surface-3)', borderColor: 'var(--web-surface-3)' }} />
      Done
    </span>
    <span>
      <i style={{ background: 'var(--info-bg)', borderColor: 'var(--web-accent)' }} />
      Running
    </span>
    <span>
      <i style={{ borderColor: 'var(--web-fg-2)' }} />
      Ready
    </span>
    <span>
      <i style={{ borderStyle: 'dashed' }} />
      Planned
    </span>
    <span>
      <i style={{ background: 'var(--warning-bg)', borderColor: 'var(--warning)' }} />
      Waiting
    </span>
    <span>
      <i style={{ background: 'var(--danger-bg)', borderColor: 'var(--danger)' }} />
      Blocked
    </span>
    <span>
      <b className="gd" />
      Director gate
    </span>
  </div>
);

const ViewTabs = ({ v }: { v: string }) => {
  const { setUi } = useApp();
  return (
    <div className="seg" role="group" aria-label="Plan view">
      {(
        [
          ['today', 'Today'],
          ['engagement', 'Engagement'],
          ['list', 'Activity list'],
        ] as const
      ).map(([k, t]) => (
        <button key={k} aria-pressed={v === k} onClick={() => setUi({ planView: k })}>
          {t}
        </button>
      ))}
    </div>
  );
};

const barClass = (state: string) =>
  ({ validating: 'running', rejected: 'waiting', rolled_back: 'planned', cancelled: 'planned' })[
    state
  ] ?? state;

export function Plan() {
  const { ui } = useApp();
  const sched = useProjectResource<ScheduleSnapshot>('/schedule').data;
  const phone = useIsPhone();
  const v = ui.planView;
  if (!sched) return <p className="quiet-line">Loading the plan…</p>;
  if (phone && v !== 'list') return <PlanPhone s={sched} v={v} />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Plan</h1>
          <p>
            What every agent is doing, when, and what it waits for. Select a task or an agent for
            detail.
          </p>
        </div>
        <ViewTabs v={v} />
      </div>
      {v === 'today' ? (
        <Today s={sched} />
      ) : v === 'engagement' ? (
        <Engagement s={sched} />
      ) : (
        <List s={sched} />
      )}
    </>
  );
}

function Today({ s }: { s: ScheduleSnapshot }) {
  const { inspect } = useApp();
  const { byId } = useRoster();
  const tz = s.timezone;
  const now = useNow(30_000);
  const scroll = useRef<HTMLDivElement>(null);
  const from = Date.parse(s.today.from);
  const to = Date.parse(s.today.to);
  const X = (t: number) => Math.max(0, Math.min(100, ((t - from) / (to - from)) * 100));
  const todays = s.tasks.filter((t) => Date.parse(t.end) > from && Date.parse(t.start) < to);
  const nowIn = now >= from && now <= to;
  const hours = Array.from({ length: 13 }, (_, i) => 8 + i);

  useEffect(() => {
    const el = scroll.current;
    if (el && nowIn)
      el.scrollLeft = Math.max(
        0,
        200 + ((el.scrollWidth - 224) * X(now)) / 100 - el.clientWidth / 3,
      );
    // Once, when the view opens.
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
  const left = todays.filter((t) => ['planned', 'ready', 'waiting'].includes(t.state)).length;
  const done = todays.filter((t) => t.state === 'done').length;
  const upcoming = s.tasks
    .filter((t) => ['planned', 'ready', 'waiting'].includes(t.state))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 6);
  const title = (id: string) => s.tasks.find((t) => t.taskId === id)?.title ?? id;

  return (
    <>
      <p className="plan-sum">
        {s.today.label}, {tz === 'America/New_York' ? 'Eastern Time' : tz}. {todays.length}{' '}
        activities across {new Set(todays.map((t) => t.agentId)).size} agents: {done} done,{' '}
        {running} running, {left} to go.
      </p>
      <div className="plan-scroll" ref={scroll}>
        <div className="plan pl-today">
          <div className="pl-head">
            <div />
            <div className="pl-ticks">
              {hours.map((h) => (
                <span key={h} style={{ left: `${((h - 8) / 12) * 100}%` }}>
                  {h % 12 || 12} {h < 12 ? 'AM' : 'PM'}
                </span>
              ))}
              {nowIn && (
                <span className="now-tag" style={{ left: `${X(now)}%` }}>
                  Now {clock(now, tz)}
                </span>
              )}
            </div>
          </div>
          {lanes.map((l) => (
            <div key={l.lane}>
              <div className="pg-group">
                <span>{l.label}</span>
              </div>
              {l.ids.map((id) => {
                const a = byId(id);
                const mine = l.tasks.filter((t) => t.agentId === id);
                return (
                  <div className="pl-row" key={id}>
                    <button className="pl-name" onClick={() => inspect('agent', id)}>
                      <b>{a?.persona ?? id}</b>
                      <small>
                        {a?.name} · {mine.filter((t) => t.state === 'done').length} of {mine.length}{' '}
                        done
                      </small>
                    </button>
                    <div className="pl-track">
                      {mine.map((t) => (
                        <button
                          key={t.taskId}
                          className={`task ${barClass(t.state)}`}
                          style={{
                            left: `${X(Date.parse(t.start))}%`,
                            width: `calc(${X(Date.parse(t.end)) - X(Date.parse(t.start))}% - 3px)`,
                          }}
                          title={`${t.title}, ${clock(t.start, tz)} to ${clock(t.end, tz)}, ${t.state}${t.basis === 'forecast' ? ' (forecast)' : ''}`}
                          onClick={() => inspect('task', t.taskId)}
                        >
                          {t.title}
                        </button>
                      ))}
                      {nowIn && <div className="now-line" style={{ left: `${X(now)}%` }} />}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <Legend />
      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>Up next and what each waits for</h2>
        </div>
        {upcoming.length ? (
          upcoming.map((t) => (
            <div className="event" key={t.taskId}>
              <time>
                {localDate(t.start, tz) === localDate(now, tz)
                  ? clock(t.start, tz)
                  : shortDay(t.start, tz)}
              </time>
              <span>
                <b style={{ fontWeight: 500 }}>{t.title}</b> waits for{' '}
                {t.dependsOn.length ? t.dependsOn.map(title).join(' and ') : 'its start time'}.
              </span>
            </div>
          ))
        ) : (
          <p className="quiet-line">Nothing is queued.</p>
        )}
      </section>
    </>
  );
}

/** Position on the engagement axis: day index plus the fraction of the working day (8–18). */
function useAxis(s: ScheduleSnapshot) {
  const tz = s.timezone;
  const index = new Map(s.days.map((d, i) => [d.date, i]));
  const n = s.days.length || 1;
  return (t: string | number) => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(t));
    let i = index.get(date);
    if (i === undefined) i = date < (s.days[0]?.date ?? '') ? 0 : n - 1;
    const h = Math.max(8, Math.min(18, hourOf(t, tz)));
    return ((i + (h - 8) / 10) / n) * 100;
  };
}

const phaseState = (a: ScheduleActivity[]) =>
  a.every((x) => x.state === 'done')
    ? 'done'
    : a.some((x) => ['running', 'waiting', 'blocked'].includes(x.state))
      ? 'running'
      : 'planned';

function Engagement({ s }: { s: ScheduleSnapshot }) {
  const { byId } = useRoster();
  const tz = s.timezone;
  const now = useNow(60_000);
  const X = useAxis(s);
  const N = s.days.length;
  const all = s.phases.flatMap((p) => p.activities);
  const gates = s.phases.filter((p) => p.gateAt && p.gateLabel);
  const nextGate = gates.find((p) => p.state !== 'done');
  const grid = s.days.map((d, i) => (
    <i key={d.date} style={{ left: `${(i / N) * 100}%` }} className={d.weekStart ? 'wk' : ''} />
  ));
  const todayFrac = X(now) / 100;
  return (
    <>
      <p className="plan-sum">
        {s.days[0]?.label} to {s.days.at(-1)?.label},{' '}
        {tz === 'America/New_York' ? 'Eastern Time' : tz}. {all.length} activities in{' '}
        {s.phases.length} phases. {all.filter((a) => a.state === 'done').length} done.
        {nextGate?.gateAt
          ? ` ${nextGate.gateLabel?.split(':')[0]} is planned for ${shortDay(nextGate.gateAt, tz)}.`
          : ''}
      </p>
      <div className="plan-scroll">
        <div className="plan pl-eng">
          <div className="eg-head">
            <div />
            <div className="eg-days">
              {s.days.map((d, i) => (
                <span
                  key={d.date}
                  className={d.today ? 'today' : ''}
                  style={{ left: `${(i / N) * 100}%`, width: `${100 / N}%` }}
                >
                  {d.label}
                  {d.today ? ', today' : ''}
                </span>
              ))}
            </div>
          </div>
          <div className="eg-body">
            {s.phases.map((p) => (
              <div key={p.phase}>
                <div className="eg-row ph">
                  <div className="eg-name">
                    <b>
                      {p.phase}. {p.name}
                    </b>
                    <small>
                      {p.activities.length} {p.activities.length === 1 ? 'activity' : 'activities'}
                    </small>
                  </div>
                  <div className="eg-track">
                    {grid}
                    {p.start && p.end && (
                      <span
                        className={`eg-span ${phaseState(p.activities)}`}
                        style={{
                          left: `${X(p.start)}%`,
                          width: `${Math.max(0.6, X(p.end) - X(p.start))}%`,
                        }}
                      />
                    )}
                    {p.gateAt && (
                      <span
                        className="gate-d"
                        style={{ left: `${X(p.gateAt)}%` }}
                        title={p.gateLabel ?? ''}
                      />
                    )}
                  </div>
                </div>
                {p.activities.map((a) => {
                  const who = byId(a.agentId);
                  return (
                    <div className="eg-row" key={a.key}>
                      <div className="eg-name sub">
                        <span>{a.title}</span>
                        <small>
                          {who?.persona ?? a.agentId},{' '}
                          {who?.tier === 'chief_of_staff' ? 'Chief of Staff' : who?.name}
                        </small>
                      </div>
                      <div className="eg-track">
                        {grid}
                        <span
                          className={`task ${barClass(a.state)}`}
                          style={{
                            left: `${X(a.start)}%`,
                            width: `calc(${Math.max(0.6, X(a.end) - X(a.start))}% - 2px)`,
                          }}
                          title={`${a.title}, ${who?.name ?? ''}, ${a.state}`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            <div
              className="eg-now"
              style={{ left: `calc(300px + (100% - 300px) * ${todayFrac})` }}
            />
          </div>
        </div>
      </div>
      <Legend />
    </>
  );
}

function List({ s }: { s: ScheduleSnapshot }) {
  const { ui, setUi, inspect } = useApp();
  const tz = s.timezone;
  const titles = new Map(s.tasks.map((t) => [t.taskId, t.title]));
  const all = s.phases.flatMap((p) =>
    p.activities.map((a) => ({ ...a, phase: p.phase, phaseName: p.name })),
  );
  const pf = ui.planFilter;
  const match = (a: { state: string }, k: string) =>
    k === 'all'
      ? true
      : k === 'open'
        ? a.state !== 'done'
        : k === 'running'
          ? ['running', 'validating'].includes(a.state)
          : a.state === k;
  const count = (k: string) => all.filter((a) => match(a, k)).length;
  const fmt = (t: string) => `${shortDay(t, tz)}, ${clock(t, tz)}`;
  return (
    <>
      <div className="act-tools">
        <div className="filters">
          {(
            [
              ['all', `All ${all.length}`],
              ['open', `Open ${count('open')}`],
              ['running', `Running ${count('running')}`],
              ['waiting', `Waiting ${count('waiting')}`],
              ['done', `Done ${count('done')}`],
            ] as const
          ).map(([k, t]) => (
            <button key={k} aria-pressed={pf === k} onClick={() => setUi({ planFilter: k })}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="act-wrap">
        <div className="act-scroll" style={{ maxHeight: 'none' }}>
          <table className="pl-list">
            <thead>
              <tr>
                <th>Phase</th>
                <th>Activity</th>
                <th>Owner</th>
                <th>Start</th>
                <th>Finish</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {all
                .filter((a) => match(a, pf))
                .map((a) => (
                  <tr key={a.key}>
                    <td className="muted">
                      {a.phase}. {a.phaseName}
                    </td>
                    <td>
                      {a.taskIds.length === 1 ? (
                        <button className="link-btn" onClick={() => inspect('task', a.taskIds[0]!)}>
                          {a.title}
                        </button>
                      ) : (
                        <details>
                          <summary>
                            {a.title} <span className="muted">({a.taskIds.length} tasks)</span>
                          </summary>
                          {a.taskIds.map((id) => (
                            <button
                              key={id}
                              className="link-btn"
                              style={{ display: 'block' }}
                              onClick={() => inspect('task', id)}
                            >
                              {titles.get(id) ?? id}
                            </button>
                          ))}
                        </details>
                      )}
                    </td>
                    <td>
                      <AgentCell agentId={a.agentId} />
                    </td>
                    <td className="muted">{fmt(a.start)}</td>
                    <td className="muted">{fmt(a.end)}</td>
                    <td>
                      <Chip state={a.state} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function PlanPhone({ s, v }: { s: ScheduleSnapshot; v: string }) {
  const { inspect } = useApp();
  const { byId } = useRoster();
  const tz = s.timezone;
  const from = Date.parse(s.today.from);
  const to = Date.parse(s.today.to);
  const todays = s.tasks.filter((t) => Date.parse(t.end) > from && Date.parse(t.start) < to);
  const row = (t: ScheduledTask) => {
    const a = byId(t.agentId);
    return (
      <button className="ag-row" key={t.taskId} onClick={() => inspect('task', t.taskId)}>
        <span className="ag-t">{clock(t.start, tz)}</span>
        <span className="ag-m">
          <b>{t.title}</b>
          <small>
            {a?.persona}, {a?.name}
          </small>
        </span>
        <Chip state={t.state} />
      </button>
    );
  };
  const sec = (title: string, list: ScheduledTask[]) =>
    list.length ? (
      <section className="ag" key={title}>
        <h2>
          {title} <small>{list.length}</small>
        </h2>
        {list.sort((a, b) => a.start.localeCompare(b.start)).map(row)}
      </section>
    ) : null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Plan</h1>
          <p>What every agent is doing and what comes next. Select any item for detail.</p>
        </div>
        <ViewTabs v={v} />
      </div>
      {v === 'today' ? (
        <>
          <p className="plan-sum">{s.today.label}.</p>
          {sec(
            'Running now',
            todays.filter((t) => t.state === 'running' || t.state === 'validating'),
          )}
          {sec(
            'Waiting',
            todays.filter((t) => t.state === 'waiting' || t.state === 'blocked'),
          )}
          {sec(
            'Up next',
            todays.filter((t) => t.state === 'planned' || t.state === 'ready'),
          )}
          {sec(
            'Done today',
            todays.filter((t) => t.state === 'done'),
          )}
        </>
      ) : (
        s.phases.map((p) => {
          const st = phaseState(p.activities);
          return (
            <details className="ph-d" key={p.phase} open={st === 'running'}>
              <summary>
                <span className="ph-n">
                  <b>
                    {p.phase}. {p.name}
                  </b>
                  <small>
                    {p.start ? shortDay(p.start, tz) : ''}
                    {p.end && p.start && shortDay(p.end, tz) !== shortDay(p.start, tz)
                      ? ` to ${shortDay(p.end, tz)}`
                      : ''}{' '}
                    · {p.activities.length} {p.activities.length === 1 ? 'activity' : 'activities'}
                  </small>
                </span>
                <Chip state={st} />
              </summary>
              {p.activities.map((a) => {
                const who = byId(a.agentId);
                return (
                  <div className="ph-a" key={a.key}>
                    <span className="ag-m">
                      <b>{a.title}</b>
                      <small>
                        {who?.persona}, {who?.name}
                      </small>
                    </span>
                    <Chip state={a.state} />
                  </div>
                );
              })}
              {p.gateLabel && (
                <div className="ph-g">
                  <b className="gd" />
                  {p.gateLabel}
                </div>
              )}
            </details>
          );
        })
      )}
    </>
  );
}
