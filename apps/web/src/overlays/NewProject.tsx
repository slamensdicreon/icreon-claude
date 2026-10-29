import type {
  IntakeCredentialSpec,
  IntakeFieldSpec,
  PlaybookSummary,
  ProjectIntakeInput,
  ProjectDraft,
  RemixDraft,
  VerifyIntakeCredential,
  VerifyIntakeResult,
} from '@lw/contracts';
import { briefApplies, SOURCE_REPO } from '@lw/contracts';
import { useEffect, useState } from 'react';
import { ApiProblem, get, post } from '../lib/api';
import { useApp } from '../state';
import { Scrim } from './Dialogs';

/**
 * The New Project wizard. The Director first picks a playbook: what the team will deliver. The
 * playbook then decides the rest: whether there is a source repository and live site, which
 * target values and which credentials, in which steps. Each credential is tested against the live
 * service here; the API tests them again, seals them in the vault and records the project ready
 * to start.
 */

type Check = { state: 'idle' } | { state: 'busy' } | ({ state: 'done' } & VerifyIntakeResult);

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

const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const URL_OK = /^https?:\/\/[^\s]+\.[^\s]+/;

/**
 * A remix starts from an existing project: its playbook, client, budgets, brief and the tenant
 * facts its connection shares. Credentials the connection provides aren't asked for.
 */
export interface Remix {
  /** A remix of a project, or a project Cypher drafted (with its name and source). */
  draft: RemixDraft | ProjectDraft;
  connectionName: string | null;
}

