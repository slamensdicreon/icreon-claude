import type { ProjectIntakeInput, VerifyIntakeCredential, VerifyIntakeResult } from '@lw/contracts';
import { useState } from 'react';
import { ApiProblem, post } from '../lib/api';
import { useApp } from '../state';
import { Scrim } from './Dialogs';

/**
 * The New Project wizard. A real engagement starts with everything the team will need: the
 * source repository, the SitecoreAI environment and its automation client, Experience Edge, and
 * hosting. Each credential is tested against the live service here; the API tests them again,
 * seals them in the vault and records the project ready to start.
 */

type Check = { state: 'idle' } | { state: 'busy' } | ({ state: 'done' } & VerifyIntakeResult);
type CheckKey = 'environment' | 'organization' | 'edgePreview' | 'edgeLive';

const STEPS = ['Project', 'Source', 'SitecoreAI', 'Edge and hosting', 'Review'] as const;

const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Australia/Sydney',
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

export function NewProject() {
  const { closeOverlay, switchProject, toast } = useApp();
  const [step, setStep] = useState(0);
  const [f, setF] = useState({
    name: '',
    client: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
    usd: '1200',
    tokensM: '8',
    hours: '240',
    repo: '',
    branch: 'main',
    sourceUrl: '',
    cmHost: '',
    siteCollection: '',
    site: '',
    languages: 'en',
    envClientId: '',
    envClientSecret: '',
    withOrg: false,
    orgClientId: '',
    orgClientSecret: '',
    previewContextId: '',
    liveContextId: '',
    hostingProject: '',
  });
  const [checks, setChecks] = useState<Record<CheckKey, Check>>({
    environment: { state: 'idle' },
    organization: { state: 'idle' },
    edgePreview: { state: 'idle' },
    edgeLive: { state: 'idle' },
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editing a field a check depends on clears that check: a green tick always means these values.
  const DEPENDS: Partial<Record<keyof typeof f, CheckKey>> = {
    cmHost: 'environment',
    envClientId: 'environment',
    envClientSecret: 'environment',
    orgClientId: 'organization',
    orgClientSecret: 'organization',
    previewContextId: 'edgePreview',
    liveContextId: 'edgeLive',
  };
  const set =
    <K extends keyof typeof f>(k: K) =>
    (v: (typeof f)[K]) => {
      setF((cur) => ({ ...cur, [k]: v }));
      const dep = DEPENDS[k];
      if (dep) setChecks((c) => ({ ...c, [dep]: { state: 'idle' } }));
    };

  const test = async (key: CheckKey, input: VerifyIntakeCredential) => {
    setChecks((c) => ({ ...c, [key]: { state: 'busy' } }));
    try {
      const r = (await post('/intake/verify', input)) as unknown as VerifyIntakeResult;
      setChecks((c) => ({ ...c, [key]: { state: 'done', ...r } }));
    } catch (err) {
      setChecks((c) => ({
        ...c,
        [key]: {
          state: 'done',
          ok: false,
          detail: err instanceof ApiProblem ? err.message : 'The check could not run.',
          sites: [],
          expiresAt: null,
        },
      }));
    }
  };

  const ok = (k: CheckKey) => checks[k].state === 'done' && (checks[k] as { ok: boolean }).ok;
  const urlOk = !f.sourceUrl || /^https?:\/\/[^\s]+\.[^\s]+/.test(f.sourceUrl.trim());
  const repoOk = /^[\w.-]+\/[\w.-]+$/.test(f.repo.trim());
  const hosting = f.hostingProject || slug(f.name);
  const valid = [
    Boolean(f.name.trim() && f.client.trim() && +f.usd > 0 && +f.tokensM > 0 && +f.hours > 0),
    Boolean(repoOk && f.branch.trim() && urlOk),
    Boolean(f.cmHost.trim() && f.siteCollection.trim() && f.site.trim() && ok('environment')) &&
      (!f.withOrg || ok('organization')),
    (!f.previewContextId.trim() || ok('edgePreview')) &&
      (!f.liveContextId.trim() || ok('edgeLive')) &&
      /^[a-z0-9][a-z0-9-]{0,99}$/.test(hosting),
    true,
  ];

  const body = (): ProjectIntakeInput => ({
    name: f.name.trim(),
    client: f.client.trim(),
    timezone: f.timezone,
    budgets: { usd: +f.usd, tokens: Math.round(+f.tokensM * 1_000_000), hours: +f.hours },
    source: { repo: f.repo.trim(), branch: f.branch.trim(), url: f.sourceUrl.trim() || null },
    target: {
      cmHost: f.cmHost.trim(),
      siteCollection: f.siteCollection.trim(),
      site: f.site.trim(),
      languages: f.languages
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean),
    },
    hosting: { provider: 'vercel', project: hosting },
    credentials: {
      environment: { clientId: f.envClientId.trim(), clientSecret: f.envClientSecret.trim() },
      organization: f.withOrg
        ? { clientId: f.orgClientId.trim(), clientSecret: f.orgClientSecret.trim() }
        : null,
      edgePreviewContextId: f.previewContextId.trim() || null,
      edgeLiveContextId: f.liveContextId.trim() || null,
    },
  });

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = (await post('/projects', body())) as unknown as { projectId: string };
      closeOverlay();
      toast(`${f.name.trim()} is set up. Its credentials are verified and sealed.`);
      window.setTimeout(() => switchProject(r.projectId), 800);
    } catch (err) {
      setError(err instanceof ApiProblem ? err.message : 'The project could not be created.');
      setBusy(false);
    }
  };

  const text = (
    label: string,
    k: keyof typeof f,
    placeholder: string,
    opts: { hint?: string; secret?: boolean; bad?: boolean } = {},
  ) => (
    <div className="wiz-field">
      <label className="eyebrow" htmlFor={`np-${k}`}>
        {label}
      </label>
      <input
        id={`np-${k}`}
        aria-describedby={opts.hint ? `np-${k}-hint` : undefined}
        className="input"
        type={opts.secret ? 'password' : 'text'}
        autoComplete={opts.secret ? 'new-password' : 'off'}
        spellCheck={false}
        value={f[k] as string}
        placeholder={placeholder}
        aria-invalid={opts.bad || undefined}
        onChange={(e) => set(k)(e.target.value as never)}
      />
      {opts.hint && (
        <span className="wiz-hint" id={`np-${k}-hint`}>
          {opts.hint}
        </span>
      )}
    </div>
  );

  const checkRow = (
    key: CheckKey,
    label: string,
    ready: boolean,
    input: () => VerifyIntakeCredential,
  ) => {
    const c = checks[key];
    return (
      <div className="wiz-check">
        <button
          type="button"
          className="btn sm"
          disabled={!ready || c.state === 'busy'}
          onClick={() => void test(key, input())}
        >
          {c.state === 'busy' ? 'Testing…' : `Test ${label}`}
        </button>
        {c.state === 'done' && (
          <span className={c.ok ? 'cred-ok' : 'cred-miss'} role="status">
            {c.detail}
          </span>
        )}
      </div>
    );
  };

  const pages = [
    <>
      <p>
        A real engagement: agents work on the repository and the SitecoreAI environment you give
        here.
      </p>
      {text('Project name', 'name', 'CableCom corporate site')}
      {text('Client', 'client', 'CableCom')}
      <div className="wiz-field">
        <label className="eyebrow" htmlFor="np-timezone">
          Time zone
        </label>
        <select
          id="np-timezone"
          aria-describedby="np-timezone-hint"
          className="select"
          value={f.timezone}
          onChange={(e) => set('timezone')(e.target.value)}
        >
          {[...new Set([f.timezone, ...ZONES])].map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
        <span className="wiz-hint" id="np-timezone-hint">
          Working days and every time in the project are counted in it.
        </span>
      </div>
      <div className="wiz-row">
        {text('Budget, $', 'usd', '1200')}
        {text('Tokens, millions', 'tokensM', '8')}
        {text('Hours', 'hours', '240')}
      </div>
    </>,
    <>
      <p>The code being migrated. Agents read it and open pull requests on a branch.</p>
      {text('Repository', 'repo', 'cablecom/website', {
        hint: 'owner/name on GitHub. Agents reach it through the Icreon GitHub App once that is connected.',
        bad: Boolean(f.repo) && !repoOk,
      })}
      {text('Branch', 'branch', 'main')}
      {text('Live site', 'sourceUrl', 'https://www.cablecom.com', {
        hint: 'Optional. Used for crawling, parity checks and screenshots.',
        bad: !urlOk,
      })}
    </>,
    <>
      <p>
        The SitecoreAI environment the site is built in. In the Deploy app, create an{' '}
        <b>environment automation client</b> for this environment and paste its ID and secret.
      </p>
      {text('CM host', 'cmHost', 'xmc-cablecom-abc123.sitecorecloud.io', {
        hint: 'From the environment’s Details tab.',
      })}
      <div className="wiz-row">
        {text('Site collection', 'siteCollection', 'cablecom')}
        {text('Site', 'site', 'cablecom')}
        {text('Languages', 'languages', 'en, es-US')}
      </div>
      <div className="wiz-group">
        <h4>Environment automation client (required)</h4>
        <div className="wiz-row">
          {text('Client ID', 'envClientId', '')}
          {text('Client secret', 'envClientSecret', '', { secret: true })}
        </div>
        {checkRow(
          'environment',
          'connection',
          Boolean(f.cmHost.trim() && f.envClientId.trim() && f.envClientSecret.trim()),
          () => ({
            kind: 'sitecore.environment',
            cmHost: f.cmHost,
            clientId: f.envClientId,
            clientSecret: f.envClientSecret,
          }),
        )}
      </div>
      <div className="wiz-group">
        <label className="toggle-row">
          <button
            type="button"
            className="toggle"
            role="switch"
            aria-checked={f.withOrg}
            aria-label="Add an organization client"
            onClick={() => {
              setF((cur) => ({ ...cur, withOrg: !cur.withOrg }));
              setChecks((c) => ({ ...c, organization: { state: 'idle' } }));
            }}
          />
          <span>
            <b>Organization automation client</b>{' '}
            <span className="muted">
              (optional: Deploy API, reaches every environment in the org)
            </span>
          </span>
        </label>
        {f.withOrg && (
          <>
            <div className="wiz-row">
              {text('Client ID', 'orgClientId', '')}
              {text('Client secret', 'orgClientSecret', '', { secret: true })}
            </div>
            {checkRow(
              'organization',
              'client',
              Boolean(f.orgClientId.trim() && f.orgClientSecret.trim()),
              () => ({
                kind: 'sitecore.organization',
                clientId: f.orgClientId,
                clientSecret: f.orgClientSecret,
              }),
            )}
          </>
        )}
      </div>
    </>,
    <>
      <p>
        Experience Edge Context IDs for the new head, from the environment&rsquo;s Developer
        settings. Both are optional now and can be added later in Settings.
      </p>
      <div className="wiz-group">
        {text('Preview Context ID', 'previewContextId', '', { secret: true })}
        {checkRow('edgePreview', 'preview ID', Boolean(f.previewContextId.trim()), () => ({
          kind: 'edge.preview',
          contextId: f.previewContextId,
        }))}
      </div>
      <div className="wiz-group">
        {text('Live Context ID', 'liveContextId', '', { secret: true })}
        {checkRow('edgeLive', 'live ID', Boolean(f.liveContextId.trim()), () => ({
          kind: 'edge.live',
          contextId: f.liveContextId,
        }))}
      </div>
      {text('Vercel project for the head', 'hostingProject', slug(f.name) || 'cablecom-website', {
        hint: 'Lowercase letters, digits and dashes. The editing secret is generated when the head is deployed.',
      })}
    </>,
    <>
      <p>
        Everything below is checked again when you create the project. Secrets are sealed and never
        shown again.
      </p>
      <dl className="contract wiz-review">
        <dt>Project</dt>
        <dd>
          {f.name} for {f.client}, {f.timezone}
        </dd>
        <dt>Budgets</dt>
        <dd>
          ${f.usd}, {f.tokensM}M tokens, {f.hours} h
        </dd>
        <dt>Source</dt>
        <dd>
          {f.repo} ({f.branch}){f.sourceUrl ? `, ${f.sourceUrl}` : ''}
        </dd>
        <dt>Target</dt>
        <dd>
          {f.cmHost}: {f.siteCollection} / {f.site}, {f.languages}
        </dd>
        <dt>Credentials</dt>
        <dd>
          Environment client ✓{f.withOrg && ', organization client ✓'}
          {f.previewContextId && ', preview Context ID ✓'}
          {f.liveContextId && ', live Context ID ✓'}
        </dd>
        <dt>Hosting</dt>
        <dd>Vercel, {hosting}</dd>
        <dt>Not connected yet</dt>
        <dd>GitHub access (the Icreon GitHub App). The project records it as needed.</dd>
      </dl>
      <p className="muted" style={{ fontSize: 13 }}>
        The project is created ready to start. Nothing runs until you press Start on Mission
        Control.
      </p>
    </>,
  ];

  return (
    <Scrim>
      <div className="dialog wiz" role="dialog" aria-labelledby="np-t">
        <h2 id="np-t">New project</h2>
        <ol className="wiz-steps" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={i === step ? 'step' : undefined}
              className={i < step ? 'done' : ''}
            >
              <span>{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <div className="wiz-body">{pages[step]}</div>
        {error && (
          <p className="cred-miss" role="alert" style={{ marginTop: 8 }}>
            {error}
          </p>
        )}
        <div className="btn-row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button
            type="button"
            className="btn"
            onClick={step ? () => setStep(step - 1) : closeOverlay}
          >
            {step ? 'Back' : 'Cancel'}
          </button>
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              className="btn primary"
              disabled={!valid[step]}
              onClick={() => setStep(step + 1)}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              disabled={busy || !valid.every(Boolean)}
              onClick={() => void create()}
            >
              {busy ? 'Checking and creating…' : 'Create project'}
            </button>
          )}
        </div>
      </div>
    </Scrim>
  );
}
