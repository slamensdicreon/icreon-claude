/*
 * Plan, Bliss face: the activity list, distilled. The same activities in the same words as
 * Everything, cut to what the Director reads: one sentence on where things stand, the phases,
 * the decisions that hold work (each naming the activity it holds), what is moving now, what comes
 * next, and one line for what is done. Any activity opens Everything on that row, so changing
 * face keeps the Director's place.
 */
import type { ScheduledTask, ScheduleSnapshot } from '@lw/contracts';
import { useMemo, type ReactNode } from 'react';
import { useMode } from '../../mode/mode';
import { useApp, useMission, useNow, useProjectResource, useRoster } from '../../state';
import { Icon } from '../../theme/icons';
import { kindOf, useYoursActions } from '../../ui/cypher/cards';
import { Avatar, hueOf, PhaseStrip, QuietCard, SectionHeading } from '../../ui/cypher/parts';
import { clock } from '../../lib/fmt';
import { Decision } from '../mission/Decision';
import { openCards } from '../mission/model';
import {
  activitiesOf,
  activityOfCard,
  faceOf,
  holdsOf,
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

/** Decision cards shown here; the rest wait in Needs you. */
const MAX_CARDS = 3;
const MAX_NEXT = 4;

export function PlanBliss() {
  const sched = useProjectResource<ScheduleSnapshot>('/schedule').data;
  const mc = useMission().data;
  const { byId } = useRoster();
  const { setUi } = useApp();
  const { setMode } = useMode();
  const now = useNow(60_000);
  const all = useMemo(() => (sched ? activitiesOf(sched) : []), [sched]);
  const tasks = useMemo(
    () => new Map<string, ScheduledTask>((sched?.tasks ?? []).map((t) => [t.taskId, t])),
    [sched],
  );
  const act = useYoursActions(mc?.project.id ?? '', mc?.project.name ?? '');
  if (!sched || !mc) return <p className="type-body">Reading the plan…</p>;

  const tz = sched.timezone;
  const hm = (t: string) => clock(t, tz).replace(/\s?[AP]M$/, '');
  const cards = openCards(mc);
  const holds = holdsOf(all, cards);
  const free = (a: Activity) => !holds.has(a.key);
  const moving = all
    .filter((a) => isMoving(a) && free(a))
    .sort((a, b) => a.end.localeCompare(b.end));
  const held = all.filter((a) => isHeld(a) && free(a));
  const next = all
    .filter((a) => isOpen(a) && free(a) && !isMoving(a) && !isHeld(a))
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

  const holdsLine = (escalationId: string) => {
    const card = cards.find((c) => c.escalationId === escalationId);
    const a = card && activityOfCard(all, card);
    if (!a) return null;
    return (
      <p className={`${s.holds} type-meta`}>
        Holds{' '}
        <button type="button" className={s.link} onClick={() => openRow(a)}>
          {a.title}
        </button>{' '}
        · {name(a)}
      </p>
    );
  };

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
        {cards.length > 0 ? (
          <>
            <span className={s.yours}>
              {cards.length === 1 ? 'One thing needs you' : `${cards.length} things need you`}
            </span>
            {finish && (
              <>
                ; the rest runs on its own until <b>{finish}</b>.
              </>
            )}
          </>
        ) : (
          <>
            <b>Nothing needs you.</b>
            {finish && <> The plan lands {finish}.</>}
          </>
        )}
      </p>

      <PhaseStrip phases={strip} labelled />

      {cards.length > 0 && (
        <section className={s.section} aria-labelledby="plan-yours">
          <SectionHeading>
            <span id="plan-yours">Needs you</span>
          </SectionHeading>
          {cards.slice(0, MAX_CARDS).map((x, i) => {
            if (i === 0)
              return (
                <div key={x.escalationId} className={s.card}>
                  {holdsLine(x.escalationId)}
                  <Decision x={x} mc={mc} />
                </div>
              );
            const { primary, secondary } = act.cardActions(x, 'project');
            return (
              <div key={x.escalationId} className={s.card}>
                {holdsLine(x.escalationId)}
                <QuietCard
                  label={`${kindOf(x)} · ${x.deadline ? `before ${hm(x.deadline)}` : 'no clock'}`}
                  title={x.title}
                  rec={x.recommendation ?? null}
                  primary={primary}
                  secondary={secondary}
                />
              </div>
            );
          })}
          {cards.length > MAX_CARDS && (
            <p className={`${s.quiet} type-meta`}>
              {cards.length - MAX_CARDS} more wait their turn in Needs you.
            </p>
          )}
        </section>
      )}

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
                  line={`${name(a)} · waiting on ${dep?.title ?? 'something outside the plan'}`}
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
                  <span className="type-meta">Yours, when {gate.name} is ready</span>
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
