import type { PreviewSnapshot } from '@lw/contracts';
import { clock } from '../lib/fmt';
import { Icon } from '../lib/icons';
import { Card } from '../parts/Card';
import { useApp, useMission, useProjectResource, useRoster, useTz } from '../state';

const clean = (op: string) =>
  op
    .replace(/Renderings\/Project\/[^/]+\/Page Content\//, '')
    .replace(/Templates\/Project\/[^/]+\//, '')
    .replace(/Project\/[^/]+\/Thumbnails\//, '');

export function Mission() {
  const { ui, setUi, go, layout } = useApp();
  const mc = useMission().data;
  const { agents, byId } = useRoster();
  const tz = useTz();
  const preview = useProjectResource<PreviewSnapshot>(layout.present ? '/preview' : null).data;
  if (!mc) return <p className="quiet-line">Loading Mission Control…</p>;
  const p = mc.project;
  const phases = mc.phases;
  const current = phases.filter((x) => x.status === 'current');
  const lead = current[0];
  const nextGate = phases.find((x) => x.gate === 'director' && x.status !== 'done');
  const open = mc.waitingOnYou;
  const parity = mc.metrics.find((m) => m.key === 'parity');
  const running = phases.reduce((n, x) => n + x.tasksRunning, 0);
  const queued = phases.reduce((n, x) => n + x.tasksQueued, 0);

  return (
    <>
      {ui.awayLine && (
        <div className="away">
          <Icon name="information" />
          <span>{ui.awayLine}</span>
          <button className="link-btn" onClick={() => setUi({ awayLine: null })}>
            Dismiss
          </button>
        </div>
      )}
      {layout.present ? (
        <h1 className="present-title">
          {p.target?.site ?? p.name} on SitecoreAI, phase {lead?.number ?? 0} of {phases.length - 1}
        </h1>
      ) : (
        <div className="page-head">
          <div>
            <h1>Mission Control</h1>
            <p>{mc.subtitle}</p>
          </div>
        </div>
      )}
      <section className="panel hide-present" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h2>Waiting on you{open.length > 0 && <small>{open.length}</small>}</h2>
        </div>
        {open.length ? (
          <div className="waitgrid">
            {open.map((x) => (
              <Card key={x.escalationId} x={x} mode="compact" projectName={p.name} />
            ))}
          </div>
        ) : (
          <p className="quiet-line">
            Nothing needs you.
            {nextGate ? ` Next gate: ${nextGate.shortName}, phase ${nextGate.number}.` : ''}
          </p>
        )}
      </section>
      <div className="statgrid">
        {mc.stats.map((s) => (
          <div className="statcard" key={s.key}>
            <div className="k">
              <Icon name={s.icon ?? 'dashboard'} sm />
              {s.label}
            </div>
            <div className="v tnum">
              {s.value ?? '–'}
              {s.total !== null && <small>/ {s.total}</small>}
            </div>
            <div className="bar">
              <i
                style={{ width: `${s.value !== null && s.total ? (s.value / s.total) * 100 : 0}%` }}
              />
            </div>
            <div className="d">{s.value === null ? 'Not yet measured' : s.note}</div>
          </div>
        ))}
      </div>
      <div className="grid">
        <section className="panel">
          <div className="panel-head">
            <h2>Phase progress</h2>
            <button className="link-btn hide-present" onClick={() => go('plan')}>
              Open plan
            </button>
          </div>
          <div className="stepper">
            {phases.map((x, i) => (
              <span key={x.number} style={{ display: 'contents' }}>
                <span
                  className={`step ${x.status === 'done' ? 'done' : x.status === 'current' ? 'current' : ''}${x.gate === 'director' ? ' gate' : ''}`}
                  title={`${x.shortName}${x.gateLabel ? `, ${x.gateLabel}` : ''}`}
                />
                {i < phases.length - 1 && (
                  <span className={`step-line ${x.status !== 'done' ? 'todo' : ''}`} />
                )}
              </span>
            ))}
          </div>
          <div className="kv">
            <span className="muted">Current</span>
            <span className="v">
              {lead
                ? `Phase ${lead.number}, ${lead.shortName}, ${lead.percent ?? 0}%${
                    current.length > 1
                      ? ` (with phase ${current
                          .slice(1)
                          .map((c) => c.number)
                          .join(', ')})`
                      : ''
                  }`
                : '–'}
            </span>
            <span className="muted">Next gate</span>
            <span className="v">
              {nextGate ? `${nextGate.shortName}, phase ${nextGate.number}` : 'None'}
            </span>
            <span className="muted">Tasks</span>
            <span className="v">
              {running} running, {queued} queued
            </span>
            <span className="muted">Parity</span>
            <span className="v">
              {parity?.value == null ? 'Not yet measured' : `${parity.value}%`}
            </span>
          </div>
        </section>
        <section className="panel hide-present">
          <div className="panel-head">
            <h2>Team now</h2>
            <button className="link-btn" onClick={() => go('team')}>
              Open team
            </button>
          </div>
          {mc.teamNow.map((row) => {
            const la = byId(row.agentId);
            const team = agents.filter((a) => a.reportsTo === row.agentId);
            const paused = team.filter((a) => a.state === 'paused').length;
            const parts = [
              row.active && `${row.active} active`,
              row.blocked && `${row.blocked} blocked`,
              row.waiting && `${row.waiting} waiting`,
              paused && `${paused} paused`,
            ].filter(Boolean);
            const txt =
              la?.state === 'done'
                ? row.waiting
                  ? `Done, ${row.waiting} consult open`
                  : 'Done'
                : la?.state === 'idle'
                  ? (la.now ?? 'Idle')
                  : parts.join(', ') || 'Standing by';
            const dot = row.blocked
              ? 'bad'
              : row.waiting || paused
                ? 'warn'
                : la?.state === 'active'
                  ? 'good'
                  : 'idle';
            return (
              <button key={row.agentId} className="teamrow" onClick={() => go('team')}>
                <span className={`dot ${dot}`} />
                <span className="n">
                  {la?.persona ?? row.name}{' '}
                  <small className="muted" style={{ fontWeight: 400 }}>
                    {row.name}
                  </small>
                </span>
                <span className="c">{txt}</span>
              </button>
            );
          })}
        </section>
        <section className="panel span hide-present">
          <div className="panel-head">
            <h2>Latest from the team</h2>
            <button className="link-btn" onClick={() => go('activity')}>
              Open activity
            </button>
          </div>
          {mc.latest.map((a) => {
            const who = byId(a.agentId);
            const name = who
              ? who.tier === 'chief_of_staff'
                ? 'Cypher'
                : (who.persona ?? who.name)
              : a.actorId === 'director'
                ? 'You'
                : 'Tool server';
            const sev = a.severity === 'failure' ? 'bad' : a.severity === 'warning' ? 'warn' : '';
            return (
              <div className={`event ${sev}`} key={a.seq}>
                <time>{clock(a.ts, tz)}</time>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    go('activity');
                  }}
                >
                  {name}: {clean(a.operation ?? a.summary)}
                </a>
              </div>
            );
          })}
        </section>
        <section className="panel present-only">
          <div className="panel-head">
            <h2>Site preview</h2>
          </div>
          <div className="shot">
            {preview?.target
              ? `${preview.target.label}. ${preview.pages.filter((x) => x.migrated).length} of ${preview.pages.length} built.`
              : 'The SitecoreAI build appears here once the first preview deploys.'}
          </div>
        </section>
      </div>
    </>
  );
}
