import type { PlaybookSummary, PortfolioDiagnostics, PortfolioItem } from '@lw/contracts';
import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { age, usd } from '../lib/fmt';
import { Icon } from '../lib/icons';
import { NewProject } from '../overlays/NewProject';
import { useApp } from '../state';

type Tab = 'projects' | 'playbooks' | 'diagnostics';
type Filter = 'active' | 'needs' | 'completed' | 'all';

const DOT = { healthy: 'good', attention: 'warn', blocked: 'bad' } as const;
const STATUS: Record<PortfolioItem['status'], string> = {
  intake: 'Ready to start',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  archived: 'Archived',
};
const DONE = new Set(['completed', 'cancelled', 'archived']);

/** "just now", "12 min ago", "3 h ago", "4 days ago": a glance, not a timestamp. */
function since(t: string): string {
  const h = (Date.now() - Date.parse(t)) / 3_600_000;
  if (h < 2) return age(t);
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Poll a JSON resource while the Dashboard is open. */
function usePoll<T>(path: string | null, everyMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const load = () =>
      get<T>(path)
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const t = window.setInterval(load, everyMs);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [path, everyMs]);
  return { data, error };
}

/**
 * The home screen, above any one project: every project and where it stands, the playbooks a new
 * project can run, and the health of the services and orchestrators behind them.
 */
export function Dashboard() {
  const { openOverlay } = useApp();
  const [tab, setTab] = useState<Tab>('projects');
  const portfolio = usePoll<PortfolioItem[]>('/portfolio', 10_000);
  const needs = (portfolio.data ?? []).filter((p) => p.waitingCount > 0).length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Every project, the playbooks you can run, and how the system is doing.</p>
        </div>
        <button className="btn primary" onClick={() => openOverlay(<NewProject />)}>
          New project
        </button>
      </div>
      <div className="dash-tabs" role="tablist">
        {(
          [
            ['projects', 'Projects', needs ? `${needs} need you` : null],
            ['playbooks', 'Playbooks', null],
            ['diagnostics', 'Diagnostics', null],
          ] as [Tab, string, string | null][]
        ).map(([key, label, note]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'on' : ''}
            onClick={() => setTab(key)}
          >
            {label}
            {note && <small>{note}</small>}
          </button>
        ))}
      </div>
      {tab === 'projects' && <Projects items={portfolio.data} error={portfolio.error} />}
      {tab === 'playbooks' && <Playbooks projects={portfolio.data ?? []} />}
      {tab === 'diagnostics' && <Diagnostics />}
    </>
  );
}

