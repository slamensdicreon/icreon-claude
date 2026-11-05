/*
 * The Bliss faces of Plan and Workbench, and the switches that pick a face. Their Everything faces
 * are the full consoles (the timelines with zoom, the document wiki and viewers), which keep their
 * behaviour; Bliss reduces each to the few lines a Director reads.
 */
import type { ScheduleSnapshot, WorkbenchSnapshot } from '@lw/contracts';
import { clock, localDate, shortDay } from '../../lib/fmt';
import { useMode } from '../../mode/mode';
import { Mode } from '../../mode/Mode';
import { useApp, useMission, useNow, useProjectResource, useRoster } from '../../state';
import { Icon } from '../../theme/icons';
import { Avatar, SectionHeading } from '../../ui/cypher/parts';
import { Plan } from '../Plan';
import { Workbench } from '../Workbench';
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

/** Workbench in Bliss: the documents, newest first, each a line; opening one goes to Everything. */
function WorkbenchBliss() {
  const wb = useProjectResource<WorkbenchSnapshot>('/workbench').data;
  const tz = useMission().data?.project.timezone ?? 'America/New_York';
  const { setUi } = useApp();
  const { setMode } = useMode();
  if (!wb) return <p className="type-body">Reading the Workbench…</p>;
  const docs = wb.artifacts
    .map((a) => ({
      a,
      at: a.versions.find((v) => v.version === a.latest)?.ts ?? a.versions[0]?.ts ?? '',
    }))
    .sort((x, y) => y.at.localeCompare(x.at));
  return (
    <div className={s.bliss}>
      <SectionHeading>The documents, newest first</SectionHeading>
      <ul className={s.docs}>
        {docs.map(({ a, at }) => {
          const approved = a.approved[0];
          return (
            <li key={a.artifactId}>
              <button
                type="button"
                className={s.doc}
                onClick={() => {
                  setUi({ wbArtifact: a.artifactId });
                  setMode('everything');
                }}
              >
                <Icon name="workbench" size={22} />
                <span className={s.stepText}>
                  <b>{a.title}</b>
                  <span className="type-meta">
                    Version {a.latest}
                    {approved ? ` · version ${approved.version} approved at ${approved.gate}` : ''}
                    {at ? ` · ${shortDay(at, tz)}` : ''}
                  </span>
                </span>
                <Icon name="chevron" size={18} className={s.chev} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
