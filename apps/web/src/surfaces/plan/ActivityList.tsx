/*
 * Plan, Everything face: the activity list is the plan. Every activity of the engagement, grouped
 * by phase (or by owner, or by status), filtered (remembered as `ui.planFilter`) and searchable.
 * Each row says what the activity is on or waits on, who owns it, when it ends or starts, and where
 * its window sits on the engagement, with a line for now. A decision of the Director's shows on the
 * row it holds. Finished phases fold to one line; the Director's gates sit in the list where they
 * fall. An activity of several tasks folds open to them, and can send every finished one back for
 * a fresh attempt. Any activity, task or owner opens the inspector.
 */
import type { EscalationView, ScheduledTask, ScheduleSnapshot } from '@lw/contracts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { post } from '../../lib/api';
import { shortDay } from '../../lib/fmt';
import { TextForm } from '../../overlays/Dialogs';
import { useApp, useMission, useNow, useRoster } from '../../state';
import { Icon } from '../../theme/icons';
import { useYoursActions } from '../../ui/cypher/cards';
import { Button, Chips, hueOf } from '../../ui/cypher/parts';
import {
  activitiesOf,
  currentTask,
  holdsOf,
  isForecast,
  isHeld,
  isMoving,
  isOpen,
  moment,
  ownerOf,
  plural,
  progressOf,
  roleOf,
  stateOf,
  vars,
  waitingOn,
  whenOf,
  windowAxis,
  type Activity,
} from './model';
import { Glyph, Owner, StateWord, Who } from './parts';
import s from './plan.module.css';

type Filter = 'open' | 'yours' | 'running' | 'done' | 'all';
type Group = 'phase' | 'owner' | 'status';
type Holds = ReadonlyMap<string, EscalationView[]>;
type Tasks = ReadonlyMap<string, ScheduledTask>;

const GROUPS: { value: Group; label: string }[] = [
  { value: 'phase', label: 'Phase' },
  { value: 'owner', label: 'Owner' },
  { value: 'status', label: 'Status' },
];

/** Progress pips stop here; a longer group says its count in words only. */
const MAX_PIPS = 12;

interface Section {
  key: string;
  id?: string;
  head: ReactNode;
  rows: Activity[];
  folded?: boolean;
  after?: ReactNode;
  /** Draw the now line before the first row that starts after now. */
  nowLine?: boolean;
}

