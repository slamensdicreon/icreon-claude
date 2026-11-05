import type { AgentDetail, ScheduleSnapshot, TaskView } from '@lw/contracts';
import { useEffect, useRef, type ReactNode } from 'react';
import { post } from './lib/api';
import { clock, initials, shortDay, tokens } from './lib/fmt';
import { useResource } from './lib/live';
import { overlayStyles as o, TextForm, TypedConfirm } from './overlays/Dialogs';
import { Chip, Who, personOf } from './parts/bits';
import { useApp, useProjectResource, useRoster, useTz } from './state';
import { Icon } from './theme/icons';
import { Facts } from './ui/cypher/forms';
import { Avatar } from './ui/cypher/parts';
import { Eye } from './ui/Eye';
import { useEyeState } from './voice/eye';
import s from './inspector.module.css';

const RERUNNABLE = new Set([
  'done',
  'blocked',
  'rejected',
  'waiting',
  'cancelled',
  'rolled_back',
  'ready',
]);

/** States a task can be recorded as done from, when the team did the work outside the agents. */
const COMPLETABLE = new Set([
  'planned',
  'ready',
  'blocked',
  'paused',
  'rejected',
  'waiting',
  'rolled_back',
]);

/** The drawer over the canvas: one agent or one task, read-only apart from its controls. */
export function Inspector() {
  const { inspector, closeInspector } = useApp();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (inspector)
      window.setTimeout(
        () => ref.current?.querySelector<HTMLButtonElement>('[data-close]')?.focus(),
        50,
      );
  }, [inspector]);
  return (
    <aside
      ref={ref}
      className={s.drawer}
      data-open={inspector ? true : undefined}
      aria-label="Inspector"
      aria-hidden={!inspector}
      inert={!inspector || undefined}
    >
      {inspector?.kind === 'agent' && <AgentPanel id={inspector.id} close={closeInspector} />}
      {inspector?.kind === 'task' && <TaskPanel id={inspector.id} close={closeInspector} />}
    </aside>
  );
}

function Close({ close }: { close: () => void }) {
  return (
    <button type="button" className={s.close} aria-label="Close" data-close onClick={close}>
      <Icon name="close" />
    </button>
  );
}

