/*
 * The wizard's step bodies. Each renders what one step asks and nothing about where it sits in
 * the wizard: the page owns the order, validity and the buttons.
 */
import type { BriefQuestion, IntakeCredentialSpec, PlaybookSummary } from '@lw/contracts';
import type { ReactNode } from 'react';
import type { CatalogGroup } from '../../lib/showcase';
import { readiness } from '../../lib/showcase';
import { Facts, Field, RadioTiles, Select, TextInput, type Tile } from '../../ui/cypher/forms';
import {
  budgetLine,
  fieldBad,
  fieldPlaceholder,
  fieldsOf,
  fieldValue,
  filled,
  fromConnection,
  GITHUB_CHECK,
  passed,
  repoTestable,
  sourceLine,
  sourceUrlOk,
  testable,
  testLabel,
  zonesWith,
  type Answers,
  type BaseFields,
  type Checks,
} from './model';
import { answerWord, BriefFields, CredentialFields, Notice, TestRow } from './shared';
import { isRepo } from './validate';
import s from './intake.module.css';

type IntakeStep = PlaybookSummary['intake']['steps'][number];

/** A paragraph that opens a step. */
export function Lead({ children }: { children: ReactNode }) {
  return <p className={`${s.lead} type-body-small`}>{children}</p>;
}

/* ---------- Entity ---------- */

export function EntityStep({
  groups,
  value,
  loading,
  error,
  onPick,
}: {
  groups: CatalogGroup[];
  value: string | null;
  loading: boolean;
  error: string | null;
  onPick: (id: string) => void;
}) {
  const tiles: Tile<string>[] = groups.map((g) => {
    const coming = g.entity.status === 'coming';
    const locked = g.entity.status === 'locked';
    return {
      value: g.entity.id,
      eyebrow: g.entity.vendor,
      title: g.entity.name,
      body: g.entity.description,
      tag: coming ? 'Coming soon' : locked ? 'Not in your license' : undefined,
      disabled: coming || locked,
      foot: (
        <span className={s.lines}>
          <span>{g.entity.category}</span>
          <span>
            {coming
              ? 'On the roadmap: readable now, runnable later'
              : locked
                ? 'Ask Icreon to add it to your license'
                : readiness(g)}
          </span>
        </span>
      ),
    };
  });
  return (
    <>
      <Lead>
        Which platform is the site built on? Each entity brings its own playbooks, credentials and
        team. Entities on the roadmap are shown so the catalog reads as a whole.
      </Lead>
      {error && <Notice tone="bad">{error}</Notice>}
      {loading && <p className={`${s.quiet} type-body-small`}>Loading the catalog…</p>}
      <RadioTiles label="Entity" value={value} options={tiles} onChange={onPick} />
    </>
  );
}

/* ---------- Playbook ---------- */

export function PlaybookStep({
  entity,
  value,
  onPick,
}: {
  entity: CatalogGroup | null;
  value: string | null;
  onPick: (id: string) => void;
}) {
  const tiles: Tile<string>[] = (entity?.playbooks ?? []).map((p) => {
    const coming = p.status === 'coming';
    const locked = p.status === 'locked';
    const sum = p.summary;
    return {
      value: p.id,
      eyebrow: entity?.entity.name ?? '',
      tag: coming ? 'Coming soon' : locked ? 'Not in your license' : 'Ready',
      title: p.name,
      disabled: coming || locked,
      body: (
        <>
          <span className={s.tileText}>{sum ? sum.charter.mission : p.description}</span>
          {sum && (
            <span className={s.outcomes}>
              {sum.charter.outcomes.slice(0, 4).map((o) => (
                <span key={o.id} className={s.outcome}>
                  {o.title}
                </span>
              ))}
            </span>
          )}
        </>
      ),
      foot: coming
        ? 'On the roadmap: readable now, runnable later'
        : locked
          ? 'Ask Icreon to add it to your license'
          : `Version ${sum?.version ?? ''}`,
    };
  });
  return (
    <>
      <Lead>
        What will the team deliver on {entity?.entity.name ?? 'this platform'}? The playbook sets
        the team, its plan, its gates and what intake needs. Playbooks on the roadmap are readable
        here and will become runnable as they are written.
      </Lead>
      <RadioTiles label="Playbook" value={value} options={tiles} onChange={onPick} />
    </>
  );
}

/* ---------- Project ---------- */

