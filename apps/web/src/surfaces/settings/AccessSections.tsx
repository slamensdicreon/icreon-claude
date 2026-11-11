/*
 * Access: the project's credentials (references only; nothing stored is ever shown) and the
 * GitHub App every project commits through.
 */
import type { IntakeCredentialSpec } from '@lw/contracts';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { get, messageOf, post, postFor, put } from '../../lib/api';
import { stamp } from '../../lib/fmt';
import { useApp, useTz } from '../../state';
import { Facts, Field, TextInput } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Action, Actions, BesideField, CredentialFields, Notice } from '../intake/shared';
import {
  credentialActions,
  credentialState,
  daysLeft,
  expiryTone,
  type CredentialRow,
} from './model';
import s from './settings.module.css';

/**
 * A credential's fields, sent once to be checked against its service and sealed. Nothing typed
 * here is kept in the page after saving, and nothing stored is ever shown.
 */
function CredentialForm({
  spec,
  id,
  onSave,
  onCancel,
}: {
  spec: IntakeCredentialSpec;
  id: string;
  onSave: (secret: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const ready = spec.fields.every((f) => values[f.key]?.trim());
  return (
    <form
      id={id}
      className={s.credentialForm}
      aria-label={spec.system}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        void onSave(values).finally(() => setBusy(false));
      }}
    >
      {spec.description && <p className={`${s.lead} type-meta`}>{spec.description}</p>}
      <CredentialFields
        spec={spec}
        values={values}
        onChange={(k, v) => setValues((x) => ({ ...x, [k]: v }))}
      />
      <Actions>
        <Action kind="primary" type="submit" disabled={!ready || busy}>
          {busy ? 'Checking…' : 'Check and save'}
        </Action>
        <Action onClick={onCancel}>Cancel</Action>
      </Actions>
    </form>
  );
}

