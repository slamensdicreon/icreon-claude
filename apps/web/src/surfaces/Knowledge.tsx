import type {
  KnowledgeEffect,
  KnowledgeEntry,
  KnowledgeList,
  LessonsSnapshot,
  PortfolioItem,
} from '@lw/contracts';
import { useEffect, useState } from 'react';
import { get, messageOf, post, postFor, put } from '../lib/api';
import { age } from '../lib/fmt';
import { useApp, useNow } from '../state';

const KIND_LABEL: Record<KnowledgeEntry['kind'], string> = {
  lesson: 'Lesson',
  procedure: 'Procedure',
  gap: 'Needs engineering',
};
const STATUS_ORDER: KnowledgeEntry['status'][] = ['proposed', 'active', 'retired'];
const STATUS_LABEL: Record<KnowledgeEntry['status'], string> = {
  proposed: 'Proposed: waiting for you',
  active: 'Active',
  retired: 'Retired',
};
const HISTORY: Record<string, string> = {
  created: 'Created',
  edited: 'Edited',
  activated: 'Approved',
  retired: 'Retired',
  proposed: 'Proposed again',
  used: 'Put in a brief',
};

const PLATFORM: Record<string, string> = { sitecoreai: 'SitecoreAI', optimizely: 'Optimizely' };

function scopeLabel(e: KnowledgeEntry, projects: { id: string; name: string }[]) {
  const { kind, id } = e.scope;
  if (kind === 'global') return 'Everywhere';
  if (kind === 'platform') return `Every ${PLATFORM[id] ?? id} project`;
  if (kind === 'playbook') return `The ${id} playbook`;
  if (kind === 'role') return `The ${id} role`;
  return `Project: ${projects.find((p) => p.id === id)?.name ?? id}`;
}

/**
 * One knowledge entry: what to know, where it applies, what it stands on and how it has done;
 * approve, edit, reject or retire it.
 */
