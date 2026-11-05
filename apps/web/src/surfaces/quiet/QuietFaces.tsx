/*
 * The Bliss face of Plan, and the switches that pick Plan's and Workbench's face (Workbench Bliss is
 * in ./WorkbenchBliss). Their Everything faces
 * (surfaces/plan, surfaces/workbench) are the full consoles: the timelines with zoom, the document
 * rail and viewers. Bliss reduces each to the few lines a Director reads.
 */
import type { ScheduleSnapshot } from '@lw/contracts';
import { clock, localDate, shortDay } from '../../lib/fmt';
import { useMode } from '../../mode/mode';
import { Mode } from '../../mode/Mode';
import { useApp, useMission, useNow, useProjectResource, useRoster } from '../../state';
import { Icon } from '../../theme/icons';
import { Avatar, SectionHeading } from '../../ui/cypher/parts';
import { PlanEverything as Plan } from '../plan/PlanEverything';
import { WorkbenchEverything as Workbench } from '../workbench/WorkbenchEverything';
import { WorkbenchBliss } from './WorkbenchBliss';
import s from './quiet.module.css';

export function PlanPage() {
  return <Mode bliss={<PlanBliss />} everything={<Plan />} />;
}
export function WorkbenchPage() {
  return <Mode bliss={<WorkbenchBliss />} everything={<Workbench />} />;
}

const WAIT: Record<string, string> = {
  blocked: 'blocked',
  waiting: 'waits on a decision',
  paused: 'paused',
  running: 'under way',
  validating: 'being checked',
};

/** Plan in Bliss: what happens next, the next five activities in order, and what each waits on. */
function PlanBliss() {
  const sched = useProjectResource<ScheduleSnapshot>('/schedule').data;
  const tz = useMission().data?.project.timezone ?? 'America/New_York';
  const { agents } = useRoster();
  const { inspect } = useApp();
  const now = useNow(60_000);
  const { setMode } = useMode();
  if (!sched) return <p className="type-body">Reading the plan…</p>;
  const byId = new Map(sched.tasks.map((t) => [t.taskId, t]));
  const next = sched.tasks
    .filter((t) => t.state !== 'done' && t.state !== 'cancelled' && t.state !== 'rolled_back')
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 5);
  const when = (at: string) =>
    localDate(at, tz) === localDate(now, tz)
      ? clock(at, tz).replace(/\s?[AP]M$/, '')
      : shortDay(at, tz);
  return (
    <div className={s.bliss}>
      <SectionHeading>What happens next</SectionHeading>
      <ol className={s.timeline}>
        {next.map((t) => {
          const a = agents.find((x) => x.agentId === t.agentId);
          const name = a?.persona ?? a?.name ?? t.agentId;
          const open = t.dependsOn.map((d) => byId.get(d)).filter((d) => d && d.state !== 'done');
          const waits =
            WAIT[t.state] ?? (open.length ? `after ${open[0]!.title}` : 'ready to start');
          return (
            <li key={t.taskId}>
              <button type="button" className={s.step} onClick={() => inspect('task', t.taskId)}>
                <span className={`${s.when} type-button`}>{when(t.start)}</span>
                <span className={s.dot} aria-hidden="true" />
                {a && (
                  <Avatar
                    face={{
                      agentId: t.agentId,
                      name,
                      firstName: name.split(' ')[0] ?? name,
                      initials: name
                        .split(/\s+/)
                        .map((w) => w[0])
                        .join('')
                        .slice(0, 2)
                        .toUpperCase(),
                      workstream: a.workstream,
                      working: t.state === 'running',
                    }}
                    size="md"
                  />
                )}
                <span className={s.stepText}>
                  <b>{t.title}</b>
                  <span
                    className="type-meta"
                    data-tone={t.state === 'blocked' || t.state === 'waiting' ? 'yours' : undefined}
                  >
                    {name.split(' ')[0]} · {waits}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {next.length === 0 && <li className={`${s.quiet} type-body`}>Nothing left to schedule.</li>}
      </ol>
      <button
        type="button"
        className={`${s.more} type-button`}
        onClick={() => setMode('everything')}
      >
        The whole plan, in Everything
        <Icon name="chevron" size={18} />
      </button>
    </div>
  );
}