export function NewProject({ remix }: { remix?: Remix } = {}) {
  const { closeOverlay, switchProject, toast } = useApp();
  const draft = remix?.draft;
  const drafted = draft && 'name' in draft ? draft : null;
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playbookId, setPlaybookId] = useState<string | null>(draft?.playbookId ?? null);
  const [step, setStep] = useState(draft ? 1 : 0);
  const [f, setF] = useState({
    name: drafted?.name ?? '',
    client: draft?.client ?? '',
    timezone:
      draft?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'),
    usd: draft ? String(draft.budgets.usd) : '1200',
    tokensM: draft ? String(draft.budgets.tokens / 1_000_000) : '8',
    hours: draft ? String(draft.budgets.hours) : '240',
    repo: drafted?.repo ?? '',
    branch: drafted?.branch ?? 'main',
    sourceUrl: drafted?.sourceUrl ?? '',
  });
  const [target, setTarget] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(draft?.target ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]),
    ),
  );
  const [secrets, setSecrets] = useState<Record<string, Record<string, string>>>({});
  const [brief, setBrief] = useState<Record<string, string>>(draft?.brief ?? {});
  /** Credentials the connection provides; one the Director types in overrides it. */
  const provided = new Set(draft?.connectionId ? draft.providedCredentials : []);
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<PlaybookSummary[]>('/playbooks')
      .then((list) => {
        setPlaybooks(list);
        if (list.length === 1 && !draft) setPlaybookId(list[0]!.id);
      })
      .catch((err: unknown) =>
        setLoadError(
          err instanceof ApiProblem ? err.message : 'The playbooks could not be loaded.',
        ),
      );
  }, []);

  const pb = playbooks?.find((p) => p.id === playbookId) ?? null;
  const steps = pb?.intake.steps ?? [];
  const credentials = steps.flatMap((s) => s.credentials);
  const hasSource = Boolean(
    pb && (pb.intake.source.repo !== 'none' || pb.intake.source.url !== 'none'),
  );
  // Questions this project is asked: one about the source code only when there is a repository.
  const questions = (pb?.intake.brief ?? []).filter((q) =>
    briefApplies(q, f.repo.trim() ? [SOURCE_REPO] : []),
  );
  const TITLES = [
    'Playbook',
    'Project',
    ...(hasSource ? ['Source'] : []),
    ...steps.map((s) => s.title),
    ...(questions.length ? ['Brief'] : []),
    'Review',
  ];

  const clear = (key: string) => setChecks((c) => ({ ...c, [key]: { state: 'idle' } }));
  const setBase =
    <K extends keyof typeof f>(k: K) =>
    (v: string) => {
      setF((cur) => ({ ...cur, [k]: v }));
      if (k === 'repo' || k === 'branch') clear('github');
    };
  const setField = (key: string, v: string) => {
    setTarget((t) => ({ ...t, [key]: v }));
    // A green tick always means these values: a check that uses this field starts over.
    for (const c of credentials) if (c.uses.includes(key)) clear(c.credentialId);
  };
  const setSecret = (credentialId: string, key: string, v: string) => {
    setSecrets((s) => ({ ...s, [credentialId]: { ...s[credentialId], [key]: v } }));
    clear(credentialId);
  };

  const fieldValue = (fs: IntakeFieldSpec) =>
    (target[fs.key] ?? '').trim() ||
    (fs.defaultFrom === 'name' ? slug(f.name) : '') ||
    fs.defaultValue ||
    '';
  const fieldOk = (fs: IntakeFieldSpec) => {
    const v = fieldValue(fs);
    if (!v) return !fs.required;
    const pattern = fs.pattern ? new RegExp(fs.pattern) : fs.kind === 'slug' ? SLUG : null;
    return !pattern || pattern.test(v);
  };
  const targetValues = () =>
    Object.fromEntries(
      steps
        .flatMap((s) => s.fields)
        .map((fs) => {
          const v = fieldValue(fs);
          return [
            fs.key,
            fs.kind === 'list'
              ? v
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean)
              : v,
          ] as const;
        })
        .filter(([, v]) => v.length),
    );

  const filled = (c: IntakeCredentialSpec) =>
    c.fields.every((fl) => (secrets[c.credentialId]?.[fl.key] ?? '').trim());
  const touched = (c: IntakeCredentialSpec) =>
    c.fields.some((fl) => (secrets[c.credentialId]?.[fl.key] ?? '').trim());
  const ok = (key: string) => {
    const c = checks[key];
    return c?.state === 'done' && c.ok;
  };

  const test = async (key: string, input: VerifyIntakeCredential) => {
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

  const source = pb?.intake.source;
  const repoOk = REPO.test(f.repo.trim());
  const urlOk = f.sourceUrl.trim() ? URL_OK.test(f.sourceUrl.trim()) : source?.url !== 'required';
  const valid = [
    Boolean(pb),
    Boolean(f.name.trim() && f.client.trim() && +f.usd > 0 && +f.tokensM > 0 && +f.hours > 0),
    ...(hasSource
      ? [
          (source!.repo === 'none' ||
            (repoOk && Boolean(f.branch.trim())) ||
            (source!.repo === 'optional' && !f.repo.trim())) &&
            urlOk &&
            // Without a repository the live site is the source: one of the two is needed.
            (source!.repo === 'none' ||
              source!.url === 'none' ||
              Boolean(f.repo.trim() || f.sourceUrl.trim())),
        ]
      : []),
    ...steps.map(
      (s) =>
        s.fields.every(fieldOk) &&
        s.credentials.every((c) =>
          provided.has(c.credentialId) && !touched(c)
            ? true
            : c.required
              ? filled(c) && ok(c.credentialId)
              : !touched(c) || ok(c.credentialId),
        ),
    ),
    ...(questions.length ? [questions.every((q) => !q.required || brief[q.key]?.trim())] : []),
    true,
  ];

  const body = (): ProjectIntakeInput => ({
    playbookId: pb!.id,
    name: f.name.trim(),
    client: f.client.trim(),
    timezone: f.timezone,
    budgets: { usd: +f.usd, tokens: Math.round(+f.tokensM * 1_000_000), hours: +f.hours },
    source: {
      repo: f.repo.trim() || null,
      branch: f.branch.trim() || 'main',
      url: f.sourceUrl.trim() || null,
    },
    target: targetValues(),
    credentials: Object.fromEntries(
      credentials
        .filter(filled)
        .map((c) => [
          c.credentialId,
          Object.fromEntries(
            c.fields.map((fl) => [fl.key, (secrets[c.credentialId]?.[fl.key] ?? '').trim()]),
          ),
        ]),
    ),
    brief: Object.fromEntries(
      Object.entries(brief)
        .filter(([k]) => questions.some((q) => q.key === k))
        .map(([k, v]) => [k, v.trim()])
        .filter(([, v]) => v),
    ),
    connectionId: draft?.connectionId ?? null,
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

  const input = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { placeholder?: string; hint?: string | null; secret?: boolean; bad?: boolean } = {},
  ) => (
    <div className="wiz-field" key={id}>
      <label className="eyebrow" htmlFor={`np-${id}`}>
        {label}
      </label>
      <input
        id={`np-${id}`}
        aria-describedby={opts.hint ? `np-${id}-hint` : undefined}
        className="input"
        type={opts.secret ? 'password' : 'text'}
        autoComplete={opts.secret ? 'new-password' : 'off'}
        spellCheck={false}
        value={value}
        placeholder={opts.placeholder}
        aria-invalid={opts.bad || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {opts.hint && (
        <span className="wiz-hint" id={`np-${id}-hint`}>
          {opts.hint}
        </span>
      )}
    </div>
  );

  const checkRow = (
    key: string,
    label: string,
    ready: boolean,
    req: () => VerifyIntakeCredential,
  ) => {
    const c = checks[key] ?? { state: 'idle' };
    return (
      <div className="wiz-check">
        <button
          type="button"
          className="btn sm"
          disabled={!ready || c.state === 'busy'}
          onClick={() => void test(key, req())}
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

  const field = (fs: IntakeFieldSpec) =>
    input(fs.key, fs.label, target[fs.key] ?? '', (v) => setField(fs.key, v), {
      placeholder:
        (fs.defaultFrom === 'name' ? slug(f.name) : '') || fs.defaultValue || fs.placeholder || '',
      hint: fs.hint,
      bad: Boolean(target[fs.key]?.trim()) && !fieldOk(fs),
    });

  const credential = (c: IntakeCredentialSpec) => (
    <div className="wiz-group" key={c.credentialId}>
      <h4>
        {c.system} <span className="muted">({c.required ? 'required' : 'optional'})</span>
      </h4>
      {provided.has(c.credentialId) && !touched(c) && (
        <p className="wiz-from">
          From the connection {remix?.connectionName ? `“${remix.connectionName}”` : ''}: nothing to
          type. It is checked again against the live service when you create the project. Fill the
          fields below only to use a different one for this project.
        </p>
      )}
      {c.description && !provided.has(c.credentialId) && (
        <p className="wiz-hint">{c.description}</p>
      )}
      <div className="wiz-row">
        {c.fields.map((fl) =>
          input(
            `${c.credentialId}-${fl.key}`,
            fl.label,
            secrets[c.credentialId]?.[fl.key] ?? '',
            (v) => setSecret(c.credentialId, fl.key, v),
            { secret: fl.secret },
          ),
        )}
      </div>
      {checkRow(
        c.credentialId,
        c.fields.length > 1 ? 'connection' : c.fields[0]!.label,
        filled(c) && c.uses.every((u) => (target[u] ?? '').trim()),
        () => ({
          kind: 'credential',
          playbookId: pb!.id,
          credentialId: c.credentialId,
          secret: Object.fromEntries(
            c.fields.map((fl) => [fl.key, (secrets[c.credentialId]?.[fl.key] ?? '').trim()]),
          ),
          target: targetValues(),
        }),
      )}
    </div>
  );

  const pickPage = (
    <>
      <p>What will the team deliver? The playbook sets the team, its plan and what intake needs.</p>
      {loadError && <p className="cred-miss">{loadError}</p>}
      {!playbooks && !loadError && <p className="muted">Loading playbooks…</p>}
      <div className="wiz-playbooks" role="radiogroup" aria-label="Playbook">
        {playbooks?.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === playbookId}
            className={`wiz-playbook ${p.id === playbookId ? 'on' : ''}`}
            onClick={() => {
              setPlaybookId(p.id);
              setChecks({});
            }}
          >
            <span className="eyebrow">
              {p.platform.name} · v{p.version}
            </span>
            <b>{p.name}</b>
            <span className="muted">{p.charter.mission}</span>
            <ul>
              {p.charter.outcomes.map((o) => (
                <li key={o.id}>{o.title}</li>
              ))}
            </ul>
          </button>
        ))}
      </div>
    </>
  );

  const projectPage = (
    <>
      <p>A real engagement: agents work on the systems you give in the next steps.</p>
      {input('name', 'Project name', f.name, setBase('name'), {
        placeholder: 'CableCom corporate site',
      })}
      {input('client', 'Client', f.client, setBase('client'), { placeholder: 'CableCom' })}
      <div className="wiz-field">
        <label className="eyebrow" htmlFor="np-timezone">
          Time zone
        </label>
        <select
          id="np-timezone"
          aria-describedby="np-timezone-hint"
          className="select"
          value={f.timezone}
          onChange={(e) => setBase('timezone')(e.target.value)}
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
        {input('usd', 'Budget, $', f.usd, setBase('usd'), { placeholder: '1200' })}
        {input('tokensM', 'Tokens, millions', f.tokensM, setBase('tokensM'), { placeholder: '8' })}
        {input('hours', 'Hours', f.hours, setBase('hours'), { placeholder: '240' })}
      </div>
    </>
  );

  const sourcePage = source && (
    <>
      {source.intro && <p>{source.intro}</p>}
      {source.repo !== 'none' && (
        <>
          {input(
            'repo',
            `Repository${source.repo === 'optional' ? ' (optional)' : ''}`,
            f.repo,
            setBase('repo'),
            {
              placeholder: 'cablecom/website',
              hint: 'owner/name on GitHub. Agents reach it through the Launchworks GitHub App, which the client installs on this repository.',
              bad: Boolean(f.repo) && !repoOk,
            },
          )}
          {input('branch', 'Branch', f.branch, setBase('branch'), { placeholder: 'main' })}
          {checkRow('github', 'access', Boolean(repoOk && f.branch.trim()), () => ({
            kind: 'github.repo',
            repo: f.repo.trim(),
            branch: f.branch.trim(),
          }))}
          <p className="wiz-hint">
            {source.repo === 'optional'
              ? 'No repository? Leave it blank and give the live site: agents inventory it and rebuild each component from its pages’ markup and styles. '
              : ''}
            If the client hasn’t installed the app yet, the project records it and you can check
            again from Settings.
          </p>
        </>
      )}
      {source.url !== 'none' &&
        input(
          'sourceUrl',
          `Live site${source.url === 'optional' ? ' (optional)' : ''}`,
          f.sourceUrl,
          setBase('sourceUrl'),
          {
            placeholder: 'https://www.cablecom.com',
            hint: 'Used for crawling, parity checks and screenshots.',
            bad: Boolean(f.sourceUrl.trim()) && !urlOk,
          },
        )}
    </>
  );

  const stepPages = steps.map((s) => (
    <>
      {s.intro && <p>{s.intro}</p>}
      {s.fields.length > 0 && <div className="wiz-row wiz-wrap">{s.fields.map(field)}</div>}
      {s.credentials.map(credential)}
    </>
  ));

  const reviewPage = pb && (
    <>
      <p>
        Everything below is checked again when you create the project. Secrets are sealed and never
        shown again.
      </p>
      <dl className="contract wiz-review">
        <dt>Playbook</dt>
        <dd>
          {pb.name} ({pb.platform.name}, v{pb.version})
        </dd>
        <dt>Project</dt>
        <dd>
          {f.name} for {f.client}, {f.timezone}
        </dd>
        <dt>Budgets</dt>
        <dd>
          ${f.usd}, {f.tokensM}M tokens, {f.hours} h
        </dd>
        {hasSource && (
          <>
            <dt>Source</dt>
            <dd>
              {[f.repo && `${f.repo} (${f.branch})`, f.sourceUrl].filter(Boolean).join(', ') ||
                'None'}
            </dd>
          </>
        )}
        {steps.flatMap((s) => s.fields).length > 0 && (
          <>
            <dt>Target</dt>
            <dd>
              {steps
                .flatMap((s) => s.fields)
                .map((fs) => `${fs.label}: ${fieldValue(fs) || '–'}`)
                .join(' · ')}
            </dd>
          </>
        )}
        {credentials.length > 0 && (
          <>
            <dt>Credentials</dt>
            <dd>
              {credentials
                .filter((c) => filled(c) || provided.has(c.credentialId))
                .map((c) => `${c.system} ${filled(c) ? '✓' : '(from the connection)'}`)
                .join(', ') || 'None yet'}
            </dd>
          </>
        )}
        {questions.some((q) => brief[q.key]?.trim()) && (
          <>
            <dt>Brief</dt>
            <dd>
              {questions
                .filter((q) => brief[q.key]?.trim())
                .map((q) => `${q.label} ${brief[q.key]}`)
                .join(' · ')}
            </dd>
          </>
        )}
        {source?.repo !== 'none' && f.repo && (
          <>
            <dt>Repository access</dt>
            <dd>
              {ok('github')
                ? 'GitHub App ✓'
                : 'Not confirmed yet. Creating the project checks it again and records the outcome; re-check it in Settings once the client installs the app.'}
            </dd>
          </>
        )}
      </dl>
      <p className="muted" style={{ fontSize: 13 }}>
        The project is created ready to start. Nothing runs until you press Start on Mission
        Control.
      </p>
    </>
  );

  const briefPage = (
    <>
      <p>
        What the client wants beyond access. Every agent works with these answers, and acceptance is
        measured against them.
      </p>
      {questions.map((q) => (
        <div className="wiz-field" key={q.key}>
          <label className="eyebrow" htmlFor={`np-brief-${q.key}`}>
            {q.label}
            {q.required ? '' : ' (optional)'}
          </label>
          {q.kind === 'text' ? (
            <textarea
              id={`np-brief-${q.key}`}
              className="input"
              rows={2}
              placeholder={q.placeholder ?? ''}
              value={brief[q.key] ?? ''}
              onChange={(e) => setBrief((b) => ({ ...b, [q.key]: e.target.value }))}
            />
          ) : (
            <select
              id={`np-brief-${q.key}`}
              className="select"
              value={brief[q.key] ?? ''}
              onChange={(e) => setBrief((b) => ({ ...b, [q.key]: e.target.value }))}
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
        </div>
      ))}
    </>
  );

  const pages = [
    pickPage,
    projectPage,
    ...(hasSource ? [sourcePage] : []),
    ...stepPages,
    ...(questions.length ? [briefPage] : []),
    reviewPage,
  ];
  const last = TITLES.length - 1;

  return (
    <Scrim>
      <div className="dialog wiz" role="dialog" aria-labelledby="np-t">
        <h2 id="np-t">
          {draft?.from
            ? `New project like ${draft.from.name}`
            : draft
              ? 'New project drafted by Cypher'
              : 'New project'}
        </h2>
        <ol className="wiz-steps" aria-label="Steps">
          {TITLES.map((s, i) => (
            <li
              key={`${i}-${s}`}
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
          {step < last ? (
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
