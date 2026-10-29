import type {
  ConnectionView,
  IntakeCredentialSpec,
  PlaybookSummary,
  PortfolioDiagnostics,
  PortfolioItem,
  RemixDraft,
} from '@lw/contracts';
import { useEffect, useState } from 'react';
import { ApiProblem, get, post, put } from '../lib/api';
import { age, usd } from '../lib/fmt';
import { Icon } from '../lib/icons';
import { NewProject } from '../overlays/NewProject';
import { CypherHome } from './CypherHome';
import { useApp } from '../state';

type Tab = 'projects' | 'connections' | 'playbooks' | 'diagnostics';
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
    <div className="dash-split">
      <aside className="dash-cypher" aria-label="Cypher">
        <CypherHome />
      </aside>
      <div className="dash-main">
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
              ['connections', 'Connections', null],
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
        {tab === 'connections' && <Connections projects={portfolio.data ?? []} />}
        {tab === 'playbooks' && <Playbooks projects={portfolio.data ?? []} />}
        {tab === 'diagnostics' && <Diagnostics />}
      </div>
    </div>
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
        {!p.demo && p.playbook && <RemixButton project={p} />}
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

/** Opens the wizard for a new project like this one: its playbook, client, brief and tenant. */
function RemixButton({ project }: { project: PortfolioItem }) {
  const { openOverlay, toast } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="link-btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const draft = await get<RemixDraft>(`/projects/${project.id}/remix`);
          const list = draft.connectionId ? await get<ConnectionView[]>('/connections') : [];
          openOverlay(
            <NewProject
              remix={{
                draft,
                connectionName: list.find((c) => c.id === draft.connectionId)?.name ?? null,
              }}
            />,
          );
        } catch (err) {
          toast(err instanceof ApiProblem ? err.message : 'The remix could not be prepared.');
        } finally {
          setBusy(false);
        }
      }}
    >
      Remix
    </button>
  );
}

/**
 * Saved connections: one tenant's shared facts and sealed secrets, reused by every site on it.
 * Secrets are never shown: a hint, when they were last checked, and a way to replace one.
 */
function Connections({ projects }: { projects: PortfolioItem[] }) {
  const { openOverlay, toast } = useApp();
  const [version, setVersion] = useState(0);
  const { data, error } = usePoll<ConnectionView[]>(`/connections?v=${version}`, 30_000);
  const playbooks = usePoll<PlaybookSummary[]>('/playbooks', 300_000).data;
  const specOf = (credentialId: string): IntakeCredentialSpec | undefined =>
    playbooks
      ?.flatMap((pb) => pb.intake.steps.flatMap((st) => st.credentials))
      .find((c) => c.credentialId === credentialId);
  const reload = () => setVersion((v) => v + 1);
  if (error && !data) return <p className="quiet-line">Connections could not be loaded: {error}</p>;
  if (!data) return <p className="quiet-line">Loading connections…</p>;
  const savedFrom = new Set(data.map((c) => c.createdFrom?.projectId));
  const candidates = projects.filter((p) => !p.demo && p.playbook && !savedFrom.has(p.id));
  return (
    <section className="dash-diag">
      <p className="muted">
        A connection holds what every site on one tenant shares: the environment, its clients and
        Context IDs. New projects on it don&rsquo;t ask for those again, and replacing a secret here
        updates every project that uses it.
      </p>
      {data.map((c) => (
        <article key={c.id} className="panel">
          <div className="panel-head">
            <h2>
              {c.name} <small>{c.platform}</small>
            </h2>
            {c.createdFrom && (
              <button
                className="btn sm primary"
                onClick={async () => {
                  try {
                    const draft = await get<RemixDraft>(
                      `/projects/${c.createdFrom!.projectId}/remix`,
                    );
                    openOverlay(<NewProject remix={{ draft, connectionName: c.name }} />);
                  } catch (err) {
                    toast(err instanceof ApiProblem ? err.message : 'Could not start a project.');
                  }
                }}
              >
                New project on it
              </button>
            )}
          </div>
          <div className="kv">
            {Object.entries(c.target).map(([k, v]) => (
              <span key={k} style={{ display: 'contents' }}>
                <span>{k}</span>
                <span className="v">{Array.isArray(v) ? v.join(', ') : v}</span>
              </span>
            ))}
          </div>
          <h3>Credentials</h3>
          <ul className="diag-rows">
            {c.credentials.map((x) => (
              <ConnectionCredential
                key={x.credentialId}
                connectionId={c.id}
                credential={x}
                spec={specOf(x.credentialId)}
                onDone={() => {
                  reload();
                  toast(`${x.system} replaced for every project on ${c.name}.`);
                }}
              />
            ))}
          </ul>
          <p className="muted">
            {c.createdFrom ? `Saved from ${c.createdFrom.name}. ` : ''}
            {c.projects.length
              ? `Used by ${c.projects.map((p) => p.name).join(', ')}.`
              : 'No project uses it yet.'}
          </p>
        </article>
      ))}
      <SaveConnection candidates={candidates} onSaved={reload} />
    </section>
  );
}

