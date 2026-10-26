import type {
  IntakeCredentialSpec,
  PlaybookSummary,
  ProjectSummary,
  SettingsSnapshot,
} from '@lw/contracts';
import { Fragment, useEffect, useState } from 'react';
import { get, post, put } from '../lib/api';
import { stamp, usd } from '../lib/fmt';
import { TypedConfirm } from '../overlays/Dialogs';
import { GithubAppPanel } from './GithubApp';
import { Chip } from '../parts/bits';
import { TYPE_LABEL } from '../parts/Card';
import { useApp, useMission, useNow, useProjectResource, useTz } from '../state';

const pct = (v: number) => Math.round(v * 100);

function after(min: number | null, behaviour: string): string {
  if (min === null) return behaviour;
  return min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`;
}

/** The playbook catalog, for what a project's playbook declares (its charter, its credentials). */
function usePlaybooks(): PlaybookSummary[] | null {
  const [list, setList] = useState<PlaybookSummary[] | null>(null);
  useEffect(() => {
    get<PlaybookSummary[]>('/playbooks')
      .then(setList)
      .catch(() => setList([]));
  }, []);
  return list;
}

type CredentialRow = SettingsSnapshot['credentials'][number];

export function Settings() {
  const { projectId, run, openOverlay, closeOverlay } = useApp();
  const s = useProjectResource<SettingsSnapshot>('/settings').data;
  const mc = useMission().data;
  const tz = useTz();
  const now = useNow(60_000);
  const playbooks = usePlaybooks();
  const [editing, setEditing] = useState<string | null>(null);
  if (!s || !mc) return <p className="quiet-line">Loading settings…</p>;
  const base = `/projects/${projectId}`;
  const p = mc.project;
  const paused = p.status === 'paused';
  const hours = p.startedAt ? (now - Date.parse(p.startedAt)) / 3_600_000 : 0;
  const running = mc.phases.reduce((n, x) => n + x.tasksRunning, 0);

  // Every credential the playbook takes, given at intake or not, so a missing one can be added.
  const declared =
    playbooks?.find((x) => x.id === p.playbook?.id)?.intake.steps.flatMap((st) => st.credentials) ??
    [];
  const rows: CredentialRow[] = [
    ...s.credentials,
    ...declared
      .filter((d) => !s.credentials.some((c) => c.credentialId === d.credentialId))
      .map((d) => ({
        credentialId: d.credentialId,
        system: d.system,
        scope: d.description ?? '',
        provided: false,
        hint: null,
        verifiedAt: null,
        ok: null,
        detail: null,
        expiresAt: null,
      })),
  ];

  const control = (verb: 'pause' | 'resume') =>
    run(() => post(`${base}/control`, { verb, scope: { kind: 'project', id: projectId } }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>
            Policies and budgets for this project. Secrets never appear here. Conventions are locked
            after Gate 1.
          </p>
        </div>
      </div>
      <div className="settings">
        {!p.demo && <SourceSitePanel current={p.sourceUrl} />}
        {!p.demo && p.playbook && (
          <PlaybookPanel id={p.playbook.id} version={p.playbook.version} list={playbooks} />
        )}
        {!p.demo && p.playbook && (
          <BriefPanel
            current={p.brief}
            questions={playbooks?.find((x) => x.id === p.playbook?.id)?.intake.brief ?? []}
          />
        )}
        {!p.demo && p.intake?.repo && <BuildRepoPanel repo={p.buildRepo} source={p.intake.repo} />}
        {!p.demo && p.intake && p.playbook && (
          <IntakePanel
            values={p.intake.target}
            spec={playbooks?.find((x) => x.id === p.playbook?.id)?.intake ?? null}
            open={p.status === 'intake'}
          />
        )}
        <section className="panel">
          <h2>
            Credentials <small>references only</small>
          </h2>
          <table>
            <thead>
              <tr>
                <th>System</th>
                <th>Scope</th>
                <th>Verified</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const spec = p.demo
                  ? undefined
                  : declared.find((d) => d.credentialId === c.credentialId);
                // Repository access can be re-checked before it's provided: that's how a fresh
                // installation of the GitHub App is picked up.
                const recheck = c.provided || (c.credentialId === 'github' && !p.demo);
                const days = c.expiresAt
                  ? Math.max(0, Math.round((Date.parse(c.expiresAt) - now) / 86_400_000))
                  : null;
                return (
                  <Fragment key={c.credentialId}>
                    <tr>
                      <td>
                        <b>{c.system}</b>
                      </td>
                      <td className="mono">
                        {c.scope}
                        {c.hint && <div className="faint">ends in {c.hint}</div>}
                      </td>
                      <td>
                        {!c.provided ? (
                          <span className="cred-miss">
                            {c.ok === false && c.detail ? c.detail : 'Not provided'}
                          </span>
                        ) : c.ok === false ? (
                          <span className="cred-miss">Failed: {c.detail}</span>
                        ) : c.verifiedAt ? (
                          <span className="cred-ok">{stamp(c.verifiedAt, tz)}</span>
                        ) : (
                          <span className="muted">Not yet verified</span>
                        )}
                        {days !== null && (
                          <div className="faint" style={{ fontSize: 12 }}>
                            expires in {days} days
                          </div>
                        )}
                      </td>
                      <td>
                        <div className="btn-row">
                          {(recheck || !spec) && (
                            <button
                              className="btn sm"
                              disabled={!recheck}
                              onClick={() =>
                                void run(
                                  () => post(`${base}/credentials/${c.credentialId}/verify`),
                                  `Re-verifying ${c.system}`,
                                )
                              }
                            >
                              {c.provided ? 'Re-verify' : 'Check again'}
                            </button>
                          )}
                          {spec && (
                            <button
                              className="btn sm"
                              aria-expanded={editing === c.credentialId}
                              onClick={() =>
                                setEditing(editing === c.credentialId ? null : c.credentialId)
                              }
                            >
                              {c.provided ? 'Replace' : 'Add'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {spec && editing === c.credentialId && (
                      <tr>
                        <td colSpan={4}>
                          <CredentialForm
                            spec={spec}
                            onSave={async (secret) => {
                              const ok = await run(
                                () => put(`${base}/credentials/${c.credentialId}`, { secret }),
                                `${c.system} checked and saved.`,
                              );
                              if (ok) setEditing(null);
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </section>

        <GithubAppPanel />

        <section className="panel">
          <h2>Budgets</h2>
          <div className="budget">
            <span>Cost</span>
            <span>
              {usd(s.spent.usd)} of {usd(s.budgets.usd)} ({pct(s.spent.usd / s.budgets.usd)}%)
            </span>
            <span className="bar">
              <i style={{ width: `${Math.min(100, pct(s.spent.usd / s.budgets.usd))}%` }} />
            </span>
            <span>Tokens</span>
            <span>
              {(s.spent.tokens / 1e6).toFixed(1)}M of {(s.budgets.tokens / 1e6).toFixed(0)}M (
              {pct(s.spent.tokens / s.budgets.tokens)}%)
            </span>
            <span className="bar">
              <i style={{ width: `${Math.min(100, pct(s.spent.tokens / s.budgets.tokens))}%` }} />
            </span>
            <span>Time</span>
            <span>
              {Math.floor(hours)} h of {s.budgets.hours} h ({pct(hours / s.budgets.hours)}%)
            </span>
            <span className="bar">
              <i style={{ width: `${Math.min(100, pct(hours / s.budgets.hours))}%` }} />
            </span>
          </div>
          <p className="quiet-line" style={{ margin: 0 }}>
            Soft warning at 80%: new tasks keep dispatching, you are told. Hard stop at 100%: no new
            tasks until you acknowledge.
          </p>
        </section>

        <section className="panel">
          <h2>Gates</h2>
          {s.gates.map((g) => (
            <div className="row" key={g.key}>
              <span className="l">
                {g.label}
                {g.kind === 'optional' && <span className="muted"> (optional)</span>}
              </span>
              {g.kind === 'director' ? (
                g.state === 'approved' ? (
                  <Chip state="done" label={`Approved ${g.at ? stamp(g.at, tz) : ''}`} />
                ) : g.state === 'waiting' ? (
                  <Chip state="waiting" label="Waiting on you" />
                ) : (
                  <Chip state="idle" label={`Phase ${g.phase}`} />
                )
              ) : (
                <button
                  className="toggle"
                  role="switch"
                  aria-checked={!!g.enabled}
                  aria-label={g.label}
                  onClick={() =>
                    void run(() => put(`${base}/settings/${g.key}`, { value: !g.enabled }))
                  }
                />
              )}
            </div>
          ))}
        </section>

        <section className="panel">
          <h2>Escalation policy</h2>
          <table>
            <thead>
              <tr>
                <th>Type</th>
                <th>Default action after</th>
                <th>Notifies</th>
              </tr>
            </thead>
            <tbody>
              {s.escalationPolicy.map((r) => (
                <tr key={r.type}>
                  <td>
                    <span className={`type ${r.type}`}>
                      {r.type === 'gate' ? 'Gate' : TYPE_LABEL[r.type]}
                    </span>
                  </td>
                  <td>{after(r.defaultAfterMinutes, r.behaviour)}</td>
                  <td>{r.notifies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <h2>
            Conventions <small>locked after Gate 1</small>
          </h2>
          {s.conventions.entries.length ? (
            <div className="kv">
              {s.conventions.entries.map((c) => (
                <span key={c.key} style={{ display: 'contents' }}>
                  <span>{c.key}</span>
                  <span className="v">{c.value}</span>
                </span>
              ))}
            </div>
          ) : (
            <p className="quiet-line">Recorded with the Blueprint in phase 2.</p>
          )}
          <span className="lock">
            {s.conventions.lockedAt
              ? `Locked by Gate 1 on ${stamp(s.conventions.lockedAt, tz)}. Changes arrive as Director directives and are logged.`
              : 'Open until Gate 1. After approval, changes arrive as Director directives and are logged.'}
          </span>
        </section>

        <section className="panel danger">
          <h2>Danger zone</h2>
          <div className="row">
            <span className="l">Pause the whole project</span>
            <button
              className={`btn sm ${paused ? 'primary' : ''}`}
              onClick={() =>
                paused
                  ? void control('resume')
                  : openOverlay(
                      <TypedConfirm
                        title="Pause the whole project?"
                        body={`${running} running task${running === 1 ? '' : 's'} hold at their next checkpoint. Nothing is rolled back. Resume at any time.`}
                        confirmLabel="Pause project"
                        onConfirm={() => {
                          closeOverlay();
                          void control('pause');
                        }}
                      />,
                    )
              }
            >
              {paused ? 'Resume project' : 'Pause project'}
            </button>
          </div>
          {s.rollback && (
            <div className="row">
              <span className="l">
                Roll back phase {s.rollback.phase}{' '}
                <span className="muted">({s.rollback.detail})</span>
              </span>
              <button
                className="btn sm danger"
                onClick={() =>
                  openOverlay(
                    <TypedConfirm
                      title={`Roll back phase ${s.rollback!.phase}?`}
                      body={`${s.rollback!.detail} This cannot be undone.`}
                      confirmLabel={`Roll back phase ${s.rollback!.phase}`}
                      typed="ROLL BACK"
                      onConfirm={() => {
                        closeOverlay();
                        void run(() =>
                          post(`${base}/phases/${s.rollback!.phase}/rollback`, {
                            confirmation: 'ROLL BACK',
                          }),
                        );
                      }}
                    />,
                  )
                }
              >
                Roll back phase
              </button>
            </div>
          )}
          {!p.demo && (
            <div className="row">
              <span className="l">
                Reset to intake{' '}
                <span className="muted">
                  (stop the run, delete its history and documents, move to the catalog’s playbook
                  version)
                </span>
              </span>
              <span className="btn-row">
                {[false, ...(p.buildRepo ? [true] : [])].map((newBuildRepo) => (
                  <button
                    key={String(newBuildRepo)}
                    className="btn sm danger"
                    onClick={() =>
                      openOverlay(
                        <TypedConfirm
                          title={
                            newBuildRepo
                              ? 'Reset this project and start in a new build repository?'
                              : 'Reset this project to intake?'
                          }
                          body={`The run stops now. Its activity, decisions, plan and Workbench documents are deleted. The intake facts, credentials, brief and source site are kept, and Start runs the project again from the beginning on the catalog’s playbook version.${
                            newBuildRepo
                              ? ` The project also lets go of ${p.buildRepo!.repo} and its hosting record; the repository itself is left as it is. Create a new build repository in Settings before Start.`
                              : ''
                          } This cannot be undone.`}
                          confirmLabel="Reset project"
                          typed={p.name}
                          onConfirm={() => {
                            closeOverlay();
                            void run(
                              () => post(`${base}/reset`, { confirmation: p.name, newBuildRepo }),
                              `${p.name} reset to intake`,
                            );
                          }}
                        />,
                      )
                    }
                  >
                    {newBuildRepo ? 'Reset with a new build repository' : 'Reset'}
                  </button>
                ))}
              </span>
            </div>
          )}
          <div className="row">
            <span className="l">Archive project</span>
            <button
              className="btn sm danger"
              onClick={() =>
                openOverlay(
                  <TypedConfirm
                    title="Archive this project?"
                    body="The project becomes read-only with its audit trail, artifacts and handover pack. This cannot be undone."
                    confirmLabel="Archive project"
                    typed={p.name}
                    onConfirm={() => {
                      closeOverlay();
                      void run(
                        () => post(`${base}/archive`, { confirmation: p.name }),
                        `${p.name} archived`,
                      );
                    }}
                  />,
                )
              }
            >
              Archive
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

/**
 * The playbook the project runs, pinned at creation: what the team owes the client. Agents work
 * with these outcomes in view, and acceptance is judged against them.
 */
function PlaybookPanel({
  id,
  version,
  list,
}: {
  id: string;
  version: string;
  list: PlaybookSummary[] | null;
}) {
  const pb = list?.find((p) => p.id === id);
  return (
    <section className="panel playbook">
      <h2>
        Playbook <small>v{version}</small>
      </h2>
      {!list ? (
        <p className="muted">Loading…</p>
      ) : !pb ? (
        <p className="muted">{id} (no longer in the catalog)</p>
      ) : (
        <>
          <p>
            <b>{pb.name}</b> <span className="muted">on {pb.platform.name}</span>
          </p>
          <p className="muted">{pb.charter.mission}</p>
          <ul className="outcomes">
            {pb.charter.outcomes.map((o) => (
              <li key={o.id}>
                <b>{o.title}</b>
                <span className="muted"> · {o.measure}</span>
              </li>
            ))}
          </ul>
          {pb.version !== version && (
            <p className="cred-miss">
              The catalog has v{pb.version}. This project keeps v{version} until it is reset.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The client's brief: what the team works to beyond access. Answered at intake, or here for a
 * project created before its playbook asked; agents read it from their next task.
 */
function BriefPanel({
  current,
  questions,
}: {
  current: ProjectSummary['brief'];
  questions: PlaybookSummary['intake']['brief'];
}) {
  const { projectId, run } = useApp();
  const [editing, setEditing] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (!questions.length && !current.length) return null;
  const open = () => {
    setAnswers(Object.fromEntries(current.map((b) => [b.key, b.answer])));
    setEditing(true);
  };
  const ready = questions.every((q) => !q.required || answers[q.key]?.trim());
  return (
    <section className="panel brief">
      <h2>Brief</h2>
      <p className="muted">
        What the client wants beyond access. Every agent works with it, and acceptance is measured
        against it.
      </p>
      {!editing ? (
        <>
          {current.length ? (
            <dl className="contract">
              {current.map((b) => (
                <Fragment key={b.key}>
                  <dt>{b.label}</dt>
                  <dd>{b.answer}</dd>
                </Fragment>
              ))}
            </dl>
          ) : (
            <p className="cred-miss">Not answered yet.</p>
          )}
          {questions.length > 0 && (
            <button className="btn sm" onClick={open}>
              {current.length ? 'Edit the brief' : 'Answer the brief'}
            </button>
          )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            void run(() => put(`/projects/${projectId}/brief`, { answers }), 'Brief saved.').then(
              (ok) => ok && setEditing(false),
            );
          }}
        >
          {questions.map((q) => (
            <label key={q.key} className="cred-field" style={{ marginBottom: 10 }}>
              <span className="eyebrow">
                {q.label}
                {q.required ? '' : ' (optional)'}
              </span>
              {q.kind === 'text' ? (
                <textarea
                  className="input"
                  rows={2}
                  placeholder={q.placeholder ?? ''}
                  value={answers[q.key] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                />
              ) : (
                <select
                  className="select"
                  value={answers[q.key] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                >
                  <option value="">Choose…</option>
                  {(q.kind === 'yesno' ? ['yes', 'no'] : q.options).map((o) => (
                    <option key={o} value={o}>
                      {q.kind === 'yesno' ? (o === 'yes' ? 'Yes' : 'No') : o}
                    </option>
                  ))}
                </select>
              )}
              {q.hint && <span className="wiz-hint">{q.hint}</span>}
            </label>
          ))}
          <div className="btn-row">
            <button className="btn sm primary" type="submit" disabled={!ready}>
              Save the brief
            </button>
            <button className="btn sm" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * A credential's fields, sent once to be checked against its service and sealed. Nothing typed
 * here is kept in the page after saving, and nothing stored is ever shown.
 */
function CredentialForm({
  spec,
  onSave,
}: {
  spec: IntakeCredentialSpec;
  onSave: (secret: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const ready = spec.fields.every((f) => values[f.key]?.trim());
  return (
    <form
      className="cred-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        void onSave(values).finally(() => setBusy(false));
      }}
    >
      {spec.description && <p className="muted">{spec.description}</p>}
      <div className="row">
        {spec.fields.map((f) => (
          <label key={f.key} className="cred-field">
            <span className="eyebrow">{f.label}</span>
            <input
              className="input"
              type={f.secret ? 'password' : 'text'}
              autoComplete={f.secret ? 'new-password' : 'off'}
              spellCheck={false}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </label>
        ))}
        <button className="btn sm primary" type="submit" disabled={!ready || busy}>
          {busy ? 'Checking…' : 'Check and save'}
        </button>
      </div>
    </form>
  );
}

/**
 * Where the new site is built: a private repository in our GitHub organization, created from
 * Sitecore's starter, that moves to the client at handover. Created when the project starts; a
 * project started earlier, or one whose creation failed, creates it here.
 */
function BuildRepoPanel({ repo, source }: { repo: ProjectSummary['buildRepo']; source: string }) {
  const { projectId, run } = useApp();
  const suggested = `${source.split('/')[1] ?? 'site'}-sitecoreai`;
  const [name, setName] = useState('');
  const valid = !name.trim() || /^[A-Za-z0-9._-]{1,100}$/.test(name.trim());
  return (
    <section className="panel build-repo">
      <h2>Build repository</h2>
      <p className="muted">
        The new site is built here, in our GitHub organization, from Sitecore’s starter. Agents read{' '}
        {source} but commit only to this repository, on launchworks/* branches. It moves to the
        client at handover.
      </p>
      {repo ? (
        <p>
          <a href={repo.url} target="_blank" rel="noopener noreferrer">
            {repo.repo}
          </a>{' '}
          <span className="muted">
            · from {repo.template} · app in <span className="mono">{repo.appPath}</span>
          </span>
        </p>
      ) : (
        <>
          <p className="cred-miss">Not created yet: building can’t start until it is.</p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid)
                void run(
                  () =>
                    post(
                      `/projects/${projectId}/build-repo`,
                      name.trim() ? { name: name.trim() } : {},
                    ),
                  'Build repository created.',
                );
            }}
          >
            <label className="sr-only" htmlFor="build-repo-name">
              Repository name
            </label>
            <input
              id="build-repo-name"
              className="input l"
              placeholder={suggested}
              aria-invalid={valid ? undefined : true}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button className="btn sm primary" type="submit" disabled={!valid}>
              Create build repository
            </button>
          </form>
          <p className="muted">
            Leave the name empty for {suggested}. A repository that already has an earlier run’s
            work in it is never reused: give a new name instead.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * What intake recorded about the target. Before Start, a value no credential check depends on
 * can change here (a hosting project name that turned out to be taken).
 */
function IntakePanel({
  values,
  spec,
  open,
}: {
  values: Record<string, string | string[]>;
  spec: PlaybookSummary['intake'] | null;
  open: boolean;
}) {
  const { projectId, run } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  if (!spec) return null;
  const checked = new Set(spec.steps.flatMap((st) => st.credentials.flatMap((c) => c.uses)));
  const shown = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(', ') : (v ?? ''));
  return (
    <section className="panel intake-values">
      <h2>Intake</h2>
      <p className="muted">
        {open
          ? 'Values a credential was checked against are fixed; the others can change until Start.'
          : 'Fixed once the project started. Reset the project to change them.'}
      </p>
      <table>
        <tbody>
          {spec.steps
            .flatMap((st) => st.fields)
            .map((f) => (
              <tr key={f.key}>
                <th scope="row">{f.label}</th>
                <td>
                  {editing === f.key ? (
                    <form
                      className="row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(
                          () => put(`/projects/${projectId}/target/${f.key}`, { value: draft }),
                          `${f.label} saved.`,
                        ).then((ok) => ok && setEditing(null));
                      }}
                    >
                      <label className="sr-only" htmlFor={`intake-${f.key}`}>
                        {f.label}
                      </label>
                      <input
                        id={`intake-${f.key}`}
                        className="input l"
                        placeholder={f.placeholder ?? undefined}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                      <button
                        className="btn sm primary"
                        type="submit"
                        disabled={!draft.trim() || draft.trim() === shown(values[f.key])}
                      >
                        Save
                      </button>
                      <button className="btn sm" type="button" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <span className="mono">{shown(values[f.key]) || '—'}</span>
                  )}
                  {f.hint && editing === f.key && <p className="muted">{f.hint}</p>}
                </td>
                <td>
                  {open && !checked.has(f.key) && editing !== f.key && (
                    <button
                      className="btn sm"
                      onClick={() => {
                        setDraft(shown(values[f.key]));
                        setEditing(f.key);
                      }}
                    >
                      Change
                    </button>
                  )}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </section>
  );
}

/** The live site being migrated: agents crawl it, and the crawl may only reach its host. */
function SourceSitePanel({ current }: { current: string | null }) {
  const { projectId, run } = useApp();
  const [url, setUrl] = useState(current ?? '');
  useEffect(() => setUrl(current ?? ''), [current]);
  const valid = /^https?:\/\/[^\s/]+\.[^\s]+$/.test(url.trim());
  const changed = url.trim() !== (current ?? '');
  return (
    <section className="panel source-site">
      <h2>Source site</h2>
      <p className="muted">
        The live site being migrated. Agents crawl it for the page inventory, parity checks and
        screenshots, and the crawler may only reach this host.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && changed)
            void run(
              () => put(`/projects/${projectId}/source`, { url: url.trim() }),
              'Source site saved. Agents use it from their next attempt.',
            );
        }}
      >
        <label className="sr-only" htmlFor="source-site-url">
          Source site URL
        </label>
        <input
          id="source-site-url"
          className="input l"
          type="url"
          inputMode="url"
          placeholder="https://www.example.com"
          aria-invalid={url.trim() && !valid ? true : undefined}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn sm primary" type="submit" disabled={!valid || !changed}>
          Save
        </button>
      </form>
      {!current && <p className="cred-miss">Not set: the crawl can’t start until it is.</p>}
    </section>
  );
}