export function ProjectStep({
  f,
  set,
}: {
  f: BaseFields;
  set: (k: keyof BaseFields, v: string) => void;
}) {
  const text = (k: keyof BaseFields, label: string, placeholder: string, unit?: boolean) => (
    <Field label={label}>
      {({ id, describedBy }) => (
        <TextInput
          id={id}
          aria-describedby={describedBy}
          value={f[k]}
          placeholder={placeholder}
          inputMode={unit ? 'decimal' : undefined}
          autoComplete="off"
          spellCheck={unit ? false : undefined}
          onChange={(e) => set(k, e.target.value)}
        />
      )}
    </Field>
  );
  return (
    <>
      <Lead>A real engagement: agents work on the systems you give in the next steps.</Lead>
      <div className={s.two}>
        {text('name', 'Project name', 'CableCom corporate site')}
        {text('client', 'Client', 'CableCom')}
      </div>
      <Field label="Time zone" hint="Working days and every time in the project are counted in it.">
        {({ id, describedBy }) => (
          <Select
            id={id}
            aria-describedby={describedBy}
            value={f.timezone}
            onChange={(e) => set('timezone', e.target.value)}
          >
            {zonesWith(f.timezone).map((z) => (
              <option key={z}>{z}</option>
            ))}
          </Select>
        )}
      </Field>
      <fieldset className={s.fieldset}>
        <legend className={`${s.legend} type-section`}>Budgets</legend>
        <div className={s.three}>
          {text('usd', 'Budget, $', '1200', true)}
          {text('tokensM', 'Tokens, millions', '8', true)}
          {text('hours', 'Hours', '240', true)}
        </div>
      </fieldset>
    </>
  );
}

/* ---------- Source ---------- */

export function SourceStep({
  source,
  f,
  set,
  checks,
  onTestRepo,
}: {
  source: PlaybookSummary['intake']['source'];
  f: BaseFields;
  set: (k: keyof BaseFields, v: string) => void;
  checks: Checks;
  onTestRepo: () => void;
}) {
  const repoBad = Boolean(f.repo) && !isRepo(f.repo);
  const urlBad = Boolean(f.sourceUrl.trim()) && !sourceUrlOk(source, f);
  return (
    <>
      {source.intro && <Lead>{source.intro}</Lead>}
      {source.repo !== 'none' && (
        <div className={s.group}>
          <div className={s.repoRow}>
            <Field
              label="Repository"
              optional={source.repo === 'optional'}
              hint="owner/name on GitHub. Agents reach it through the Launchworks GitHub App, which the client installs on this repository."
              error={repoBad ? 'Write it as owner/name, the way GitHub shows it.' : null}
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={f.repo}
                  placeholder="cablecom/website"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => set('repo', e.target.value)}
                />
              )}
            </Field>
            <Field label="Branch">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={f.branch}
                  placeholder="main"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => set('branch', e.target.value)}
                />
              )}
            </Field>
          </div>
          <TestRow
            label="access"
            ready={repoTestable(f)}
            check={checks[GITHUB_CHECK]}
            onTest={onTestRepo}
          />
          <p className={`${s.quiet} type-meta`}>
            {source.repo === 'optional'
              ? 'No repository? Leave it blank and give the live site: agents inventory it and rebuild each component from its pages’ markup and styles. '
              : ''}
            If the client hasn’t installed the app yet, the project records it and you can check
            again from Settings.
          </p>
        </div>
      )}
      {source.url !== 'none' && (
        <Field
          label="Live site"
          optional={source.url === 'optional'}
          hint="Used for crawling, parity checks and screenshots."
          error={urlBad ? 'A full address with its host, like https://www.cablecom.com.' : null}
        >
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              invalid={invalid}
              type="url"
              inputMode="url"
              value={f.sourceUrl}
              placeholder="https://www.cablecom.com"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => set('sourceUrl', e.target.value)}
            />
          )}
        </Field>
      )}
    </>
  );
}

/* ---------- one of the playbook's intake steps ---------- */