function KnowledgeCard({
  e,
  effect,
  projects,
  onChange,
}: {
  e: KnowledgeEntry;
  effect?: KnowledgeEffect;
  projects: { id: string; name: string }[];
  onChange: () => void;
}) {
  // Keeps the relative times ("12 min ago") current.
  useNow(15_000);
  const { toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(e.title);
  const [text, setText] = useState(e.text);
  const [history, setHistory] = useState<{ at: string; kind: string }[] | null>(null);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      onChange();
    } catch (err) {
      toast(messageOf(err, 'That did not work. Try again.'));
    }
  };
  const flagged = effect?.flagged ?? false;
  return (
    <article className={`rule ${e.status}${flagged ? ' flagged' : ''}`}>
      <header>
        <span className="mono">{e.ref}</span>
        <span className="pcard-pill">{KIND_LABEL[e.kind]}</span>
        <span className="muted">{scopeLabel(e, projects)}</span>
        {e.roles.length > 0 && <span className="muted">For {e.roles.join(', ')}</span>}
        {e.operations.length > 0 && (
          <span className="muted mono">{e.operations.slice(0, 3).join(', ')}</span>
        )}
      </header>
      {editing ? (
        <div className="rule-edit">
          <label className="eyebrow" htmlFor={`kt-${e.id}`}>
            The problem
          </label>
          <input
            id={`kt-${e.id}`}
            className="input"
            value={title}
            onChange={(x) => setTitle(x.target.value)}
          />
          <label className="eyebrow" htmlFor={`kx-${e.id}`}>
            What to know or do
          </label>
          <textarea
            id={`kx-${e.id}`}
            className="input"
            rows={3}
            value={text}
            onChange={(x) => setText(x.target.value)}
          />
        </div>
      ) : (
        <>
          <p className="rule-text">
            <b>{e.title}</b>
          </p>
          <p className="rule-text">{e.text}</p>
        </>
      )}
      <p className="rule-facts muted">
        {e.kind === 'gap'
          ? 'Not put in briefs: it needs a change in code, a tool or a permission. '
          : `In ${e.used} ${e.used === 1 ? 'brief' : 'briefs'}${
              effect?.tasks
                ? `; ${effect.failed} of the ${effect.tasks} ${effect.tasks === 1 ? 'task' : 'tasks'} that carried it were still rejected or sent back`
                : ''
            }${flagged ? ': it isn’t preventing what it’s about, so edit or retire it' : ''}. `}
        Version {e.version}, by{' '}
        {e.author === 'cypher' ? 'Cypher' : e.author === 'seed' ? 'the platform’s pitfalls' : 'you'}
        , {age(e.updatedAt)}.
      </p>
      <div className="btn-row">
        {e.status === 'proposed' && (
          <button
            className="btn sm primary"
            onClick={() =>
              void act(
                () => post(`/knowledge/${e.id}/approve`),
                e.kind === 'gap'
                  ? `${e.ref} is on engineering's list.`
                  : `${e.ref} is active: briefs it fits carry it now.`,
              )
            }
          >
            Approve
          </button>
        )}
        {editing ? (
          <>
            <button
              className="btn sm primary"
              disabled={title.trim().length < 3 || text.trim().length < 3}
              onClick={() =>
                void act(() => put(`/knowledge/${e.id}`, { title, text }), `${e.ref} saved.`).then(
                  () => setEditing(false),
                )
              }
            >
              Save
            </button>
            <button className="btn sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </>
        ) : (
          e.status !== 'retired' && (
            <button className="btn sm" onClick={() => setEditing(true)}>
              Edit
            </button>
          )
        )}
        {e.status !== 'retired' && (
          <button
            className="btn sm"
            onClick={() =>
              void act(
                () => post(`/knowledge/${e.id}/${e.status === 'proposed' ? 'reject' : 'retire'}`),
                `${e.ref} is ${e.status === 'proposed' ? 'rejected' : 'retired'}.`,
              )
            }
          >
            {e.status === 'proposed' ? 'Reject' : 'Retire'}
          </button>
        )}
        <button
          className="link-btn"
          aria-expanded={history !== null}
          onClick={() =>
            history
              ? setHistory(null)
              : void get<{ at: string; kind: string }[]>(`/knowledge/${e.id}/history`).then(
                  setHistory,
                )
          }
        >
          {history ? 'Hide history' : 'History'}
        </button>
      </div>
      {history && (
        <ul className="rule-history">
          {history.slice(-12).map((h, i) => (
            <li key={i}>
              {HISTORY[h.kind] ?? h.kind} {age(h.at)}
            </li>
          ))}
        </ul>
      )}
      {e.evidence.length > 0 && e.author !== 'seed' && (
        <details>
          <summary>What it stands on ({e.evidence.length})</summary>
          <ul className="rule-history">
            {e.evidence.slice(0, 12).map((x) => (
              <li key={`${x.projectId}:${x.ref}`}>{x.label}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

/**
 * What the team knows across projects: lessons, procedures and gaps. Retrospectives propose them
 * at each phase's end; the active ones that fit a task go in its brief.
 */
export function Knowledge({ projects }: { projects: PortfolioItem[] }) {
  const { toast } = useApp();
  const [data, setData] = useState<KnowledgeList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | KnowledgeEntry['kind']>('all');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const load = () =>
    get<KnowledgeList>('/knowledge')
      .then((r) => (setData(r), setError(null)))
      .catch((e: unknown) => setError(messageOf(e, 'Knowledge could not be loaded.')));
  useEffect(() => {
    void load();
  }, []);
  if (error && !data) return <p className="quiet-line">{error}</p>;
  if (!data) return <p className="quiet-line">Loading knowledge…</p>;
  const words = q.trim().toLowerCase();
  const shown = data.entries.filter(
    (e) =>
      (kind === 'all' || e.kind === kind) &&
      (!words || `${e.ref} ${e.title} ${e.text} ${e.tags.join(' ')}`.toLowerCase().includes(words)),
  );
  const effects = new Map(data.effects.map((x) => [x.id, x]));
  const exportPlatform = async (platform: string) => {
    try {
      const md = await get<string>(`/knowledge/export?platform=${platform}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.download = `${platform}-lessons.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast(messageOf(e, 'The export did not work.'));
    }
  };
  return (
    <section className="rules">
      <p className="muted">
        What the team knows across projects. The active entries that fit a task go in its brief;
        each phase&rsquo;s retrospective proposes new ones from what the phase cost, and none apply
        until you approve them.
      </p>
      <div className="dash-filters" role="group" aria-label="Kind">
        {(['all', 'lesson', 'procedure', 'gap'] as const).map((k) => (
          <button
            key={k}
            className={`dash-chip ${kind === k ? 'on' : ''}`}
            onClick={() => setKind(k)}
          >
            {k === 'all' ? 'Everything' : KIND_LABEL[k]}
            <small>
              {k === 'all' ? data.entries.length : data.entries.filter((e) => e.kind === k).length}
            </small>
          </button>
        ))}
        <input
          className="wiki-search"
          type="search"
          placeholder="Search knowledge"
          aria-label="Search knowledge"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="btn-row">
        <button className="btn sm" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Close' : 'Write a lesson'}
        </button>
        {Object.entries(PLATFORM).map(([id, name]) => (
          <button key={id} className="link-btn" onClick={() => void exportPlatform(id)}>
            Export {name} lessons
          </button>
        ))}
      </div>
      {adding && (
        <NewLesson
          onDone={() => {
            setAdding(false);
            void load();
          }}
        />
      )}
      {STATUS_ORDER.map((status) => {
        const list = shown.filter((e) => e.status === status);
        if (!list.length) return null;
        const body = (
          <div className="rule-list">
            {list.map((e) => (
              <KnowledgeCard
                key={e.id}
                e={e}
                effect={effects.get(e.id)}
                projects={projects}
                onChange={load}
              />
            ))}
          </div>
        );
        return status === 'retired' ? (
          <details key={status}>
            <summary>
              {STATUS_LABEL[status]} <small>{list.length}</small>
            </summary>
            {body}
          </details>
        ) : (
          <div key={status}>
            <h3>
              {STATUS_LABEL[status]} <small>{list.length}</small>
            </h3>
            {body}
          </div>
        );
      })}
      {!shown.length && <p className="quiet-line">Nothing matches.</p>}
    </section>
  );
}

const SCOPES = [
  { value: 'global:*', label: 'Everywhere' },
  ...Object.entries(PLATFORM).map(([id, name]) => ({
    value: `platform:${id}`,
    label: `Every ${name} project`,
  })),
];

function NewLesson({ onDone }: { onDone: () => void }) {
  const { toast } = useApp();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [scope, setScope] = useState(SCOPES[1]!.value);
  const [roles, setRoles] = useState('');
  const save = async () => {
    const [kind, id] = scope.split(':') as [string, string];
    try {
      await post('/knowledge', {
        title,
        text,
        scope: { kind, id },
        roles: roles
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
      });
      toast('Saved: briefs it fits carry it now.');
      onDone();
    } catch (e) {
      toast(messageOf(e, 'It was not saved.'));
    }
  };
  return (
    <div className="rule-harvest rule-edit">
      <label className="eyebrow" htmlFor="nl-t">
        The problem, as an agent meets it
      </label>
      <input id="nl-t" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      <label className="eyebrow" htmlFor="nl-x">
        What to know or do
      </label>
      <textarea
        id="nl-x"
        className="input"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <label className="eyebrow" htmlFor="nl-s">
        Where it applies
      </label>
      <select id="nl-s" className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
        {SCOPES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <label className="eyebrow" htmlFor="nl-r">
        Only for these roles (optional, comma separated role ids)
      </label>
      <input id="nl-r" className="input" value={roles} onChange={(e) => setRoles(e.target.value)} />
      <div className="btn-row">
        <button
          className="btn sm primary"
          disabled={title.trim().length < 3 || text.trim().length < 3}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * A project's retrospectives, in its Workbench: each finished phase, what its retrospective
 * proposed, and the proposals to approve, edit or reject.
 */
export function LessonsLearned({ projectId }: { projectId: string }) {
  const { toast, projects } = useApp();
  const [data, setData] = useState<LessonsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const load = () =>
    get<LessonsSnapshot>(`/projects/${projectId}/lessons`)
      .then((r) => (setData(r), setError(null)))
      .catch((e: unknown) => setError(messageOf(e, 'Lessons could not be loaded.')));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  const run = (phase: number) => {
    setRunning(phase);
    postFor<{ summary: string; proposed: KnowledgeEntry[] }>(
      `/projects/${projectId}/retrospectives`,
      { phase },
    )
      .then((r) => {
        toast(
          r.proposed.length
            ? `${r.proposed.length} proposed. ${r.summary}`
            : `Nothing new to propose. ${r.summary}`,
        );
        void load();
      })
      .catch((e: unknown) => toast(messageOf(e, 'The retrospective did not run.')))
      .finally(() => setRunning(null));
  };
  return (
    <>
      <div className="viewer-head">
        <h2>Lessons learned</h2>
        <span className="muted">retrospectives</span>
      </div>
      <p className="muted">
        At the end of each phase, Cypher reads what it cost (your cards, the Leads&rsquo;
        rejections, waits, failed checks) and proposes what the team should know next time. Nothing
        reaches a brief until you approve it; approved lessons carry to every project they fit.
      </p>
      {error && !data && <p className="quiet-line">{error}</p>}
      {!data && !error && <p className="quiet-line">Loading…</p>}
      {data && (
        <>
          <table>
            <thead>
              <tr>
                <th>Phase</th>
                <th>Proposed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.phases.map((p) => (
                <tr key={p.phase}>
                  <td>
                    {p.phase}. {p.name}
                  </td>
                  <td>{p.exited ? p.proposed : <span className="muted">not finished</span>}</td>
                  <td>
                    {p.exited && (
                      <button
                        className="btn sm"
                        disabled={!data.available || running !== null}
                        title={data.available ? undefined : 'Needs Claude, and none is configured.'}
                        onClick={() => run(p.phase)}
                      >
                        {running === p.phase
                          ? 'Cypher is reading the phase…'
                          : p.proposed
                            ? 'Run again'
                            : 'Run retrospective'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.entries.length > 0 ? (
            <div className="rules">
              {STATUS_ORDER.map((status) => {
                const list = data.entries.filter((e) => e.status === status);
                if (!list.length) return null;
                return (
                  <div key={status}>
                    <h3>
                      {STATUS_LABEL[status]} <small>{list.length}</small>
                    </h3>
                    <div className="rule-list">
                      {list.map((e) => (
                        <KnowledgeCard key={e.id} e={e} projects={projects} onChange={load} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="quiet-line">No proposals yet.</p>
          )}
        </>
      )}
    </>
  );
}
