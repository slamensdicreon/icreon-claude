import type { AgentDetail, ScheduleSnapshot, TaskView } from '@lw/contracts';
import { useEffect, useRef } from 'react';
import { post } from './lib/api';
import { clock, initials, shortDay, tokens } from './lib/fmt';
import { Icon } from './lib/icons';
import { useResource } from './lib/live';
import { TextForm, TypedConfirm } from './overlays/Dialogs';
import { Chip, Who, personOf } from './parts/bits';
import { useApp, useProjectResource, useRoster, useTz } from './state';

/** The drawer over the canvas: one agent or one task, read-only apart from its controls. */
export function Inspector() {
  const { inspector, closeInspector } = useApp();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (inspector)
      window.setTimeout(
        () => ref.current?.querySelector<HTMLButtonElement>('.icon-btn')?.focus(),
        50,
      );
  }, [inspector]);
  return (
    <aside
      ref={ref}
      className={`inspector ${inspector ? 'open' : ''}`}
      aria-label="Inspector"
      aria-hidden={!inspector}
    >
      {inspector?.kind === 'agent' && <AgentPanel id={inspector.id} close={closeInspector} />}
      {inspector?.kind === 'task' && <TaskPanel id={inspector.id} close={closeInspector} />}
    </aside>
  );
}

function Close({ close }: { close: () => void }) {
  return (
    <button className="icon-btn" aria-label="Close" onClick={close}>
      <Icon name="close" />
    </button>
  );
}

