/*
 * The New project wizard's logic, apart from its view: what the form holds, which steps a playbook
 * makes, whether each step is complete, and the request bodies sent to the Control API. Nothing
 * here renders; the page and its steps read these functions.
 */
import type {
  BriefQuestion,
  IntakeCredentialSpec,
  IntakeFieldSpec,
  PlaybookSummary,
  ProjectDraft,
  ProjectIntakeInput,
  RemixDraft,
  VerifyIntakeCredential,
  VerifyIntakeResult,
} from '@lw/contracts';
import { briefApplies, SOURCE_REPO } from '@lw/contracts/labels';
import type { NewProjectIntent } from '../../state';
import { isRepo, isSiteUrl, matchesField, positive, slug } from './validate';

/** A live access test: not run, running, or its answer. */
export type Check =
  { state: 'idle' } | { state: 'busy' } | ({ state: 'done' } & VerifyIntakeResult);
export type Checks = Record<string, Check>;

/** The check id for GitHub access to the source repository. */
export const GITHUB_CHECK = 'github';

/** The project's own values, as typed (numbers stay strings until the body is built). */
export interface BaseFields {
  name: string;
  client: string;
  timezone: string;
  usd: string;
  tokensM: string;
  hours: string;
  repo: string;
  branch: string;
  sourceUrl: string;
}

/** Everything the Director has typed, beyond the two catalog choices. */
export interface Answers {
  f: BaseFields;
  /** Target values by field key; lists stay comma-separated text. */
  target: Record<string, string>;
  /** Credential fields by credential id, then field key. */
  secrets: Record<string, Record<string, string>>;
  brief: Record<string, string>;
}

export type Draft = RemixDraft | ProjectDraft;
type Source = PlaybookSummary['intake']['source'];
type IntakeStep = PlaybookSummary['intake']['steps'][number];

export const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Australia/Sydney',
];

/** The time zones offered: the current one first, then the usual eight. */
export const zonesWith = (current: string) => [...new Set([current, ...ZONES])];

/* ---------- starting values ---------- */

const drafted = (d: Draft | undefined): ProjectDraft | null => (d && 'name' in d ? d : null);

/** The form's first values: a remix or Cypher's draft where there is one, else the defaults. */
export function initialAnswers(draft: Draft | undefined): Answers {
  const d = drafted(draft);
  return {
    f: {
      name: d?.name ?? '',
      client: draft?.client ?? '',
      timezone:
        draft?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'),
      usd: draft ? String(draft.budgets.usd) : '1200',
      tokensM: draft ? String(draft.budgets.tokens / 1_000_000) : '8',
      hours: draft ? String(draft.budgets.hours) : '240',
      repo: d?.repo ?? '',
      branch: d?.branch ?? 'main',
      sourceUrl: d?.sourceUrl ?? '',
    },
    target: Object.fromEntries(
      Object.entries(draft?.target ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]),
    ),
    secrets: {},
    brief: draft?.brief ?? {},
  };
}

/** Credentials the draft's connection provides: not asked for unless typed over. */
export const providedBy = (draft: Draft | undefined): Set<string> =>
  new Set(draft?.connectionId ? draft.providedCredentials : []);

/** The page's heading: a remix names its project; a draft says Cypher drafted it. */
export function wizardTitle(draft: Draft | undefined): string {
  if (draft?.from) return `New project like ${draft.from.name}`;
  return draft ? 'New project drafted by Cypher' : 'New project';
}

/* ---------- what the playbook asks ---------- */

/** Whether the playbook takes a source repository or live site at all. */
export const hasSource = (pb: PlaybookSummary | null) =>
  Boolean(pb && (pb.intake.source.repo !== 'none' || pb.intake.source.url !== 'none'));

/** The brief questions this project is asked: the source-code one only with a repository. */
export const questionsFor = (pb: PlaybookSummary | null, repo: string): BriefQuestion[] =>
  (pb?.intake.brief ?? []).filter((q) => briefApplies(q, repo.trim() ? [SOURCE_REPO] : []));

export const credentialsOf = (pb: PlaybookSummary | null): IntakeCredentialSpec[] =>
  (pb?.intake.steps ?? []).flatMap((s) => s.credentials);