export function IntakeStepBody({
  step,
  answers,
  checks,
  provided,
  connectionName,
  onField,
  onSecret,
  onTest,
}: {
  step: IntakeStep;
  answers: Answers;
  checks: Checks;
  provided: Set<string>;
  connectionName: string | null;
  onField: (key: string, v: string) => void;
  onSecret: (credentialId: string, key: string, v: string) => void;
  onTest: (c: IntakeCredentialSpec) => void;
}) {
  return (
    <>
      {step.intro && <Lead>{step.intro}</Lead>}
      {step.fields.length > 0 && (
        <div className={s.fields}>
          {step.fields.map((fs) => (
            <Field
              key={fs.key}
              label={fs.label}
              optional={!fs.required}
              hint={fs.hint}
              error={fieldBad(fs, answers) ? 'This isn’t in the form the platform expects.' : null}
            >
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  invalid={invalid}
                  value={answers.target[fs.key] ?? ''}
                  placeholder={fieldPlaceholder(fs, answers.f.name)}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => onField(fs.key, e.target.value)}
                />
              )}
            </Field>
          ))}
        </div>
      )}
      {step.credentials.map((c) => (
        <section key={c.credentialId} className={s.credential} aria-label={c.system}>
          <div className={s.credentialHead}>
            <h3 className="type-section">{c.system}</h3>
            <span className={`${s.quiet} type-meta`}>{c.required ? 'Required' : 'Optional'}</span>
          </div>
          {fromConnection(c, provided, answers.secrets) ? (
            <Notice tone="ok">
              From the connection{connectionName ? ` “${connectionName}”` : ''}: nothing to type. It
              is checked again against the live service when you create the project. Fill the fields
              below only to use a different one for this project.
            </Notice>
          ) : (
            c.description && <p className={`${s.desc} type-meta`}>{c.description}</p>
          )}
          <CredentialFields
            spec={c}
            values={answers.secrets[c.credentialId] ?? {}}
            onChange={(key, v) => onSecret(c.credentialId, key, v)}
          />
          <TestRow
            label={testLabel(c)}
            ready={testable(c, answers)}
            check={checks[c.credentialId]}
            onTest={() => onTest(c)}
          />
        </section>
      ))}
    </>
  );
}

/* ---------- Brief ---------- */

export function BriefStep({
  questions,
  brief,
  onChange,
}: {
  questions: BriefQuestion[];
  brief: Record<string, string>;
  onChange: (key: string, v: string) => void;
}) {
  return (
    <>
      <Lead>
        What the client wants beyond access. Every agent works with these answers, and acceptance is
        measured against them.
      </Lead>
      <BriefFields questions={questions} answers={brief} onChange={onChange} />
    </>
  );
}

/* ---------- Review ---------- */

export function ReviewStep({
  pb,
  answers,
  checks,
  provided,
  showSource,
  questions,
}: {
  pb: PlaybookSummary;
  answers: Answers;
  checks: Checks;
  provided: Set<string>;
  showSource: boolean;
  questions: BriefQuestion[];
}) {
  const { f, brief } = answers;
  const fields = fieldsOf(pb);
  const credentials = pb.intake.steps.flatMap((st) => st.credentials);
  const given = credentials.filter(
    (c) => filled(c, answers.secrets) || provided.has(c.credentialId),
  );
  const answered = questions.filter((q) => brief[q.key]?.trim());
  const rows: [ReactNode, ReactNode][] = [
    ['Entity', `${pb.platform.name} (${pb.platform.vendor})`],
    ['Playbook', `${pb.name} (v${pb.version})`],
    ['Project', `${f.name} for ${f.client}, ${f.timezone}`],
    ['Budgets', budgetLine(f)],
  ];
  if (showSource) rows.push(['Source', sourceLine(f) || 'None']);
  if (fields.length)
    rows.push([
      'Target',
      <div key="t" className={s.lines}>
        {fields.map((fs) => (
          <span key={fs.key}>
            {fs.label}: {fieldValue(fs, answers) || '–'}
          </span>
        ))}
      </div>,
    ]);
  if (credentials.length)
    rows.push([
      'Credentials',
      given.length ? (
        <div key="c" className={s.lines}>
          {given.map((c) => (
            <Notice key={c.credentialId} tone={filled(c, answers.secrets) ? 'ok' : 'idle'}>
              {c.system}
              {filled(c, answers.secrets) ? ', tested' : ', from the connection'}
            </Notice>
          ))}
        </div>
      ) : (
        'None yet'
      ),
    ]);
  if (answered.length)
    rows.push([
      'Brief',
      <div key="b" className={s.lines}>
        {answered.map((q) => (
          <span key={q.key}>
            {q.label} <b>{answerWord(brief[q.key]!.trim())}</b>
          </span>
        ))}
      </div>,
    ]);
  if (pb.intake.source.repo !== 'none' && f.repo)
    rows.push([
      'Repository access',
      passed(checks, GITHUB_CHECK) ? (
        <Notice tone="ok">GitHub App, tested</Notice>
      ) : (
        <Notice tone="waiting">
          Not confirmed yet. Creating the project checks it again and records the outcome; re-check
          it in Settings once the client installs the app.
        </Notice>
      ),
    ]);
  return (
    <>
      <Lead>
        Everything below is checked again when you create the project. Secrets are sealed and never
        shown again.
      </Lead>
      <Facts rows={rows} />
      <p className={`${s.quiet} type-meta`}>
        The project is created ready to start. Nothing runs until you press Start on Mission
        Control.
      </p>
    </>
  );
}
