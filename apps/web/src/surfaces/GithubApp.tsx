import { useCallback, useEffect, useState } from 'react';
import { ApiProblem, get, post } from '../lib/api';
import { useApp } from '../state';

interface Status {
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
 * where the client has installed it.
 */
export function GithubAppPanel() {
  const { toast } = useApp();
  const [status, setStatus] = useState<Status | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('Icreon Launchworks');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      get<Status>('/integrations/github')
        .then((s) => {
          setStatus(s);
          setProblem(null);
        })
        .catch((err) =>
          setProblem(err instanceof ApiProblem ? err.message : 'Could not load the GitHub App.'),
        ),
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
      toast(err instanceof ApiProblem ? err.message : 'Could not start the GitHub App setup.');
    }
  };

  const copy = (url: string) =>
    navigator.clipboard
      .writeText(url)
      .then(() => toast('Install link copied. Send it to the client’s repository owner.'))
      .catch(() => toast(url));

  return (
    <section className="panel gh-app">
      <h2>
        GitHub App <small>all projects</small>
      </h2>
      {problem ? (
        <p className="quiet-line">{problem}</p>
      ) : !status ? (
        <p className="quiet-line">Loading…</p>
      ) : !status.app ? (
        <>
          <p className="muted">
            Agents reach client repositories through a GitHub App: each client installs it on just
            the repository being migrated, and agents get short-lived tokens for that repository
            only. GitHub shows the permissions and asks you to confirm, then hands the app’s keys
            straight to Launchworks, which seals them in the vault.
          </p>
          <div className="wiz-field">
            <label className="eyebrow" htmlFor="gh-app-name">
              App name
            </label>
            <input
              id="gh-app-name"
              aria-describedby="gh-app-name-hint"
              className="input"
              value={name}
              maxLength={34}
              onChange={(e) => setName(e.target.value)}
            />
            <span className="wiz-hint" id="gh-app-name-hint">
              Clients see this name when they install it. It must be unique on GitHub.
            </span>
          </div>
          <div className="btn-row">
            <button
              className="btn sm primary"
              disabled={busy || !name.trim()}
              onClick={() => void create()}
            >
              {busy ? 'Opening GitHub…' : 'Create on GitHub'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="kv">
            <span>App</span>
            <span className="v">
              <a href={status.app.htmlUrl} target="_blank" rel="noreferrer">
                {status.app.name}
              </a>
            </span>
            <span>Owner</span>
            <span className="v">{status.app.owner}</span>
            <span>Access</span>
            <span className="v">{permissions(status.app.permissions)}</span>
            <span>Installed on</span>
            <span className="v">
              {status.installations.length
                ? status.installations
                    .map(
                      (i) => `${i.account}${i.repositories === 'all' ? ' (all repositories)' : ''}`,
                    )
                    .join(', ')
                : 'No accounts yet'}
            </span>
          </div>
          <div className="row">
            <span className="l mono gh-install">{status.app.installUrl}</span>
            <button className="btn sm" onClick={() => void copy(status.app!.installUrl)}>
              Copy install link
            </button>
            <button className="btn sm" onClick={() => void load()}>
              Refresh
            </button>
          </div>
          <p className="faint" style={{ fontSize: 13 }}>
            Send the install link to each client’s repository owner and ask them to choose “Only
            select repositories”. Re-check GitHub access in the project’s credentials afterwards.
          </p>
        </>
      )}
    </section>
  );
}