function AgentPanel({ id, close }: { id: string; close: () => void }) {
  const { projectId, run, go, ui, inspect } = useApp();
  const { byId } = useRoster();
  const eye = useEyeState();
  const tz = useTz();
  const a = useProjectResource<AgentDetail>(`/agents/${encodeURIComponent(id)}`).data;
  if (!a) return <div className={`${s.loading} type-body-small`}>Loading…</div>;
  const cos = a.tier === 'chief_of_staff';
  const lead = byId(a.reportsTo);
  const canPause = a.state === 'active' || a.state === 'waiting' || a.state === 'paused';
  const control = (verb: 'pause' | 'resume') =>
    run(() =>
      post(`/projects/${projectId}/control`, { verb, scope: { kind: 'agent', id: a.agentId } }),
    );
  const name = personOf(a);
  return (
    <>
      <div className={s.head}>
        {cos ? (
          <Eye state={eye.state} size={40} decorative />
        ) : (
          <Avatar
            face={{
              agentId: a.agentId,
              name,
              firstName: name.split(' ')[0] ?? name,
              initials: initials(a),
              workstream: a.workstream,
              working: a.state === 'active',
            }}
            size="lg"
          />
        )}
        <h2 className={s.title}>
          <span className="type-title">{name}</span>
          <small className="type-meta">{cos ? 'Chief of Staff' : a.name}</small>
        </h2>
        <Chip state={a.state} />
        <Close close={close} />
      </div>
      <div className={s.body}>
        <div>
          <h3 className="type-label">Role</h3>
          <p className="type-body-small">{a.description || a.name}</p>
          {a.projectNote && (
            <>
              <h3 className={`${s.later} type-label`}>On this project</h3>
              <p className="type-body-small">
                <Who text={a.projectNote} />
              </p>
            </>
          )}
        </div>
        <Facts
          rows={[
            ['Model', a.modelClass],
            [
              'Reports to',
              cos
                ? 'You, Implementation Director'
                : lead
                  ? `${personOf(lead)}, ${lead.tier === 'chief_of_staff' ? 'Chief of Staff' : lead.name}`
                  : 'Cypher, Chief of Staff',
            ],
            [
              'Active in phases',
              a.activePhases.length >= 10 ? 'all' : a.activePhases.join(', ') || '–',
            ],
            ['Tokens this project', tokens(a.tokensProject)],
          ]}
        />
        <div>
          <h3 className="type-label">Now</h3>
          <p className="type-body-small">
            {a.now ?? '–'}
            {a.step && (
              <span className={s.quiet}>
                {' '}
                (step {a.step.n} of {a.step.of})
              </span>
            )}
          </p>
          {a.taskId && (
            <button
              type="button"
              className={`${o.link} type-meta`}
              onClick={() => inspect('task', a.taskId!)}
            >
              Open the task
            </button>
          )}
        </div>
        <div>
          <h3 className="type-label">Next</h3>
          <p className="type-body-small">{a.next ? <Who text={a.next.title} /> : '–'}</p>
          {a.next && <p className={`${s.quiet} type-meta`}>{a.next.when}</p>}
        </div>
        <div>
          <h3 className="type-label">Last tool calls</h3>
          {a.lastSteps.length ? (
            <div className={s.calls}>
              {a.lastSteps.map((c) => (
                <div
                  key={c.stepId}
                  className={`${s.call} type-meta`}
                  data-bad={c.resultCode >= 400 || undefined}
                >
                  <span>{clock(c.ts, tz)}</span>
                  <span className={s.op}>
                    {c.toolServer} · {c.operation}
                  </span>
                  <span className={s.code}>
                    {c.outcome ?? c.resultCode} ·{' '}
                    {c.durationMs < 1000
                      ? `${c.durationMs} ms`
                      : `${(c.durationMs / 1000).toFixed(1)} s`}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className={`${s.quiet} type-body-small`}>No tool calls yet.</p>
          )}
        </div>
        {!cos && (
          <div className={s.actions}>
            {a.state === 'paused' ? (
              <button
                type="button"
                className={`${o.btn} ${o.primary} type-button`}
                onClick={() => void control('resume')}
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                className={`${o.btn} type-button`}
                disabled={!canPause}
                onClick={() => void control('pause')}
              >
                Pause this agent
              </button>
            )}
            <button
              type="button"
              className={`${o.btn} type-button`}
              onClick={() => go('activity', { activity: { ...ui.activity, agent: a.agentId } })}
            >
              Open in Activity
            </button>
          </div>
        )}
        <p className={`${s.quiet} type-meta`}>Read-only. Direct the team through Cypher.</p>
      </div>
    </>
  );
}

function TaskPanel({ id, close }: { id: string; close: () => void }) {
  const { projectId, run, openOverlay, closeOverlay, inspect } = useApp();
  const { byId } = useRoster();
  const tz = useTz();
  const t = useProjectResource<TaskView>(`/tasks/${encodeURIComponent(id)}`).data;
  const sched = useResource<ScheduleSnapshot>(
    projectId,
    projectId ? `/projects/${projectId}/schedule` : null,
  ).data;
  if (!t) return <div className={`${s.loading} type-body-small`}>Loading…</div>;
  const ag = byId(t.agentId);
  const win = sched?.tasks.find((x) => x.taskId === t.taskId);
  const title = (tid: string) => sched?.tasks.find((x) => x.taskId === tid)?.title ?? tid;
  const max = t.contract?.maxAttempts ?? 3;
  const attempts =
    t.state === 'running' || t.state === 'validating'
      ? `${t.attempt} of ${max} in progress`
      : t.state === 'planned' || t.state === 'ready'
        ? `0 of ${max}`
        : `${t.attempt} of ${max}`;
  const base = `/projects/${projectId}/tasks/${encodeURIComponent(t.taskId)}`;
  const when = (iso: string) => {
    const today = sched
      ? new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }) === sched.today.date
      : true;
    return today ? clock(iso, tz) : `${shortDay(iso, tz)} ${clock(iso, tz)}`;
  };
  const facts: [ReactNode, ReactNode][] = [
    [
      'Agent',
      ag ? (
        <button type="button" className={o.link} onClick={() => inspect('agent', ag.agentId)}>
          {personOf(ag)}, {ag.name}
        </button>
      ) : (
        t.role
      ),
    ],
    [
      'Window',
      win ? (
        <>
          {when(win.start)} to {when(win.end)}
          {win.basis !== 'actual' && <span className={s.quiet}> ({win.basis})</span>}
        </>
      ) : (
        '–'
      ),
    ],
    ['Depends on', t.dependsOn.length ? t.dependsOn.map(title).join(', ') : 'nothing'],
    ...(t.itemKeys.length ? ([['Items', t.itemKeys.join(', ')]] as [ReactNode, ReactNode][]) : []),
    ...(t.contract
      ? ([
          ['Inputs', t.contract.inputs],
          ['Outputs', t.contract.outputs],
          ['Acceptance', t.contract.acceptance],
        ] as [ReactNode, ReactNode][])
      : []),
    ['Attempts', attempts],
    ...(t.lastReason
      ? ([['Last result', <Who key="r" text={t.lastReason} />]] as [ReactNode, ReactNode][])
      : []),
    ...(t.contract ? ([['Rollback recipe', t.contract.rollback]] as [ReactNode, ReactNode][]) : []),
  ];
  return (
    <>
      <div className={s.head}>
        <h2 className={s.title}>
          <span className="type-title">{t.title}</span>
          {t.groupTitle && <small className="type-meta">{t.groupTitle}</small>}
        </h2>
        <Chip state={t.state} />
        <Close close={close} />
      </div>
      <div className={s.body}>
        <Facts rows={facts} />
        <div className={s.actions}>
          <button
            type="button"
            className={`${o.btn} type-button`}
            // Anything that ran and isn't running now: finished, or stuck (blocked, rejected, waiting).
            disabled={!RERUNNABLE.has(t.state) || t.kind !== 'work'}
            title={RERUNNABLE.has(t.state) ? undefined : `Can't re-run while ${t.state}`}
            onClick={() =>
              openOverlay(
                <TextForm
                  title={`Re-run ${t.title}`}
                  body="The agent starts a fresh attempt with these instructions added to its brief. The previous attempt's output stays in the audit trail."
                  label="Instructions"
                  placeholder="What should change this time?"
                  submitLabel="Re-run"
                  onSubmit={(instructions) => {
                    closeOverlay();
                    void run(
                      () => post(`${base}/rerun`, { instructions }),
                      `Re-running ${t.title}`,
                    );
                  }}
                />,
              )
            }
          >
            Re-run with instructions
          </button>
          <button
            type="button"
            className={`${o.btn} type-button`}
            disabled={!COMPLETABLE.has(t.state) || t.kind !== 'work'}
            title={
              COMPLETABLE.has(t.state)
                ? 'The team did this outside the agents: record it as done so it never runs'
                : `Can't record as done while ${t.state}`
            }
            onClick={() =>
              openOverlay(
                <TextForm
                  title={`Mark ${t.title} done`}
                  body="Record that the team did this outside the agents. It moves to done on the record and never runs; the note goes in the Decision Log."
                  label="What was done, and where"
                  placeholder="e.g. Layouts rebuilt by hand on the CM from the live site"
                  submitLabel="Mark done"
                  onSubmit={(note) => {
                    closeOverlay();
                    void run(
                      () =>
                        post(`/projects/${projectId}/tasks/complete`, {
                          taskIds: [t.taskId],
                          note,
                        }),
                      `Recorded ${t.title} as done`,
                    );
                  }}
                />,
              )
            }
          >
            Mark done
          </button>
          <button
            type="button"
            className={`${o.btn} ${o.danger} type-button`}
            disabled={t.state !== 'done'}
            onClick={() =>
              openOverlay(
                <TypedConfirm
                  title={`Roll back ${t.title}?`}
                  body={
                    t.contract
                      ? `${t.contract.rollback}. Downstream tasks that used this output re-plan.`
                      : 'The task output is reverted. Downstream tasks that used it re-plan.'
                  }
                  confirmLabel="Roll back"
                  onConfirm={() => {
                    closeOverlay();
                    void run(() => post(`${base}/rollback`), `Rolling back ${t.title}`);
                  }}
                />,
              )
            }
          >
            Roll back
          </button>
          <button
            type="button"
            className={`${o.btn} ${o.danger} type-button`}
            disabled={['done', 'cancelled', 'rolled_back'].includes(t.state) || t.kind !== 'work'}
            onClick={() =>
              openOverlay(
                <TypedConfirm
                  title={`Cancel ${t.title}?`}
                  body="For work the project no longer needs. The task stops and won't run, along with the later tasks for the same item (registering a component after its port, for example). Anything waiting on it carries on, and an open card about it closes."
                  confirmLabel="Cancel the task"
                  onConfirm={() => {
                    closeOverlay();
                    void run(
                      () =>
                        post(`/projects/${projectId}/control`, {
                          verb: 'cancel',
                          scope: { kind: 'task', id: t.taskId },
                        }),
                      `Cancelling ${t.title}`,
                    );
                  }}
                />,
              )
            }
          >
            Cancel task
          </button>
        </div>
      </div>
    </>
  );
}
