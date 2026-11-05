/*
 * Saved connections: one tenant's shared facts and sealed secrets, reused by every site on it.
 * Secrets are never shown: a hint, when each was last checked, and a way to replace one. The same
 * calls as the old page (Connections in surfaces/Dashboard.tsx), on Cypher's parts; after a save
 * the list is fetched again rather than re-keyed with a cache-busting query.
 */
import type {
  ConnectionView,
  IntakeCredentialSpec,
  PortfolioItem,
  RemixDraft,
} from '@lw/contracts';
import { Fragment, useState } from 'react';
import { get, messageOf, post, put } from '../../lib/api';
import { ago } from '../../lib/fmt';
import { useApp, useNow } from '../../state';
import { Facts, Field, Select, Status, TextInput } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Action, Actions, BesideField, CredentialFields, Notice } from '../intake/shared';
import { usePlaybooks } from '../intake/shared';
import { catalogNames, Lead, Pending, useResource } from './shared';
import s from './manage.module.css';

type Credential = ConnectionView['credentials'][number];

export function Connections({ projects }: { projects: PortfolioItem[] }) {
  const { newProject, toast } = useApp();
  const { data, error, reload } = useResource<ConnectionView[]>(
    '/connections',
    30_000,
    'Connections could not be loaded.',
  );
  const { playbooks } = usePlaybooks();
  const specOf = (credentialId: string): IntakeCredentialSpec | undefined =>
    playbooks
      ?.flatMap((pb) => pb.intake.steps.flatMap((st) => st.credentials))
      .find((c) => c.credentialId === credentialId);
  // A target fact's label and the platform's name, as the playbooks' intake declares them.
  const labelOf = (key: string) =>
    playbooks
      ?.flatMap((pb) => pb.intake.steps.flatMap((st) => st.fields))
      .find((f) => f.key === key)?.label ?? key;
  const names = catalogNames(playbooks);
  if (!data) return <Pending error={error} loading="Loading connections…" />;

  const savedFrom = new Set(data.map((c) => c.createdFrom?.projectId));
  const candidates = projects.filter((p) => !p.demo && p.playbook && !savedFrom.has(p.id));
  const startOn = async (c: ConnectionView) => {
    try {
      const draft = await get<RemixDraft>(`/projects/${c.createdFrom!.projectId}/remix`);
      newProject({ remix: { draft, connectionName: c.name } });
    } catch (err) {
      toast(messageOf(err, 'Could not start a project.'));
    }
  };

  return (
    <div className={s.page}>
      <Lead>
        A connection holds what every site on one tenant shares: the environment, its clients and
        Context IDs. New projects on it don’t ask for those again, and replacing a secret here
        updates every project that uses it.
      </Lead>
      {error && <Notice tone="bad">{error}</Notice>}
      {data.length === 0 && (
        <p className={`${s.quiet} type-body-small`}>
          No connections yet. Save a project’s tenant below once it has one.
        </p>
      )}
      {data.map((c) => (
        <Panel
          key={c.id}
          title={c.name}
          meta={
            <span className={s.headRight}>
              {names.platform(c.platform)}
              {c.createdFrom && (
                <Action kind="primary" onClick={() => void startOn(c)}>
                  New project on it
                </Action>
              )}
            </span>
          }
        >
          <div className={s.connBody}>
            {Object.keys(c.target).length > 0 && (
              <Facts
                rows={Object.entries(c.target).map(([k, v]) => [
                  labelOf(k),
                  <span key={k} className={s.value}>
                    {Array.isArray(v) ? v.join(', ') : v}
                  </span>,
                ])}
              />
            )}
          </div>
          <div className={s.tableWrap}>
            <table className={`${s.table} ${s.stackOnPhone} type-table`}>
              <caption className="sr-only">Credentials of {c.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Credential</th>
                  <th scope="col">Stored</th>
                  <th scope="col">Last check</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.credentials.map((x) => (
                  <CredentialRow
                    key={x.credentialId}
                    connectionId={c.id}
                    credential={x}
                    spec={specOf(x.credentialId)}
                    onDone={() => {
                      void reload();
                      toast(`${x.system} replaced for every project on ${c.name}.`);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <p className={`${s.panelFoot} type-meta`}>
            {c.createdFrom ? `Saved from ${c.createdFrom.name}. ` : ''}
            {c.projects.length
              ? `Used by ${c.projects.map((p) => p.name).join(', ')}.`
              : 'No project uses it yet.'}
          </p>
        </Panel>
      ))}
      <SaveConnection candidates={candidates} onSaved={() => void reload()} />
    </div>
  );
}

function CredentialRow({
  connectionId,
  credential: x,
  spec,
  onDone,
}: {
  connectionId: string;
  credential: Credential;
  spec: IntakeCredentialSpec | undefined;
  onDone: () => void;
}) {
  // Keeps the relative times ("12 min ago") current.
  useNow(15_000);
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const formId = `conn-${connectionId}-${x.credentialId}`;
  const ready = !!spec && spec.fields.every((f) => (values[f.key] ?? '').trim());
  const close = () => {
    setOpen(false);
    setValues({});
    setProblem(null);
  };
  return (
    <Fragment>
      <tr data-open={open || undefined}>
        <th scope="row" className={s.strong}>
          {x.system}
        </th>
        <td className={s.muted}>{x.hint ? `Ends in ${x.hint}` : 'Stored'}</td>
        <td>
          <span className={s.stateCell}>
            <Status tone={x.ok === true ? 'ok' : x.ok === false ? 'bad' : 'idle'}>
              {x.ok === true ? 'Passed' : x.ok === false ? 'Failed' : 'Not checked'}
              {x.checkedAt ? ` ${ago(x.checkedAt)}` : ''}
            </Status>
            {x.detail && <span className={`${s.under} type-meta`}>{x.detail}</span>}
          </span>
        </td>
        <td className={s.actionsCell}>
          {spec && (
            <Action
              expanded={open}
              controls={open ? formId : undefined}
              label={`${open ? 'Cancel replacing' : 'Replace'} ${x.system}`}
              onClick={() => (open ? close() : setOpen(true))}
            >
              {open ? 'Cancel' : 'Replace'}
            </Action>
          )}
        </td>
      </tr>
      {open && spec && (
        <tr className={s.formRow}>
          <td colSpan={4}>
            <form
              id={formId}
              className={s.well}
              aria-label={`Replace ${x.system}`}
              onSubmit={async (e) => {
                e.preventDefault();
                if (!ready || busy) return;
                setBusy(true);
                setProblem(null);
                try {
                  await put(`/connections/${connectionId}/credentials/${x.credentialId}`, {
                    secret: values,
                  });
                  close();
                  onDone();
                } catch (err) {
                  setProblem(messageOf(err, 'It could not be replaced.'));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {spec.description && <p className={`${s.lead} type-meta`}>{spec.description}</p>}
              <CredentialFields
                spec={spec}
                values={values}
                onChange={(k, v) => setValues((cur) => ({ ...cur, [k]: v }))}
              />
              {problem && (
                <Notice tone="bad" live>
                  {problem}
                </Notice>
              )}
              <Actions>
                <Action kind="primary" type="submit" disabled={busy || !ready}>
                  {busy ? 'Checking…' : 'Check and replace'}
                </Action>
                <Action onClick={close}>Cancel</Action>
              </Actions>
            </form>
          </td>
        </tr>
      )}
    </Fragment>
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
    <Panel title="Save a project’s tenant as a connection" padded>
      <form
        className={s.inline}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !from || !name.trim()) return;
          setBusy(true);
          try {
            await post('/connections', { name: name.trim(), fromProject: from });
            toast(`${name.trim()} saved. New projects on that tenant can use it.`);
            setName('');
            setFrom('');
            onSaved();
          } catch (err) {
            toast(messageOf(err, 'The connection could not be saved.'));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Project">
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            >
              <option value="">Choose a project…</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.client})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Name">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              placeholder="Brands tenant (production)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <BesideField>
          <Action kind="primary" type="submit" disabled={busy || !from || !name.trim()}>
            {busy ? 'Saving…' : 'Save connection'}
          </Action>
        </BesideField>
      </form>
    </Panel>
  );
}