function ConnectionCredential({
  connectionId,
  credential: x,
  spec,
  onDone,
}: {
  connectionId: string;
  credential: ConnectionView['credentials'][number];
  spec: IntakeCredentialSpec | undefined;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const tone = x.ok === true ? 'good' : x.ok === false ? 'bad' : '';
  return (
    <li>
      <span className={`dot ${tone}`} />
      <b>{x.system}</b>
      <span className="muted">
        {x.hint ? `…${x.hint}` : 'Stored'}
        {x.checkedAt ? ` · checked ${since(x.checkedAt)}` : ''}
        {x.detail ? ` · ${x.detail}` : ''}{' '}
        {spec && (
          <button className="link-btn" onClick={() => setOpen((o) => !o)}>
            {open ? 'Cancel' : 'Replace'}
          </button>
        )}
      </span>
      {open && spec && (
        <form
          className="conn-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setProblem(null);
            try {
              await put(`/connections/${connectionId}/credentials/${x.credentialId}`, {
                secret: values,
              });
              setOpen(false);
              setValues({});
              onDone();
            } catch (err) {
              setProblem(err instanceof ApiProblem ? err.message : 'It could not be replaced.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {spec.fields.map((fl) => (
            <label key={fl.key}>
              <span className="eyebrow">{fl.label}</span>
              <input
                className="input"
                type={fl.secret ? 'password' : 'text'}
                autoComplete="new-password"
                spellCheck={false}
                value={values[fl.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [fl.key]: e.target.value }))}
              />
            </label>
          ))}
          {problem && <p className="cred-miss">{problem}</p>}
          <button
            className="btn sm primary"
            disabled={busy || !spec.fields.every((fl) => (values[fl.key] ?? '').trim())}
          >
            {busy ? 'Checking…' : 'Check and replace'}
          </button>
        </form>
      )}
    </li>
  );
}

function SaveConnection({
  candidates,
  onSaved,
}: {
  candidates: PortfolioItem[];
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const [from, setFrom] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (!candidates.length) return null;
  return (
    <form
      className="panel conn-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await post('/connections', { name: name.trim(), fromProject: from });
          toast(`${name.trim()} saved. New projects on that tenant can use it.`);
          setName('');
          setFrom('');
          onSaved();
        } catch (err) {
          toast(err instanceof ApiProblem ? err.message : 'The connection could not be saved.');
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Save a project&rsquo;s tenant as a connection</h2>
      <label>
        <span className="eyebrow">Project</span>
        <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">Choose a project…</option>
          {candidates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.client})
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="eyebrow">Name</span>
        <input
          className="input"
          placeholder="Brands tenant (SitecoreAI production)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button className="btn sm primary" disabled={busy || !from || !name.trim()}>
        {busy ? 'Saving…' : 'Save connection'}
      </button>
    </form>
  );
}
