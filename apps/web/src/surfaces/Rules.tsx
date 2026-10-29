import {
  DECISION_CATEGORY_LABEL,
  type PortfolioItem,
  type RuleHistoryItem,
  type RuleView,
} from '@lw/contracts';
import { useEffect, useState } from 'react';
import { ApiProblem, get, post, postFor, put } from '../lib/api';
import { age } from '../lib/fmt';
import { useApp } from '../state';

const STATUS_ORDER: RuleView['status'][] = ['proposed', 'active', 'retired'];
const STATUS_LABEL: Record<RuleView['status'], string> = {
  proposed: 'Proposed: waiting for you',
  active: 'Active',
  retired: 'Retired',
};
const HISTORY: Record<RuleHistoryItem['kind'], string> = {
  created: 'Created',
  edited: 'Edited',
  activated: 'Activated',
  retired: 'Retired',
  applied: 'Applied',
  overridden: 'Overridden by you',
};

/**
 * Rules from the Director's answers, across every project: when this happens, do that. Lead
 * triage applies the active ones in their scope; proposed ones wait here for approval.
 */
export function Rules({ projects }: { projects: PortfolioItem[] }) {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    get<RuleView[]>('/rules')
      .then((r) => (setRules(r), setError(null)))
      .catch((e: unknown) =>
        setError(e instanceof ApiProblem ? e.message : 'Rules could not be loaded.'),
      );
  useEffect(() => {
    void load();
  }, []);
  if (error && !rules) return <p className="quiet-line">{error}</p>;
  if (!rules) return <p className="quiet-line">Loading rules…</p>;
  const harvest = <Harvest projects={projects.filter((p) => !p.demo)} onDone={load} />;
  if (!rules.length)
    return (
      <section className="rules">
        {harvest}
        <p className="quiet-line">
          No rules yet. On a card you answered, choose “Make this a rule”: the Leads then apply it
          to the next card like it, so you aren’t asked again.
        </p>
      </section>
    );
  const scopeLabel = (r: RuleView) =>
    r.scope.kind === 'project'
      ? `Project: ${projects.find((p) => p.id === r.scope.id)?.name ?? r.scope.id}`
      : r.scope.kind === 'playbook'
        ? `Every project on the ${r.scope.id} playbook`
        : `Every project on the ${r.scope.id} platform`;
  return (
    <section className="rules">
      {harvest}
      {STATUS_ORDER.map((status) => {
        const list = rules.filter((r) => r.status === status);
        if (!list.length) return null;
        return (
          <div key={status}>
            <h3>
              {STATUS_LABEL[status]} <small>{list.length}</small>
            </h3>
            <div className="rule-list">
              {list.map((r) => (
                <RuleCard key={r.id} r={r} scope={scopeLabel(r)} onChange={load} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function RuleCard({ r, scope, onChange }: { r: RuleView; scope: string; onChange: () => void }) {
  const { toast } = useApp();
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(r.when);
  const [then, setThen] = useState(r.then);
  const [history, setHistory] = useState<RuleHistoryItem[] | null>(null);
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      onChange();
    } catch (e) {
      toast(e instanceof ApiProblem ? e.message : 'That did not work. Try again.');
    }
  };
  return (
    <article className={`rule ${r.status}${r.flagged ? ' flagged' : ''}`}>
      <header>
        <span className="mono">{r.ref}</span>
        <span className="pcard-pill">{DECISION_CATEGORY_LABEL[r.category]}</span>
        <span className="muted">{scope}</span>
        {r.roles.length > 0 && <span className="muted">Only for {r.roles.join(', ')}</span>}
      </header>
      {editing ? (
        <div className="rule-edit">
          <label className="eyebrow" htmlFor={`w-${r.id}`}>
            When
          </label>
          <textarea
            id={`w-${r.id}`}
            className="input"
            rows={2}
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
          <label className="eyebrow" htmlFor={`t-${r.id}`}>
            Do this
          </label>
          <textarea
            id={`t-${r.id}`}
            className="input"
            rows={2}
            value={then}
            onChange={(e) => setThen(e.target.value)}
          />
        </div>
      ) : (
        <p className="rule-text">
          <b>When</b> {r.when}, <b>then</b> {r.then}.
        </p>
      )}
      <p className="rule-facts muted">
        Applied {r.applied} {r.applied === 1 ? 'time' : 'times'}, overridden {r.overridden}
        {r.flagged ? ': you keep overriding it, so edit or retire it' : ''}. Version {r.version},
        from {r.sources.length} {r.sources.length === 1 ? 'card' : 'cards'}, by{' '}
        {r.author === 'cypher' ? 'Cypher' : 'you'}, {age(r.updatedAt)}.
      </p>
      <div className="btn-row">
        {r.status === 'proposed' && (
          <button
            className="btn sm primary"
            onClick={() => void act(() => post(`/rules/${r.id}/activate`), `${r.ref} is active.`)}
          >
            Approve
          </button>
        )}
        {editing ? (
          <>
            <button
              className="btn sm primary"
              disabled={when.trim().length < 3 || then.trim().length < 3}
              onClick={() =>
                void act(() => put(`/rules/${r.id}`, { when, then }), `${r.ref} saved.`).then(() =>
                  setEditing(false),
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
          r.status !== 'retired' && (
            <button className="btn sm" onClick={() => setEditing(true)}>
              Edit
            </button>
          )
        )}
        {r.status !== 'retired' && (
          <button
            className="btn sm"
            onClick={() => void act(() => post(`/rules/${r.id}/retire`), `${r.ref} is retired.`)}
          >
            {r.status === 'proposed' ? 'Reject' : 'Retire'}
          </button>
        )}
        <button
          className="link-btn"
          aria-expanded={history !== null}
          onClick={() =>
            history
              ? setHistory(null)
              : void get<RuleHistoryItem[]>(`/rules/${r.id}/history`).then(setHistory)
          }
        >
          {history ? 'Hide history' : 'History'}
        </button>
      </div>
      {history && (
        <ul className="rule-history">
          {history.map((h, i) => (
            <li key={i}>
              {HISTORY[h.kind]} {age(h.at)}
              {typeof h.detail.escalationId === 'string' &&
              !h.detail.escalationId.startsWith('task:')
                ? ` (card ${h.detail.escalationId})`
                : ''}
            </li>
          ))}
        </ul>
      )}
      {r.sources.length > 0 && (
        <details>
          <summary>The cards it came from</summary>
          <ul className="rule-history">
            {r.sources.slice(0, 10).map((s) => (
              <li key={s.escalationId}>
                {s.title}
                {s.answer ? `: ${s.answer}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

/** Cypher reads a project's answered cards and proposes a rule for each cause seen twice or more. */
function Harvest({ projects, onDone }: { projects: PortfolioItem[]; onDone: () => void }) {
  const { toast } = useApp();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  if (!projects.length) return null;
  return (
    <div className="rule-harvest">
      <label className="eyebrow" htmlFor="rh-p">
        Propose rules from a project’s answers
      </label>
      <div className="btn-row">
        <select
          id="rh-p"
          className="select"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          className="btn sm"
          disabled={busy || !projectId}
          onClick={() => {
            setBusy(true);
            postFor<{ proposed: RuleView[] }>(`/projects/${projectId}/rules/harvest`, {})
              .then((r) => {
                toast(
                  r.proposed.length
                    ? `${r.proposed.length} rule${r.proposed.length === 1 ? '' : 's'} proposed. Approve the ones that hold.`
                    : 'No new causes to propose: each repeated answer already has a rule.',
                );
                onDone();
              })
              .catch((e: unknown) =>
                toast(e instanceof ApiProblem ? e.message : 'Rules could not be proposed.'),
              )
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Cypher is reading the answers…' : 'Propose rules'}
        </button>
      </div>
    </div>
  );
}