function AgentPanel({ id, close }: { id: string; close: () => void }) {
  const { projectId, run, go, ui, inspect } = useApp();
  const { byId } = useRoster();
  const tz = useTz();
  const a = useProjectResource<AgentDetail>(`/agents/${encodeURIComponent(id)}`).data;
  if (!a) return <div className="insp-body quiet-line">Loading…</div>;
  const cos = a.tier === 'chief_of_staff';
  const lead = byId(a.reportsTo);
  const canPause = a.state === 'active' || a.state === 'waiting' || a.state === 'paused';
  const control = (verb: 'pause' | 'resume') =>
    run(() =>
      post(`/projects/${projectId}/control`, { verb, scope: { kind: 'agent', id: a.agentId } }),
    );
  return (
    <>
      <div className="insp-head">
        <span className={`av8 lg ${cos ? 'cy' : ''}`}>{initials(a)}</span>
        <h2>
          {personOf(a)}
          <small>{cos ? 'Chief of Staff' : a.name}</small>
        </h2>
        <Chip state={a.state} />
        <Close close={close} />
      </div>
      <div className="insp-body">
        <div>
          <h3>Role</h3>
          <p style={{ margin: 0, fontSize: 14 }}>{a.description || a.name}</p>
          {a.projectNote && (
            <>
              <h3 style={{ marginTop: 14 }}>On this project</h3>
              <p style={{ margin: 0, fontSize: 14 }}>
                <Who text={a.projectNote} />
              </p>
            </>
          )}
        </div>
        <div className="kv">
          <span className="muted">Model</span>
          <span className="v">{a.modelClass}</span>
          <span className="muted">Reports to</span>
          <span className="v">
            {cos
              ? 'You, Implementation Director'
              : lead
                ? `${personOf(lead)}, ${lead.tier === 'chief_of_staff' ? 'Chief of Staff' : lead.name}`
                : 'Cypher, Chief of Staff'}
          </span>
          <span className="muted">Active in phases</span>
          <span className="v">
            {a.activePhases.length >= 10 ? 'all' : a.activePhases.join(', ') || '–'}
          </span>
          <span className="muted">Tokens this project</span>
          <span className="v">{tokens(a.tokensProject)}</span>
        </div>
        <div>
          <h3>Now</h3>
          <p style={{ margin: 0, fontSize: 13.5 }}>
            {a.now ?? '–'}
            {a.step && (
              <span className="muted">
                {' '}
                (step {a.step.n} of {a.step.of})
              </span>
            )}
          </p>
          {a.taskId && (
            <button
              className="link-btn"
              style={{ marginTop: 4, fontSize: 12.5 }}
              onClick={() => inspect('task', a.taskId!)}
            >
              Open the task
            </button>
          )}
        </div>
        <div>
          <h3>Next</h3>
          <p style={{ margin: 0, fontSize: 14.5 }}>{a.next ? <Who text={a.next.title} /> : '–'}</p>
          {a.next && (
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
              {a.next.when}
            </p>
          )}
        </div>
        <div>
          <h3>Last tool calls</h3>
          <div className="calls">
            {a.lastSteps.length ? (
              a.lastSteps.map((c) => (
                <div key={c.stepId} className={`call ${c.resultCode >= 400 ? 'bad' : ''}`}>
                  <span className="mono muted">{clock(c.ts, tz)}</span>
                  <span>
                    <span className="op">
                      {c.toolServer} · {c.operation}
                    </span>
                  </span>
                  <span className="code">
                    {c.outcome ?? c.resultCode} ·{' '}
                    {c.durationMs < 1000
                      ? `${c.durationMs} ms`
                      : `${(c.durationMs / 1000).toFixed(1)} s`}
                  </span>
                </div>
              ))
            ) : (
              <p className="quiet-line" style={{ margin: 0 }}>
                No tool calls yet.
              </p>
            )}
          </div>
        </div>
        {!cos && (
          <div className="btn-row">
            {a.state === 'paused' ? (
              <button className="btn primary" onClick={() => void control('resume')}>
                Resume
              </button>
            ) : (
              <button className="btn" disabled={!canPause} onClick={() => void control('pause')}>
                Pause this agent
              </button>
            )}
            <button
              className="btn"
              onClick={() => go('activity', { activity: { ...ui.activity, agent: a.agentId } })}
            >
              Open in Activity
            </button>
          </div>
        )}
        <p className="quiet-line" style={{ margin: 0 }}>
          Read-only. Direct the team through Cypher.
        </p>
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
  if (!t) return <div className="insp-body quiet-line">Loading…</div>;
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
  return (
    <>
      <div className="insp-head">
        <h2>
          {t.title}
          {t.groupTitle && <small>{t.groupTitle}</small>}
        </h2>
        <Chip state={t.state} />
        <Close close={close} />
      </div>
      <div className="insp-body">
        <dl className="contract" style={{ margin: 0 }}>
          <dt>Agent</dt>
          <dd>
            {ag ? (
              <button className="link-btn" onClick={() => inspect('agent', ag.agentId)}>
                {personOf(ag)}, {ag.name}
              </button>
            ) : (
              t.role
            )}
          </dd>
          <dt>Window</dt>
          <dd>
            {win ? (
              <>
                {when(win.start)} to {when(win.end)}
                {win.basis !== 'actual' && <span className="muted"> ({win.basis})</span>}
              </>
            ) : (
              '–'
            )}
          </dd>
          <dt>Depends on</dt>
          <dd>{t.dependsOn.length ? t.dependsOn.map(title).join(', ') : 'nothing'}</dd>
          {t.itemKeys.length > 0 && (
            <>
              <dt>Items</dt>
              <dd className="mono" style={{ fontSize: 12.5 }}>
                {t.itemKeys.join(', ')}
              </dd>
            </>
          )}
          {t.contract && (
            <>
              <dt>Inputs</dt>
              <dd>{t.contract.inputs}</dd>
              <dt>Outputs</dt>
              <dd>{t.contract.outputs}</dd>
              <dt>Acceptance</dt>
              <dd>{t.contract.acceptance}</dd>
            </>
          )}
          <dt>Attempts</dt>
          <dd>{attempts}</dd>
          {t.lastReason && (
            <>
              <dt>Last result</dt>
              <dd>
                <Who text={t.lastReason} />
              </dd>
            </>
          )}
          {t.contract && (
            <>
              <dt>Rollback recipe</dt>
              <dd>{t.contract.rollback}</dd>
            </>
          )}
        </dl>
        <div className="btn-row">
          <button
            className="btn"
            disabled={t.state === 'planned' || t.kind !== 'work'}
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
            className="btn danger"
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
        </div>
      </div>
    </>
  );
}
