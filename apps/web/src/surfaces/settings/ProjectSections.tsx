/*
 * The project itself: the live site it migrates, the playbook it runs, the client's brief, the
 * repository the new site is built in, its host, and what intake recorded about the target.
 * Live projects only; a demo shows none of these.
 */
import type { PlaybookSummary, ProjectSummary } from '@lw/contracts';
import { useEffect, useState } from 'react';
import { get, postFor, post, put } from '../../lib/api';
import { useApp } from '../../state';
import { Facts, Field, TextInput } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Action, Actions, answerWord, BesideField, BriefFields, Notice } from '../intake/shared';
import { isRepoName, isSiteUrl } from '../intake/validate';
import {
  checkedFields,
  editingHostOf,
  FINISHED,
  hostingStepLine,
  shownValue,
  suggestedRepoName,
  type HostingDeployment,
  type HostingStep,
} from './model';
import s from './settings.module.css';

/** The live site being migrated: agents crawl it, and the crawl may only reach its host. */
export function SourceSitePanel({ current }: { current: string | null }) {
  const { projectId, run } = useApp();
  const [url, setUrl] = useState(current ?? '');
  useEffect(() => setUrl(current ?? ''), [current]);
  const valid = isSiteUrl(url);
  const changed = url.trim() !== (current ?? '');
  return (
    <Panel title="Source site" padded>
      <div className={s.stack}>
        <p className={s.lead}>
          The live site being migrated. Agents crawl it for the page inventory, parity checks and
          screenshots, and the crawler may only reach this host.
        </p>
        <form
          className={s.inline}
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && changed)
              void run(
                () => put(`/projects/${projectId}/source`, { url: url.trim() }),
                'Source site saved. Agents use it from their next attempt.',
              );
          }}
        >
          <Field
            label="Address"
            error={
              url.trim() && !valid
                ? 'A full address with its host, like https://www.example.com.'
                : null
            }
          >
            {({ id, describedBy, invalid }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                type="url"
                inputMode="url"
                placeholder="https://www.example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </Field>
          <BesideField>
            <Action kind="primary" type="submit" disabled={!valid || !changed}>
              Save
            </Action>
          </BesideField>
        </form>
        {!current && <Notice tone="bad">Not set: the crawl can’t start until it is.</Notice>}
      </div>
    </Panel>
  );
}

/**
 * The playbook the project runs, pinned at creation: what the team owes the client. Agents work
 * with these outcomes in view, and acceptance is judged against them.
 */