export function CredentialsPanel({
  rows,
  declared,
  demo,
  now,
}: {
  rows: CredentialRow[];
  declared: IntakeCredentialSpec[];
  demo: boolean;
  now: number;
}) {
  const { projectId, run } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const base = `/projects/${projectId}`;
  return (
    <Panel title="Credentials" meta="References only">
      <p className={`${s.lead} ${s.sentence}`}>
        Every credential this project’s playbook takes. Each is checked against its service when it
        is saved; only a reference is kept here, never the secret.
      </p>
      <div className={s.tableWrap}>
        <table className={`${s.table} ${s.stackOnPhone} type-table`}>
          <thead>
            <tr>
              <th scope="col">System</th>
              <th scope="col">Scope</th>
              <th scope="col">Verified</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <CredentialLine
                key={c.credentialId}
                c={c}
                spec={demo ? undefined : declared.find((d) => d.credentialId === c.credentialId)}
                demo={demo}
                now={now}
                open={editing === c.credentialId}
                onToggle={() => setEditing(editing === c.credentialId ? null : c.credentialId)}
                onCheck={() =>
                  void run(
                    () => post(`${base}/credentials/${c.credentialId}/verify`),
                    `Re-verifying ${c.system}`,
                  )
                }
                onSave={async (secret) => {
                  const ok = await run(
                    () => put(`${base}/credentials/${c.credentialId}`, { secret }),
                    `${c.system} checked and saved.`,
                  );
                  if (ok) setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/**
 * A link for the client's own administrator, who can create this credential when the Director
 * can't: copied to send, good for 7 days and one save.
 */
function HandoffAction({ credentialId, system }: { credentialId: string; system: string }) {
  const { projectId, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await postFor<{ url: string; expiresAt: string }>(
        `/projects/${projectId}/credentials/${credentialId}/handoff`,
        {},
      );
      await navigator.clipboard.writeText(r.url).catch(() => {});
      toast({
        title: 'Link copied',
        detail: `Send it to whoever can create the ${system}. It works once, for 7 days; Launchworks checks it and seals it, and nobody sees it.`,
        tone: 'done',
      });
    } catch (err) {
      toast(messageOf(err, 'Could not make the link.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Action
      kind="quiet"
      disabled={busy}
      onClick={() => void send()}
      label={`Send ${system} to their admin`}
    >
      Send to their admin
    </Action>
  );
}

function CredentialLine({
  c,
  spec,
  demo,
  now,
  open,
  onToggle,
  onCheck,
  onSave,
  onCancel,
}: {
  c: CredentialRow;
  spec: IntakeCredentialSpec | undefined;
  demo: boolean;
  now: number;
  open: boolean;
  onToggle: () => void;
  onCheck: () => void;
  onSave: (secret: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}) {
  const tz = useTz();
  const state = credentialState(c, (iso) => stamp(iso, tz));
  const act = credentialActions(c, spec, demo);
  const days = daysLeft(c.expiresAt, now);
  const formId = `cred-form-${c.credentialId}`;
  return (
    <Fragment>
      <tr data-open={open || undefined}>
        <td className={s.strong}>{c.system}</td>
        <td className={s.scope}>
          {c.scope}
          {c.hint && <span className={`${s.under} type-meta`}>ends in {c.hint}</span>}
        </td>
        <td>
          <div className={s.stateCell}>
            <Notice tone={state.tone}>{state.text}</Notice>
            {days !== null && (
              <Notice tone={expiryTone(days)}>
                Expires in {days} {days === 1 ? 'day' : 'days'}
              </Notice>
            )}
          </div>
        </td>
        <td className={s.actionsCell}>
          <Actions end>
            {act.showCheck && (
              <Action
                disabled={!act.canCheck}
                onClick={onCheck}
                label={`${act.checkLabel} ${c.system}`}
              >
                {act.checkLabel}
              </Action>
            )}
            {act.canEdit && (
              <Action
                expanded={open}
                controls={open ? formId : undefined}
                onClick={onToggle}
                label={`${act.editLabel} ${c.system}`}
              >
                {act.editLabel}
              </Action>
            )}
            {act.canEdit && <HandoffAction credentialId={c.credentialId} system={c.system} />}
          </Actions>
        </td>
      </tr>
      {spec && open && (
        <tr className={s.formRow}>
          <td colSpan={4}>
            <CredentialForm spec={spec} id={formId} onSave={onSave} onCancel={onCancel} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/* ---------- the GitHub App ---------- */

interface GithubStatus {
  connected: boolean;
  app: {
    name: string;
    slug: string;
    owner: string;
    htmlUrl: string;
    installUrl: string;
    permissions: Record<string, string>;
  } | null;
  installations: { account: string; repositories: 'all' | 'selected' }[];
}

const PERMISSION_LABEL: Record<string, string> = {
  contents: 'code',
  pull_requests: 'pull requests',
  checks: 'checks',
  statuses: 'statuses',
  actions: 'Actions runs',
  metadata: 'metadata',
};

const permissions = (p: Record<string, string>) => {
  const of = (level: string) =>
    Object.keys(p)
      .filter((k) => p[k] === level)
      .map((k) => PERMISSION_LABEL[k] ?? k)
      .join(', ');
  return `Writes ${of('write')}. Reads ${of('read')}.`;
};

/** GitHub's manifest flow: the browser posts the manifest to GitHub, where the operator confirms. */
function submitToGithub(action: string, manifest: string) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = manifest;
  form.append(field);
  document.body.append(form);
  form.submit();
}

/**
 * The Launchworks GitHub App, shared by every project: agents reach a client's repository only
 * where the client has installed it. The same calls as the old panel (surfaces/GithubApp.tsx), in
 * Cypher's parts.
 */
export function GithubAppPanel() {
  const { toast } = useApp();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('Icreon Launchworks');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      get<GithubStatus>('/integrations/github')
        .then((x) => {
          setStatus(x);
          setProblem(null);
        })
        .catch((err) => setProblem(messageOf(err, 'Could not load the GitHub App.'))),
    [],
  );
  useEffect(() => void load(), [load]);

  const create = async () => {
    setBusy(true);
    try {
      const r = (await post('/integrations/github/manifest', { name })) as unknown as {
        action: string;
        manifest: string;
      };
      submitToGithub(r.action, r.manifest);
    } catch (err) {
      setBusy(false);
      toast(messageOf(err, 'Could not start the GitHub App setup.'));
    }
  };

  const copy = (url: string) =>
    navigator.clipboard
      .writeText(url)
      .then(() =>
        toast({
          title: 'Install link copied',
          detail: 'Send it to the client’s repository owner.',
          tone: 'done',
        }),
      )
      .catch(() => toast(url));

  return (
    <Panel title="GitHub App" meta="All projects" padded>
      {problem ? (
        <Notice tone="bad">{problem}</Notice>
      ) : !status ? (
        <p className={s.quiet}>Loading…</p>
      ) : !status.app ? (
        <div className={s.stack}>
          <p className={s.lead}>
            Agents reach client repositories through a GitHub App: each client installs it on just
            the repository being migrated, and agents get short-lived tokens for that repository
            only. GitHub shows the permissions and asks you to confirm, then hands the app’s keys
            straight to Launchworks, which seals them in the vault.
          </p>
          <form
            className={s.inline}
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && name.trim()) void create();
            }}
          >
            <Field
              label="App name"
              hint="Clients see this name when they install it. It must be unique on GitHub."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={name}
                  maxLength={34}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
            </Field>
            <BesideField>
              <Action kind="primary" type="submit" disabled={busy || !name.trim()}>
                {busy ? 'Opening GitHub…' : 'Create on GitHub'}
              </Action>
            </BesideField>
          </form>
        </div>
      ) : (
        <div className={s.stack}>
          <Facts
            rows={[
              [
                'App',
                <a
                  key="a"
                  className={s.link}
                  href={status.app.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {status.app.name}
                </a>,
              ],
              ['Owner', status.app.owner],
              ['Access', permissions(status.app.permissions)],
              [
                'Installed on',
                status.installations.length
                  ? status.installations
                      .map(
                        (i) =>
                          `${i.account}${i.repositories === 'all' ? ' (all repositories)' : ''}`,
                      )
                      .join(', ')
                  : 'No accounts yet',
              ],
              [
                'Install link',
                <span key="l" className={s.value}>
                  {status.app.installUrl}
                </span>,
              ],
            ]}
          />
          <Actions>
            <Action onClick={() => void copy(status.app!.installUrl)}>Copy install link</Action>
            <Action onClick={() => void load()}>Refresh</Action>
          </Actions>
          <p className={`${s.quiet} type-meta`}>
            Send the install link to each client’s repository owner and ask them to choose “Only
            select repositories”. Re-check GitHub access in the project’s credentials afterwards.
          </p>
        </div>
      )}
    </Panel>
  );
}