export const fieldsOf = (pb: PlaybookSummary | null): IntakeFieldSpec[] =>
  (pb?.intake.steps ?? []).flatMap((s) => s.fields);

/** The value a target field is sent with: typed, else derived from the name, else its default. */
export const fieldValue = (fs: IntakeFieldSpec, a: Pick<Answers, 'target' | 'f'>) =>
  (a.target[fs.key] ?? '').trim() ||
  (fs.defaultFrom === 'name' ? slug(a.f.name) : '') ||
  fs.defaultValue ||
  '';

/** What a field shows when empty: the value it would take. */
export const fieldPlaceholder = (fs: IntakeFieldSpec, name: string) =>
  (fs.defaultFrom === 'name' ? slug(name) : '') || fs.defaultValue || fs.placeholder || '';

export function fieldOk(fs: IntakeFieldSpec, a: Pick<Answers, 'target' | 'f'>): boolean {
  const v = fieldValue(fs, a);
  if (!v) return !fs.required;
  return matchesField(v, fs);
}

/** A typed field that fails its check (an empty one isn't marked until Next). */
export const fieldBad = (fs: IntakeFieldSpec, a: Pick<Answers, 'target' | 'f'>) =>
  Boolean(a.target[fs.key]?.trim()) && !fieldOk(fs, a);