function Projects({ items, error }: { items: PortfolioItem[] | null; error: string | null }) {
  const { switchProject } = useApp();
  const [filter, setFilter] = useState<Filter>('active');
  if (error && !items) return <p className="quiet-line">Projects could not be loaded: {error}</p>;
  if (!items) return <p className="quiet-line">Loading projects…</p>;
  const shown = items.filter((p) =>
    filter === 'all'
      ? true
      : filter === 'completed'
        ? DONE.has(p.status)
        : filter === 'needs'
          ? p.waitingCount > 0
          : !DONE.has(p.status),
  );
  const count = (f: Filter) =>
    items.filter((p) =>
      f === 'all'
        ? true
        : f === 'completed'
          ? DONE.has(p.status)
          : f === 'needs'
            ? p.waitingCount > 0
            : !DONE.has(p.status),
    ).length;
  return (
    <section>
      <div className="dash-filters">
        {(
          [
            ['active', 'Active'],
            ['needs', 'Needs me'],
            ['completed', 'Completed'],
            ['all', 'All'],
          ] as [Filter, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`dash-chip ${filter === key ? 'on' : ''}`}
            onClick={() => setFilter(key)}
          >
            {label} <small>{count(key)}</small>
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="quiet-line">No projects here.</p>
      ) : (
        <div className="dash-grid">
          {shown.map((p) => (
            <ProjectCard key={p.id} p={p} open={() => switchProject(p.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectCard({ p, open }: { p: PortfolioItem; open: () => void }) {
  const done = DONE.has(p.status);
  const pct = p.budgets.usd ? Math.round((p.spent.usd / p.budgets.usd) * 100) : 0;
  return (
    <article className={`pcard ${done ? 'done' : ''}`}>
      <button className="pcard-main" onClick={open} aria-label={`Open ${p.name}`}>
        <div className="pcard-head">
          <span className="ini">{p.initials}</span>
          <span className="pcard-t">
            <b>
              {p.name}
              {p.demo && <span className="pm-demo">Demo</span>}
            </b>
            <small>
              {p.client}
              {p.playbook ? ` · ${p.playbook.id} ${p.playbook.version}` : ''}
            </small>
          </span>
          <span className={`dot ${DOT[p.health]}`} title={p.healthReason ?? p.health} />
        </div>
        <div className="pcard-status">
          <span className="pcard-pill">{STATUS[p.status]}</span>
          {p.currentPhase && !done && (
            <span>
              Phase {p.currentPhase.number}, {p.currentPhase.name}: {p.currentPhase.percent}%
            </span>
          )}
        </div>
        <div className="pcard-bar" aria-label={`${p.phases.done} of ${p.phases.total} phases done`}>
          <span
            style={{ width: `${p.phases.total ? (p.phases.done / p.phases.total) * 100 : 0}%` }}
          />
        </div>
        <dl className="pcard-facts">
          <div>
            <dt>Phases</dt>
            <dd>
              {p.phases.done} of {p.phases.total}
            </dd>
          </div>
          <div>
            <dt>Spend</dt>
            <dd>
              {usd(p.spent.usd)}{' '}
              <small>
                of {usd(p.budgets.usd)} ({pct}%)
              </small>
            </dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>{p.lastActivityAt ? since(p.lastActivityAt) : 'None yet'}</dd>
          </div>
        </dl>
        {(p.waitingCount > 0 || p.capabilityGaps > 0 || (p.healthReason && !done)) && (
          <ul className="pcard-notes">
            {p.waitingCount > 0 && (
              <li className="warn">
                {p.waitingCount} card{p.waitingCount === 1 ? '' : 's'} waiting on you
              </li>
            )}
            {p.capabilityGaps > 0 && (
              <li>
                {p.capabilityGaps} capability gap{p.capabilityGaps === 1 ? '' : 's'}
              </li>
            )}
            {p.healthReason && !done && <li>{p.healthReason}</li>}
          </ul>
        )}
      </button>
      <div className="pcard-links">
        {p.liveUrl && (
          <a href={p.liveUrl} target="_blank" rel="noreferrer">
            <Icon name="link" sm /> New site
          </a>
        )}
        {p.sourceUrl && (
          <a href={p.sourceUrl} target="_blank" rel="noreferrer">
            <Icon name="link" sm /> Source site
          </a>
        )}
        <button className="link-btn" onClick={open}>
          {done ? 'View history' : 'Mission Control'}
        </button>
      </div>
    </article>
  );
}

function Playbooks({ projects }: { projects: PortfolioItem[] }) {
  const { openOverlay } = useApp();
  const { data, error } = usePoll<PlaybookSummary[]>('/playbooks', 60_000);
  if (error && !data) return <p className="quiet-line">Playbooks could not be loaded: {error}</p>;
  if (!data) return <p className="quiet-line">Loading playbooks…</p>;
  return (
    <section className="dash-playbooks">
      {data.map((pb) => {
        const ran = projects.filter((p) => p.playbook?.id === pb.id);
        return (
          <article key={pb.id} className="panel">
            <div className="panel-head">
              <h2>
                {pb.name} <small>{pb.version}</small>
              </h2>
              <button className="btn sm primary" onClick={() => openOverlay(<NewProject />)}>
                Start a project
              </button>
            </div>
            <p>{pb.description}</p>
            <p className="muted">
              {pb.platform.name} · {pb.charter.mission}
            </p>
            <h3>Outcomes</h3>
            <ul className="dash-list">
              {pb.charter.outcomes.map((o) => (
                <li key={o.id}>
                  <b>{o.title}.</b> {o.measure}
                </li>
              ))}
            </ul>
            {pb.phases.length > 0 && (
              <>
                <h3>Phases</h3>
                <ol className="dash-phases" start={0}>
                  {pb.phases.map((ph) => (
                    <li key={ph.number}>
                      {ph.name}
                      {ph.gate && <span className="pcard-pill">{ph.gate}</span>}
                    </li>
                  ))}
                </ol>
              </>
            )}
            {pb.roles.length > 0 && (
              <details>
                <summary>The team ({pb.roles.length} roles)</summary>
                <ul className="dash-list">
                  {pb.roles.map((r) => (
                    <li key={r.role}>
                      <b>{r.name}.</b> {r.description}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <details>
              <summary>What intake asks for</summary>
              <ul className="dash-list">
                <li>
                  Source repository: {pb.intake.source.repo}; live site: {pb.intake.source.url}
                </li>
                {pb.intake.steps.map((st) => (
                  <li key={st.title}>
                    <b>{st.title}.</b> {st.intro}
                  </li>
                ))}
                <li>{pb.intake.brief.length} brief questions</li>
              </ul>
            </details>
            <p className="muted">
              {ran.length
                ? `Projects on it: ${ran.map((p) => `${p.name} (${p.playbook?.version})`).join(', ')}`
                : 'No projects on it yet.'}
            </p>
          </article>
        );
      })}
    </section>
  );
}

function Diagnostics() {
  const { switchProject } = useApp();
  const { data, error } = usePoll<PortfolioDiagnostics>('/portfolio/diagnostics', 30_000);
  if (error && !data) return <p className="quiet-line">Diagnostics could not be loaded: {error}</p>;
  if (!data) return <p className="quiet-line">Checking services and projects…</p>;
  const tone = (s: string) =>
    s === 'ok'
      ? 'good'
      : s === 'degraded' || s === 'stalled'
        ? 'warn'
        : s === 'unknown'
          ? ''
          : 'bad';
  const attention = data.projects.filter(
    (p) => p.attention.length > 0 || p.orchestrator.status === 'stalled',
  );
  return (
    <section className="dash-diag">
      <div className="panel">
        <h2>Services</h2>
        <ul className="diag-rows">
          {data.services.map((s) => (
            <li key={s.key}>
              <span className={`dot ${tone(s.status)}`} />
              <b>{s.label}</b>
              <span className="muted">{s.detail}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="panel">
        <h2>
          Needs attention <small>{attention.length}</small>
        </h2>
        {attention.length === 0 ? (
          <p className="quiet-line">Nothing across projects needs attention.</p>
        ) : (
          <ul className="diag-rows">
            {attention.map((p) => (
              <li key={p.projectId}>
                <span
                  className={`dot ${tone(p.orchestrator.status === 'stalled' ? 'stalled' : 'degraded')}`}
                />
                <button className="link-btn" onClick={() => switchProject(p.projectId)}>
                  {p.name}
                </button>
                <span className="muted">{p.attention.join('; ')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="panel">
        <h2>Orchestrators</h2>
        <ul className="diag-rows">
          {data.projects.map((p) => (
            <li key={p.projectId}>
              <span className={`dot ${tone(p.orchestrator.status)}`} />
              <b>{p.name}</b>
              <span className="muted">
                {STATUS[p.status]} · {p.orchestrator.detail}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