export function PlaybookPanel({
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
    <Panel title="Playbook" meta={`v${version}`} padded>
      {!list ? (
        <p className={s.quiet}>Loading…</p>
      ) : !pb ? (
        <p className={s.quiet}>{id} (no longer in the catalog)</p>
      ) : (
        <div className={s.stack}>
          <p className={s.body}>
            <b>{pb.name}</b> <span className={s.quietInline}>on {pb.platform.name}</span>
          </p>
          <p className={s.lead}>{pb.charter.mission}</p>
          <ul className={s.outcomes}>
            {pb.charter.outcomes.map((o) => (
              <li key={o.id}>
                <b>{o.title}</b>
                <span className={`${s.quietInline} type-meta`}>{o.measure}</span>
              </li>
            ))}
          </ul>
          {pb.version !== version && (
            <Notice tone="waiting">
              The catalog has v{pb.version}. This project keeps v{version} until it is reset.
            </Notice>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * The client's brief: what the team works to beyond access. Answered at intake, or here for a
 * project created before its playbook asked; agents read it from their next task.
 */
export function BriefPanel({
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
    <Panel title="Brief" padded>
      <div className={s.stack}>
        <p className={s.lead}>
          What the client wants beyond access. Every agent works with it, and acceptance is measured
          against it.
        </p>
        {!editing ? (
          <>
            {current.length ? (
              <Facts rows={current.map((b) => [b.label, answerWord(b.answer)])} />
            ) : (
              <Notice tone="bad">Not answered yet.</Notice>
            )}
            {questions.length > 0 && (
              <Actions>
                <Action onClick={open}>
                  {current.length ? 'Edit the brief' : 'Answer the brief'}
                </Action>
              </Actions>
            )}
          </>
        ) : (
          <form
            className={s.stack}
            onSubmit={(e) => {
              e.preventDefault();
              if (!ready) return;
              void run(() => put(`/projects/${projectId}/brief`, { answers }), 'Brief saved.').then(
                (ok) => ok && setEditing(false),
              );
            }}
          >
            <BriefFields
              questions={questions}
              answers={answers}
              onChange={(k, v) => setAnswers((a) => ({ ...a, [k]: v }))}
            />
            <Actions>
              <Action kind="primary" type="submit" disabled={!ready}>
                Save the brief
              </Action>
              <Action onClick={() => setEditing(false)}>Cancel</Action>
            </Actions>
          </form>
        )}
      </div>
    </Panel>
  );
}

/**
 * Where the new site is built: a private repository in our GitHub organization, created from
 * the platform's starter, that moves to the client at handover. Created when the project starts; a
 * project started earlier, or one whose creation failed, creates it here.
 */
export function BuildRepoPanel({
  repo,
  source,
  projectName,
  platformId,
}: {
  repo: ProjectSummary['buildRepo'];
  source: string;
  projectName: string;
  platformId: string;
}) {
  const { projectId, run } = useApp();
  const suggested = suggestedRepoName(source, projectName, platformId);
  const [name, setName] = useState('');
  const valid = !name.trim() || isRepoName(name);
  return (
    <Panel title="Build repository" padded>
      <div className={s.stack}>
        <p className={s.lead}>
          The new site is built here, in our GitHub organization, from Sitecore’s starter. Agents
          read {source} but commit only to this repository, on launchworks/* branches. It moves to
          the client at handover.
        </p>
        {repo ? (
          <Facts
            rows={[
              [
                'Repository',
                <a
                  key="r"
                  className={s.link}
                  href={repo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {repo.repo}
                </a>,
              ],
              ['Created from', repo.template],
              ['App in', repo.appPath],
            ]}
          />
        ) : (
          <>
            <Notice tone="bad">Not created yet: building can’t start until it is.</Notice>
            <form
              className={s.inline}
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
              <Field
                label="Repository name"
                optional
                hint={`Leave it empty for ${suggested}. A repository that already has an earlier run’s work in it is never reused: give a new name instead.`}
                error={valid ? null : 'Letters, digits, dots, dashes and underscores only.'}
              >
                {({ id, describedBy, invalid }) => (
                  <TextInput
                    id={id}
                    aria-describedby={describedBy}
                    invalid={invalid}
                    placeholder={suggested}
                    spellCheck={false}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
              </Field>
              <BesideField>
                <Action kind="primary" type="submit" disabled={!valid}>
                  Create build repository
                </Action>
              </BesideField>
            </form>
          </>
        )}
      </div>
    </Panel>
  );
}

/**
 * Follows the setup's deployments to the end: reading a ready integration build makes it the
 * editing host. Every five seconds after the first two, giving up after about seven minutes.
 */
function useDeployments(projectId: string | null, steps: HostingStep[] | null) {
  const [deploys, setDeploys] = useState<Record<string, HostingDeployment>>({});
  useEffect(() => {
    const ids = (steps ?? []).flatMap((x) => (x.deploymentId ? [x.deploymentId] : []));
    if (!ids.length || !projectId) return;
    let stopped = false;
    let tries = 0;
    let timer = 0;
    const tick = async () => {
      const read = await Promise.all(
        ids.map((id) =>
          get<HostingDeployment>(`/projects/${projectId}/hosting/deployments/${id}`).catch(
            () => null,
          ),
        ),
      );
      if (stopped) return;
      setDeploys((d) => ({
        ...d,
        ...Object.fromEntries(read.flatMap((r) => (r ? [[r.deploymentId, r]] : []))),
      }));
      if (++tries < 80 && read.some((r) => !r || !FINISHED.has(r.state)))
        timer = window.setTimeout(() => void tick(), 5000);
    };
    timer = window.setTimeout(() => void tick(), 2000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [steps, projectId]);
  return [deploys, () => setDeploys({})] as const;
}

/**
 * The head on our Vercel team, set up the way a playbook's deployment steps do it: the Vercel
 * project (protection off), its environment from the vault, the integration branch as the editing
 * host, the default branch to production and, on SitecoreAI, the site's rendering host. For a head
 * built outside a playbook run, or to rebuild the host; no secret passes through the Director.
 */
export function HostingPanel({
  hosting,
  name,
}: {
  hosting: ProjectSummary['hosting'];
  name: string;
}) {
  const { projectId, run } = useApp();
  const [steps, setSteps] = useState<HostingStep[] | null>(null);
  const [deploys, resetDeploys] = useDeployments(projectId, steps);
  const [busy, setBusy] = useState(false);
  const setUp = () => {
    setBusy(true);
    resetDeploys();
    void run(async () => {
      const r = await postFor<{ steps: HostingStep[] }>(`/projects/${projectId}/hosting/setup`, {});
      setSteps(r.steps);
    }).finally(() => setBusy(false));
  };
  const editing = editingHostOf(name);
  const rows: [string, React.ReactNode][] = [];
  if (hosting?.url)
    rows.push([
      'Production',
      <a key="p" className={s.link} href={hosting.url} target="_blank" rel="noopener noreferrer">
        {hosting.url.replace(/^https:\/\//, '')}
      </a>,
    ]);
  if (editing) rows.push(['Editing host', editing.replace(/^https:\/\//, '')]);
  return (
    <Panel title="Hosting" meta={name || undefined} padded>
      <div className={s.stack}>
        <p className={s.lead}>
          The new site on our Vercel team: production builds the build repository’s default branch,
          and Page builder renders through the editing host, the launchworks/integration build. Its
          environment comes from this project’s credentials.
        </p>
        {rows.length > 0 && <Facts rows={rows} />}
        {steps && (
          <ul className={s.steps} aria-label="Setup steps">
            {steps.map((x) => {
              const line = hostingStepLine(x, x.deploymentId ? deploys[x.deploymentId] : undefined);
              return (
                <li key={x.step}>
                  <Notice tone={line.tone}>
                    <b>{x.step}</b> <span className={s.quietInline}>{line.text}</span>
                  </Notice>
                </li>
              );
            })}
          </ul>
        )}
        <Actions>
          <Action kind="primary" disabled={busy} onClick={setUp}>
            {busy ? 'Setting up…' : hosting ? 'Set up hosting again' : 'Set up hosting'}
          </Action>
        </Actions>
      </div>
    </Panel>
  );
}

/**
 * What intake recorded about the target. Before Start, a value no credential check depends on
 * can change here (a hosting project name that turned out to be taken).
 */
export function IntakePanel({
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
  const checked = checkedFields(spec);
  const fields = spec.steps.flatMap((st) => st.fields);
  return (
    <Panel title="Intake">
      <p className={`${s.lead} ${s.sentence}`}>
        {open
          ? 'What intake recorded about the target. Values a credential was checked against are fixed; the others can change until Start.'
          : 'What intake recorded about the target. Fixed once the project started; reset the project to change them.'}
      </p>
      <div className={s.tableWrap}>
        <table className={`${s.table} ${s.stackOnPhone} type-table`}>
          <thead>
            <tr>
              <th scope="col">Value</th>
              <th scope="col">Recorded</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.key}>
                <th scope="row" className={s.rowHead}>
                  {f.label}
                </th>
                <td>
                  {editing === f.key ? (
                    <form
                      className={s.inline}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(
                          () => put(`/projects/${projectId}/target/${f.key}`, { value: draft }),
                          `${f.label} saved.`,
                        ).then((ok) => ok && setEditing(null));
                      }}
                    >
                      <span className={s.editField}>
                        <TextInput
                          aria-label={f.label}
                          aria-describedby={f.hint ? `intake-hint-${f.key}` : undefined}
                          placeholder={f.placeholder ?? undefined}
                          value={draft}
                          autoFocus
                          onChange={(e) => setDraft(e.target.value)}
                        />
                        {f.hint && (
                          <span id={`intake-hint-${f.key}`} className={`${s.quiet} type-meta`}>
                            {f.hint}
                          </span>
                        )}
                      </span>
                      <Actions>
                        <Action
                          kind="primary"
                          type="submit"
                          disabled={!draft.trim() || draft.trim() === shownValue(values[f.key])}
                        >
                          Save
                        </Action>
                        <Action onClick={() => setEditing(null)}>Cancel</Action>
                      </Actions>
                    </form>
                  ) : (
                    <span className={s.value}>{shownValue(values[f.key]) || '—'}</span>
                  )}
                </td>
                <td className={s.actionsCell}>
                  {open && !checked.has(f.key) && editing !== f.key && (
                    <Action
                      label={`Change ${f.label}`}
                      onClick={() => {
                        setDraft(shownValue(values[f.key]));
                        setEditing(f.key);
                      }}
                    >
                      Change
                    </Action>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