/** The target values as the API takes them: lists split, empty values left out. */
export function targetValues(
  pb: PlaybookSummary | null,
  a: Pick<Answers, 'target' | 'f'>,
): Record<string, string | string[]> {
  return Object.fromEntries(
    fieldsOf(pb)
      .map((fs) => {
        const v = fieldValue(fs, a);
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
}

/* ---------- credentials and checks ---------- */

const secretOf = (c: IntakeCredentialSpec, secrets: Answers['secrets']) =>
  Object.fromEntries(
    c.fields.map((fl) => [fl.key, (secrets[c.credentialId]?.[fl.key] ?? '').trim()]),
  );

export const filled = (c: IntakeCredentialSpec, secrets: Answers['secrets']) =>
  c.fields.every((fl) => (secrets[c.credentialId]?.[fl.key] ?? '').trim());
export const touched = (c: IntakeCredentialSpec, secrets: Answers['secrets']) =>
  c.fields.some((fl) => (secrets[c.credentialId]?.[fl.key] ?? '').trim());
export const passed = (checks: Checks, key: string) => {
  const c = checks[key];
  return c?.state === 'done' && c.ok;
};

/** A credential the connection provides and the Director hasn't typed over. */
export const fromConnection = (
  c: IntakeCredentialSpec,
  provided: Set<string>,
  secrets: Answers['secrets'],
) => provided.has(c.credentialId) && !touched(c, secrets);

/** Whether a credential's test can run: every field typed and every target value it uses. */
export const testable = (c: IntakeCredentialSpec, a: Answers) =>
  filled(c, a.secrets) && c.uses.every((u) => (a.target[u] ?? '').trim());

/** The test button's word: the one field's name, or "connection" for a pair. */
export const testLabel = (c: IntakeCredentialSpec) =>
  c.fields.length > 1 ? 'connection' : (c.fields[0]?.label ?? 'credential');

export const credentialCheck = (
  pb: PlaybookSummary,
  c: IntakeCredentialSpec,
  a: Answers,
): VerifyIntakeCredential => ({
  kind: 'credential',
  playbookId: pb.id,
  credentialId: c.credentialId,
  secret: secretOf(c, a.secrets),
  target: targetValues(pb, a),
});

export const repoCheck = (f: BaseFields): VerifyIntakeCredential => ({
  kind: 'github.repo',
  repo: f.repo.trim(),
  branch: f.branch.trim(),
});

export const repoTestable = (f: BaseFields) => isRepo(f.repo) && Boolean(f.branch.trim());

/**
 * The checks a change makes stale, so a green tick always means the values on screen: the
 * repository and branch reset GitHub access; a target field resets every credential that uses it.
 */
export function staleChecks(
  change: { base: keyof BaseFields } | { field: string } | { credential: string },
  credentials: IntakeCredentialSpec[],
): string[] {
  if ('base' in change)
    return change.base === 'repo' || change.base === 'branch' ? [GITHUB_CHECK] : [];
  if ('credential' in change) return [change.credential];
  return credentials.filter((c) => c.uses.includes(change.field)).map((c) => c.credentialId);
}

/** A failed request, as a failed check. */
export const failedCheck = (detail: string): Check => ({
  state: 'done',
  ok: false,
  detail,
  sites: [],
  expiresAt: null,
});

/* ---------- is each step complete ---------- */

export const projectValid = (f: BaseFields) =>
  Boolean(f.name.trim() && f.client.trim()) &&
  positive(f.usd) &&
  positive(f.tokensM) &&
  positive(f.hours);

/** The live site is fine when typed and valid, or empty where it isn't required. */
export const sourceUrlOk = (source: Source | undefined, f: BaseFields) =>
  f.sourceUrl.trim() ? isSiteUrl(f.sourceUrl) : source?.url !== 'required';

export function sourceValid(source: Source, f: BaseFields): boolean {
  const repo = f.repo.trim();
  const repoPart =
    source.repo === 'none' ||
    (isRepo(repo) && Boolean(f.branch.trim())) ||
    (source.repo === 'optional' && !repo);
  // Without a repository the live site is the source: one of the two is needed.
  const either =
    source.repo === 'none' || source.url === 'none' || Boolean(repo || f.sourceUrl.trim());
  return repoPart && sourceUrlOk(source, f) && either;
}

export function intakeStepValid(
  step: IntakeStep,
  a: Answers,
  checks: Checks,
  provided: Set<string>,
): boolean {
  return (
    step.fields.every((fs) => fieldOk(fs, a)) &&
    step.credentials.every((c) =>
      fromConnection(c, provided, a.secrets)
        ? true
        : c.required
          ? filled(c, a.secrets) && passed(checks, c.credentialId)
          : !touched(c, a.secrets) || passed(checks, c.credentialId),
    )
  );
}

export const briefValid = (questions: BriefQuestion[], brief: Record<string, string>) =>
  questions.every((q) => !q.required || brief[q.key]?.trim());

/* ---------- the request ---------- */

/** POST /projects: what the wizard creates the project with. */
export function intakeBody(
  pb: PlaybookSummary,
  a: Answers,
  ctx: { draft: Draft | undefined; origin: NewProjectIntent['origin'] },
): ProjectIntakeInput {
  const { f } = a;
  const questions = questionsFor(pb, f.repo);
  return {
    playbookId: pb.id,
    name: f.name.trim(),
    client: f.client.trim(),
    timezone: f.timezone,
    budgets: { usd: +f.usd, tokens: Math.round(+f.tokensM * 1_000_000), hours: +f.hours },
    source: {
      repo: f.repo.trim() || null,
      branch: f.branch.trim() || 'main',
      url: f.sourceUrl.trim() || null,
    },
    target: targetValues(pb, a),
    credentials: Object.fromEntries(
      credentialsOf(pb)
        .filter((c) => filled(c, a.secrets))
        .map((c) => [c.credentialId, secretOf(c, a.secrets)]),
    ),
    brief: Object.fromEntries(
      Object.entries(a.brief)
        .filter(([k]) => questions.some((q) => q.key === k))
        .map(([k, v]) => [k, v.trim()])
        .filter(([, v]) => v),
    ),
    connectionId: ctx.draft?.connectionId ?? null,
    // A remix keeps the release steps its project approved once.
    standingApprovals: ctx.draft?.standingApprovals ?? [],
    origin: ctx.origin ?? null,
  };
}

/* ---------- what the summary and review say ---------- */

export const budgetLine = (f: BaseFields) => `$${f.usd} · ${f.tokensM}M tokens · ${f.hours} h`;

export const sourceLine = (f: BaseFields) =>
  [f.repo.trim() && `${f.repo.trim()} (${f.branch.trim() || 'main'})`, f.sourceUrl.trim()]
    .filter(Boolean)
    .join(', ');

/** How many credentials are verified and how many come from the connection. */
export function credentialCounts(
  credentials: IntakeCredentialSpec[],
  checks: Checks,
  provided: Set<string>,
  secrets: Answers['secrets'],
) {
  return {
    total: credentials.length,
    verified: credentials.filter((c) => passed(checks, c.credentialId)).length,
    fromConnection: credentials.filter((c) => fromConnection(c, provided, secrets)).length,
  };
}
