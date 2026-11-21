/*
 * Plan, Bliss face: the activity list, distilled. The same activities in the same words as
 * Everything, cut to what the Director reads: one sentence on where things stand, the phases,
 * what is moving now, what comes next, and one line for what is done. Decisions are not here: they
 * live in Needs you and on Mission Control. Any activity opens Everything on that row, so changing
 * face keeps the Director's place.
 */
import type { ScheduledTask, ScheduleSnapshot } from '@lw/contracts';
import { useMemo, type ReactNode } from 'react';
import { useMode } from '../../mode/mode';
import { useApp, useNow, useProjectResource, useRoster } from '../../state';
import { Icon } from '../../theme/icons';
import { Avatar, hueOf, PhaseStrip, SectionHeading } from '../../ui/cypher/parts';
import {
  activitiesOf,
  faceOf,
  isHeld,
  isMoving,
  isOpen,
  moment,
  ownerOf,
  plural,
  progressOf,
  waitingOn,
  type Activity,
} from './model';
import { Glyph } from './parts';
import s from './planBliss.module.css';

const MAX_NEXT = 4;

export function PlanBliss() {
  const sched = useProjectResource<ScheduleSnapshot>('/schedule').data;
  const { byId } = useRoster();
  const { setUi } = useApp();
  const { setMode } = useMode();
  const now = useNow(60_000);
  const all = useMemo(() => (sched ? activitiesOf(sched) : []), [sched]);
  const tasks = useMemo(
    () => new Map<string, ScheduledTask>((sched?.tasks ?? []).map((t) => [t.taskId, t])),
    [sched],
  );
  if (!sched) return <p className="type-body">Reading the plan…</p>;

  const tz = sched.timezone;
  const moving = all.filter(isMoving).sort((a, b) => a.end.localeCompare(b.end));
  const held = all.filter(isHeld);
  const next = all
    .filter((a) => isOpen(a) && !isMoving(a) && !isHeld(a))
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, MAX_NEXT);
  const done = all.filter((a) => !isOpen(a));
  const last = done.toSorted((a, b) => b.end.localeCompare(a.end))[0];
  const current = sched.phases.find((p) => p.state === 'running');
  const gate = sched.phases.find((p) => p.gateLabel && p.state !== 'done');
  const finish = sched.finishAt ? moment(sched.finishAt, tz, now).replace(/,.*$/, '') : null;

  // Opens the row in Everything, unfolded and in view.
  const openRow = (a: Activity) => {
    setUi({ planFocus: a.key, planGroup: 'phase', planFilter: isOpen(a) ? 'open' : 'all' });
    setMode('everything');
  };
  const name = (a: Activity) => {
    const p = byId(a.agentId);
    return (p?.persona ?? p?.name ?? a.agentId).split(' ')[0];
  };
  const face = (a: Activity) => (
    <Avatar face={faceOf(byId(a.agentId), a.agentId, isMoving(a))} size="md" />
  );

  const strip = sched.phases.map((p) => {
    const n = p.activities.length || 1;
    return {
      key: String(p.phase),
      name: p.name,
      percent: Math.round((p.activities.filter((a) => a.state === 'done').length / n) * 100),
      hue: hueOf(ownerOf(p.activities, byId)),
      current: p === current,
      future: p.state === 'planned',
    };
  });

  return (
    <div className={s.bliss}>
      <p className={`${s.voice} type-voice-small`}>
        {current
          ? `${current.name} is under way. `
          : done.length === all.length
            ? 'Everything is done. '
            : ''}
        {finish && (
          <>
            The plan lands <b>{finish}</b>.
          </>
        )}
      </p>

      <PhaseStrip phases={strip} labelled />

      <section className={s.section} aria-labelledby="plan-now">
        <SectionHeading>
          <span id="plan-now">Now</span>
        </SectionHeading>
        {moving.length ? (
          <ol className={s.steps}>
            {moving.map((a) => {
              const { done: d, total } = progressOf(a, tasks);
              return (
                <Step
                  key={a.key}
                  when="Now"
                  face={face(a)}
                  title={a.title}
                  line={`${name(a)} · ${total > 1 ? `${d} of ${total} done` : 'under way'}`}
                  right={`ends ~${moment(a.end, tz, now)}`}
                  onOpen={() => openRow(a)}
                />
              );
            })}
          </ol>
        ) : (
          <p className={`${s.quiet} type-body`}>Nobody is working on the plan right now.</p>
        )}
      </section>

      <section className={s.section} aria-labelledby="plan-next">
        <SectionHeading>
          <span id="plan-next">Next</span>
        </SectionHeading>
        {next.length || held.length || gate ? (
          <ol className={s.steps}>
            {held.map((a) => {
              const dep = waitingOn(a, tasks);
              return (
                <Step
                  key={a.key}
                  when="Held"
                  face={face(a)}
                  title={a.title}
                  line={`${name(a)} · waiting on ${dep?.title ?? 'a decision'}`}
                  tone="held"
                  onOpen={() => openRow(a)}
                />
              );
            })}
            {next.map((a) => {
              const dep = waitingOn(a, tasks);
              return (
                <Step
                  key={a.key}
                  when={moment(a.start, tz, now)
                    .replace(/^today /, '')
                    .replace(/,.*$/, '')}
                  face={face(a)}
                  title={a.title}
                  line={`${name(a)} · ${dep ? `after ${dep.title}` : 'ready to start'}`}
                  onOpen={() => openRow(a)}
                />
              );
            })}
            {gate && (
              <li className={s.gateStep}>
                <span className={`${s.when} type-button`}>
                  {gate.gateAt ? moment(gate.gateAt, tz, now).replace(/,.*$/, '') : 'Later'}
                </span>
                <span className={s.diamond} aria-hidden="true" />
                <span className={s.text}>
                  <b>{gate.gateLabel}</b>
                  <span className="type-meta">Director gate, after {gate.name}</span>
                </span>
              </li>
            )}
          </ol>
        ) : (
          <p className={`${s.quiet} type-body`}>Nothing left to schedule.</p>
        )}
      </section>

      {last && (
        <p className={`${s.done} type-body`}>
          <Glyph look="done" />
          <span>
            <b>
              {done.length} of {plural(all.length, 'activity', 'activities')}
            </b>{' '}
            done. Last: {last.title}, {moment(last.end, tz, now)}.
          </span>
        </p>
      )}

      <button
        type="button"
        className={`${s.more} type-button`}
        onClick={() => setMode('everything')}
      >
        Every activity, in Everything
        <Icon name="chevron" size={18} />
      </button>
    </div>
  );
}

function Step({
  when,
  face,
  title,
  line,
  right,
  tone,
  onOpen,
}: {
  when: string;
  face: ReactNode;
  title: string;
  line: string;
  right?: string;
  tone?: 'held';
  onOpen: () => void;
}) {
  return (
    <li>
      <button type="button" className={s.step} onClick={onOpen}>
        <span className={`${s.when} type-button`} data-tone={tone}>
          {when}
        </span>
        {face}
        <span className={s.text}>
          <b>{title}</b>
          <span className="type-meta">{line}</span>
        </span>
        {right && <span className={`${s.right} type-meta`}>{right}</span>}
      </button>
    </li>
  );
}