export function ActivityList({ s: sched }: { s: ScheduleSnapshot }) {
  const { ui, setUi, projectId } = useApp();
  const { byId } = useRoster();
  const mc = useMission().data;
  const now = useNow(60_000);
  const tz = sched.timezone;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set());
  const list = useRef<HTMLDivElement>(null);

  const all = useMemo(() => activitiesOf(sched), [sched]);
  const tasks: Tasks = useMemo(() => new Map(sched.tasks.map((t) => [t.taskId, t])), [sched]);
  const holds = useMemo(() => holdsOf(all, mc?.waitingOnYou ?? []), [all, mc]);
  const x = useMemo(() => windowAxis(sched), [sched]);
  const nowX = x(now);
  const yours = (mc?.waitingOnYou ?? []).filter((c) => c.status === 'open').length;
  const act = useYoursActions(projectId ?? '', mc?.project.name ?? '');
  const openCard = (id: string) => act.open('inbox', { expanded: id });

  const FILTERS: { value: Filter; label: string; test: (a: Activity) => boolean }[] = [
    { value: 'open', label: 'Open', test: isOpen },
    { value: 'yours', label: 'Needs you', test: (a) => holds.has(a.key) },
    { value: 'running', label: 'Running', test: isMoving },
    { value: 'done', label: 'Done', test: (a) => !isOpen(a) },
    { value: 'all', label: 'All', test: () => true },
  ];
  const filter = FILTERS.find((f) => f.value === ui.planFilter) ?? FILTERS[0]!;
  const group: Group = GROUPS.some((g) => g.value === ui.planGroup) ? ui.planGroup : 'phase';
  const q = query.trim().toLowerCase();
  const found = (a: Activity) =>
    !q ||
    a.title.toLowerCase().includes(q) ||
    (byId(a.agentId)?.persona ?? '').toLowerCase().includes(q) ||
    a.taskIds.some((id) => tasks.get(id)?.title.toLowerCase().includes(q));
  const shown = all.filter((a) => filter.test(a) && found(a));

  // Bliss opened a row: show it (unfold its phase), bring it into view, mark it, once.
  const focus = ui.planFocus;
  useEffect(() => {
    if (!focus) return;
    const a = all.find((y) => y.key === focus);
    if (a && !isOpen(a) && !unfolded.has(a.phase)) {
      setUnfolded((was) => new Set(was).add(a.phase));
      return;
    }
    const row = list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focus)}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.dataset.flash = '';
      setTimeout(() => delete row.dataset.flash, 1800);
    }
    setUi({ planFocus: null });
  }, [focus, all, unfolded, setUi]);

  const toggle = (key: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const fold = (phase: number) =>
    setUnfolded((was) => {
      const next = new Set(was);
      if (!next.delete(phase)) next.add(phase);
      return next;
    });
  const jump = (phase: number) => {
    const p = sched.phases.find((y) => y.phase === phase);
    if (p?.state === 'done') {
      setUnfolded((was) => new Set(was).add(phase));
      if (filter.value === 'open') setUi({ planFilter: 'all' });
    }
    if (group !== 'phase') setUi({ planGroup: 'phase' });
    requestAnimationFrame(() =>
      document.getElementById(`plan-phase-${phase}`)?.scrollIntoView({ block: 'start' }),
    );
  };

  const sections: Section[] = [];
  if (group === 'phase') {
    for (const p of sched.phases) {
      const rows = shown.filter((a) => a.phase === p.phase);
      if (!rows.length) continue;
      const done = p.activities.filter((a) => a.state === 'done').length;
      const folded = p.state === 'done' && !unfolded.has(p.phase) && filter.value !== 'done' && !q;
      const first = p.activities.reduce(
        (m, a) => (a.start < m ? a.start : m),
        p.activities[0]!.start,
      );
      const last = p.activities.reduce((m, a) => (a.end > m ? a.end : m), p.activities[0]!.end);
      const head = (
        <>
          <span className={`${s.groupName} type-section`}>
            {p.phase}. {p.name}
          </span>
          <span
            className={s.mini}
            style={vars({ '--f': `${(done / p.activities.length) * 100}%` })}
          />
          <span className={`${s.quietText} type-meta`}>
            {done} of {p.activities.length} done · {shortDay(first, tz)} to {shortDay(last, tz)}
          </span>
        </>
      );
      sections.push({
        key: `p${p.phase}`,
        id: `plan-phase-${p.phase}`,
        head:
          p.state === 'done' ? (
            <button
              type="button"
              className={s.groupFold}
              aria-expanded={!folded}
              onClick={() => fold(p.phase)}
            >
              <Icon name="chevron" size={18} className={s.foldIcon} />
              {head}
            </button>
          ) : (
            <span className={s.groupHead}>{head}</span>
          ),
        rows,
        folded,
        nowLine: filter.value !== 'done',
        after: p.gateLabel && (
          <tr className={s.gateRow}>
            <td>
              <span
                className={s.diamond}
                data-done={p.state === 'done' || undefined}
                aria-hidden="true"
              />
            </td>
            <td colSpan={5}>
              <b>{p.gateLabel}</b>{' '}
              <span className={`${s.quietText} type-meta`}>
                {p.gateAt
                  ? `${p.state === 'done' ? 'Passed' : 'Due'} ${moment(p.gateAt, tz, now)}`
                  : p.state === 'done'
                    ? 'Passed'
                    : 'Yours, when the phase is ready'}
              </span>
            </td>
          </tr>
        ),
      });
    }
  } else if (group === 'owner') {
    const ids = [...new Set(shown.map((a) => a.agentId))];
    const moving = (id: string) => shown.filter((a) => a.agentId === id && isMoving(a)).length;
    ids.sort(
      (a, b) =>
        moving(b) - moving(a) || (byId(a)?.persona ?? a).localeCompare(byId(b)?.persona ?? b),
    );
    for (const id of ids) {
      const rows = shown
        .filter((a) => a.agentId === id)
        .sort((a, b) => a.start.localeCompare(b.start));
      const agent = byId(id);
      const toCome = rows.filter((a) => isOpen(a) && !isMoving(a)).length;
      sections.push({
        key: `o${id}`,
        head: (
          <span className={s.groupHead}>
            <Who agent={agent} id={id} size="xs" />
            <span className={`${s.groupName} type-section`}>
              {agent?.persona ?? agent?.name ?? id}
            </span>
            <span className={`${s.quietText} type-meta`}>
              {[roleOf(agent), `${moving(id)} running`, `${toCome} to come`]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        ),
        rows,
      });
    }
  } else {
    const BUCKETS: [string, (a: Activity) => boolean][] = [
      ['Needs you', (a) => holds.has(a.key)],
      ['Running', isMoving],
      ['Waiting', isHeld],
      ['Up next', isOpen],
      ['Done', () => true],
    ];
    const placed = new Set<string>();
    for (const [label, test] of BUCKETS) {
      const rows = shown
        .filter((a) => !placed.has(a.key) && test(a))
        .sort((a, b) => a.start.localeCompare(b.start));
      rows.forEach((a) => placed.add(a.key));
      if (rows.length)
        sections.push({
          key: `s${label}`,
          head: (
            <span className={s.groupHead}>
              <span className={`${s.groupName} type-section`}>{label}</span>
              <span className={`${s.quietText} type-meta`}>{rows.length}</span>
            </span>
          ),
          rows,
        });
    }
  }

  const donePhases = sched.phases.filter((p) => p.state === 'done');
  const doneCount = all.filter((a) => !isOpen(a)).length;
  let nowPlaced = false;

  return (
    <div className={s.everything}>
      <header className={s.head}>
        <p className={`${s.summary} type-body-small`}>
          <b>{plural(all.length, 'activity', 'activities')}</b> · {doneCount} done ·{' '}
          {all.filter(isMoving).length} running
          {yours > 0 && (
            <>
              {' '}
              ·{' '}
              <span className={s.yoursWord}>{plural(yours, 'decision', 'decisions')} for you</span>
            </>
          )}
          {sched.finishAt && <> · finishes ~{shortDay(sched.finishAt, tz)}</>}
        </p>
        <PhaseRail sched={sched} onJump={jump} />
      </header>

      <div className={s.toolbar}>
        <Chips<Filter>
          label="Show activities"
          value={filter.value}
          onChange={(v) => setUi({ planFilter: v })}
          options={FILTERS.map((f) => ({
            value: f.value,
            label: f.label,
            count: all.filter(f.test).length,
          }))}
        />
        <label className={s.search}>
          <Icon name="search" size={18} />
          <input
            className="type-body-small"
            type="search"
            placeholder="Find an activity or person"
            aria-label="Find an activity or a person"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className={`${s.groupBy} type-meta`}>
          Group by
          <Chips<Group>
            label="Group activities by"
            value={group}
            onChange={(v) => setUi({ planGroup: v })}
            options={GROUPS}
          />
        </span>
      </div>

      <div className={s.listWrap} ref={list}>
        <table className={`${s.list} type-table`}>
          <thead>
            <tr>
              <th>
                <span className="sr-only">State</span>
              </th>
              <th>Activity</th>
              <th>Owner</th>
              <th>When</th>
              <th className={s.windowCol}>
                Window · {sched.days[0] ? shortDay(`${sched.days[0].date}T12:00:00Z`, 'UTC') : ''}{' '}
                to{' '}
                {sched.days.at(-1) ? shortDay(`${sched.days.at(-1)!.date}T12:00:00Z`, 'UTC') : ''}
              </th>
              <th>
                <span className="sr-only">Tasks</span>
              </th>
            </tr>
          </thead>
          {group === 'phase' && filter.value === 'open' && !q && donePhases.length > 0 && (
            <tbody>
              <tr className={s.doneLine}>
                <td>
                  <Glyph look="done" />
                </td>
                <td colSpan={5}>
                  {plural(donePhases.length, 'phase', 'phases')} done (
                  {donePhases.map((p) => p.name).join(', ')}),{' '}
                  {plural(doneCount, 'activity', 'activities')} in all.{' '}
                  <button
                    type="button"
                    className={s.rowLink}
                    onClick={() => setUi({ planFilter: 'all' })}
                  >
                    Show them
                  </button>
                </td>
              </tr>
            </tbody>
          )}
          {sections.map((sec) => (
            <tbody key={sec.key}>
              <tr className={s.groupRow}>
                <th colSpan={6} scope="colgroup" id={sec.id}>
                  {sec.head}
                </th>
              </tr>
              {!sec.folded &&
                sec.rows.flatMap((a) => {
                  const out: ReactNode[] = [];
                  if (sec.nowLine && !nowPlaced && Date.parse(a.start) > now) {
                    nowPlaced = true;
                    out.push(
                      <tr key={`${a.key}/now`} className={s.nowRow} aria-label="Now">
                        <td colSpan={6}>
                          <span className="type-label">Now</span>
                        </td>
                      </tr>,
                    );
                  }
                  out.push(
                    ...activityRows({
                      a,
                      tasks,
                      holds,
                      x,
                      nowX,
                      tz,
                      now,
                      expanded: open.has(a.key),
                      toggle,
                      openCard,
                      hue: hueOf(byId(a.agentId)?.workstream ?? null),
                    }),
                  );
                  return out;
                })}
              {sec.after}
            </tbody>
          ))}
          {sections.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={6} className={s.empty}>
                  {q ? `Nothing matches “${query.trim()}”.` : 'No activities here.'}
                </td>
              </tr>
            </tbody>
          )}
        </table>
      </div>
      <RowActions />
    </div>
  );
}

/** One activity's rows: the activity, and when folded open, its tasks and a re-run. */
function activityRows(p: {
  a: Activity;
  tasks: Tasks;
  holds: Holds;
  x: (t: string | number) => number;
  nowX: number;
  tz: string;
  now: number;
  expanded: boolean;
  toggle: (key: string) => void;
  openCard: (escalationId: string) => void;
  hue: string;
}): ReactNode[] {
  const { a, tasks, expanded } = p;
  const many = a.taskIds.length > 1;
  const rows: ReactNode[] = [<ActivityRow key={a.key} {...p} many={many} />];
  if (many && expanded) {
    for (const id of a.taskIds) {
      const t = tasks.get(id);
      rows.push(
        <TaskRow key={`${a.key}/${id}`} id={id} t={t} tasks={tasks} tz={p.tz} now={p.now} />,
      );
    }
    const finished = a.taskIds.filter((id) => tasks.get(id)?.state === 'done');
    if (finished.length)
      rows.push(
        <tr key={`${a.key}/rerun`} className={s.subRow}>
          <td />
          <td colSpan={5}>
            <RerunAll title={a.title} ids={finished} />
          </td>
        </tr>,
      );
  }
  return rows;
}

function ActivityRow({
  a,
  tasks,
  holds,
  x,
  nowX,
  tz,
  now,
  expanded,
  toggle,
  openCard,
  hue,
  many,
}: Parameters<typeof activityRows>[0] & { many: boolean }) {
  const { inspect } = useApp();
  const { byId } = useRoster();
  const held = holds.get(a.key) ?? [];
  const yours = held.length > 0;
  const cur = currentTask(a, tasks);
  const dep = waitingOn(a, tasks);
  const { done, total } = progressOf(a, tasks);
  const { word, look } = stateOf(a.state);
  const left = x(a.start);
  const width = Math.max(0.6, x(a.end) - left);

  let line: ReactNode;
  if (yours)
    line = (
      <>
        <button
          type="button"
          className={s.yoursLink}
          onClick={() => openCard(held[0]!.escalationId)}
        >
          Needs you
        </button>
        <span>· {held[0]!.title}</span>
      </>
    );
  else if (!isOpen(a)) line = <span>{many ? `${total} tasks done` : word}</span>;
  else if (isHeld(a)) line = <span>{dep ? `Waiting on ${dep.title}` : word}</span>;
  else if (isMoving(a))
    line = <span>{many ? `${done} of ${total} · now: ${cur?.title ?? ''}` : word}</span>;
  else line = <span>{dep ? `After ${dep.title}` : 'Ready to start'}</span>;

  return (
    <tr data-key={a.key} data-yours={yours || undefined} data-open={expanded || undefined}>
      <td className={s.stateCell}>
        <Glyph look={yours ? 'blocked' : look} />
        <span className="sr-only">{yours ? 'Needs you' : word}</span>
      </td>
      <td>
        <span className={s.activity}>
          <button
            type="button"
            className={`${s.rowLink} ${s.title}`}
            onClick={() => cur && inspect('task', cur.taskId)}
          >
            {a.title}
          </button>
          <span className={`${s.line} type-meta`}>
            {many && total <= MAX_PIPS && <Pips ids={a.taskIds} tasks={tasks} />}
            {line}
          </span>
        </span>
      </td>
      <td>
        <Owner agent={byId(a.agentId)} id={a.agentId} compact />
      </td>
      <td className={s.when}>{whenOf(a, tasks, tz, now)}</td>
      <td className={s.windowCol} aria-hidden="true">
        <span className={s.window}>
          <i
            className={s.windowBar}
            data-forecast={isForecast(a, tasks) || undefined}
            style={vars({ '--x': `${left}%`, '--w': `${width}%`, '--hue': hue })}
          />
          <i className={s.windowNow} style={vars({ '--x': `${nowX}%` })} />
        </span>
      </td>
      <td>
        {many && (
          <button
            type="button"
            className={s.expand}
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} the ${total} tasks of ${a.title}`}
            onClick={() => toggle(a.key)}
          >
            <Icon name="chevron" size={18} className={s.foldIcon} />
          </button>
        )}
      </td>
    </tr>
  );
}

function TaskRow({
  id,
  t,
  tasks,
  tz,
  now,
}: {
  id: string;
  t: ScheduledTask | undefined;
  tasks: Tasks;
  tz: string;
  now: number;
}) {
  const { inspect } = useApp();
  const dep = t?.dependsOn.map((d) => tasks.get(d)).find((d) => d && isOpen(d));
  const note = !t
    ? null
    : t.gaps
      ? `Done with gaps: ${t.gaps}`
      : dep && isOpen(t)
        ? `After ${dep.title}`
        : t.basis === 'forecast' && isOpen(t)
          ? 'Forecast'
          : t.basis === 'actual'
            ? 'Recorded'
            : 'Planned';
  const when = !t
    ? ''
    : !isOpen(t)
      ? `Done ${moment(t.end, tz, now)}`
      : Date.parse(t.start) <= now
        ? `Ends ~${moment(t.end, tz, now)}`
        : `Starts ~${moment(t.start, tz, now)}`;
  return (
    <tr className={s.subRow}>
      <td />
      <td>
        <span className={s.task}>
          <button type="button" className={s.rowLink} onClick={() => inspect('task', id)}>
            {t?.title ?? id}
          </button>
          {note && <span className={`${s.quietText} type-meta`}>{note}</span>}
        </span>
      </td>
      <td />
      <td className={s.when}>{when}</td>
      <td colSpan={2}>{t && <StateWord state={t.state} gaps={t.gaps} />}</td>
    </tr>
  );
}

/** One square per task: done, moving, held, or still to come. */
function Pips({ ids, tasks }: { ids: string[]; tasks: Tasks }) {
  return (
    <span className={s.pips} aria-hidden="true">
      {ids.map((id) => {
        const t = tasks.get(id);
        return (
          <i
            key={id}
            data-look={
              !t
                ? undefined
                : t.state === 'done'
                  ? 'done'
                  : isMoving(t)
                    ? 'running'
                    : isHeld(t)
                      ? 'waiting'
                      : undefined
            }
          />
        );
      })}
    </span>
  );
}

/** The engagement's phases as one strip, sized by their activities; each jumps to its group. */
function PhaseRail({
  sched,
  onJump,
}: {
  sched: ScheduleSnapshot;
  onJump: (phase: number) => void;
}) {
  const { byId } = useRoster();
  const current = sched.phases.find((p) => p.state === 'running');
  return (
    <ol className={s.rail} aria-label="Phases">
      {sched.phases.map((p) => {
        const n = p.activities.length || 1;
        const done = p.activities.filter((a) => a.state === 'done').length;
        return (
          <li key={p.phase} className={s.railItem} style={vars({ '--n': n })}>
            <button
              type="button"
              className={s.seg}
              data-current={p === current || undefined}
              onClick={() => onJump(p.phase)}
              title={`${p.phase}. ${p.name}: ${done} of ${p.activities.length} done`}
            >
              <span
                className={s.segBar}
                style={vars({
                  '--f': `${(done / n) * 100}%`,
                  '--hue': hueOf(ownerOf(p.activities, byId)),
                })}
              />
              <span className={`${s.segLabel} type-meta`}>
                {p.phase}. {p.name}
              </span>
            </button>
            {p.gateLabel && (
              <span
                className={s.diamond}
                data-done={p.state === 'done' || undefined}
                role="img"
                aria-label={p.gateLabel}
                title={p.gateLabel}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Every finished task in a group goes back to its agent, one after another, with the same
 * instructions; unfinished ones aren't touched.
 */
function RerunAll({ title, ids }: { title: string; ids: string[] }) {
  const { projectId, run, openOverlay, closeOverlay } = useApp();
  const n = ids.length;
  return (
    <Button
      kind="secondary"
      onClick={() =>
        openOverlay(
          <TextForm
            title={`Re-run ${n} of ${title}`}
            body={`The ${plural(n, 'finished task', 'finished tasks')} in this group start a fresh attempt with these instructions. Unfinished ones aren't touched.`}
            label="Instructions"
            placeholder="What should change this time?"
            submitLabel={`Re-run ${n}`}
            onSubmit={(instructions) => {
              closeOverlay();
              void run(async () => {
                for (const id of ids)
                  await post(`/projects/${projectId}/tasks/${encodeURIComponent(id)}/rerun`, {
                    instructions,
                  });
              }, `Re-running ${n} tasks`);
            }}
          />,
        )
      }
    >
      Re-run all finished…
    </Button>
  );
}

/** The hint under the list. */
function RowActions() {
  return (
    <p className={`${s.hint} type-meta`}>
      Select an activity, a task or a person for detail. A dashed window is the scheduler's
      forecast.
    </p>
  );
}
