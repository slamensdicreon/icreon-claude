/*
 * Project settings' logic, apart from its view: the credential rows (what the snapshot holds,
 * plus what the playbook declares and nobody has given yet), what each row may do, expiry, budget
 * shares, and the bodies the autonomy and standing-approval settings are saved with.
 */
import type {
  AutonomyLevel,
  IntakeCredentialSpec,
  PlaybookSummary,
  ProjectSummary,
  SettingsSnapshot,
} from '@lw/contracts';
import { briefApplies, SOURCE_REPO } from '@lw/contracts/labels';
import { isRepo, slug } from '../intake/validate';

export type CredentialRow = SettingsSnapshot['credentials'][number];
type Tone = 'ok' | 'waiting' | 'bad' | 'idle';

/* ---------- the playbook ---------- */

export const playbookOf = (list: PlaybookSummary[] | null, p: ProjectSummary) =>
  list?.find((x) => x.id === p.playbook?.id) ?? null;

/** Every credential the playbook takes, given at intake or not. */
export const declaredCredentials = (pb: PlaybookSummary | null): IntakeCredentialSpec[] =>
  pb?.intake.steps.flatMap((st) => st.credentials) ?? [];

/** The brief questions this project answers: the source-code one only with a repository. */
export const briefQuestions = (pb: PlaybookSummary | null, p: ProjectSummary) =>
  (pb?.intake.brief ?? []).filter((q) => briefApplies(q, p.intake?.repo ? [SOURCE_REPO] : []));

/* ---------- credentials ---------- */

/**
 * The table's rows: every credential the snapshot holds, then each one the playbook declares that
 * hasn't been given, so a missing one can be added here.
 */
export function credentialRows(
  held: CredentialRow[],
  declared: IntakeCredentialSpec[],
): CredentialRow[] {
  return [
    ...held,
    ...declared
      .filter((d) => !held.some((c) => c.credentialId === d.credentialId))
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
}

/** Whole days until a credential expires (never below zero), or null when it doesn't. */
export const daysLeft = (expiresAt: string | null, now: number): number | null =>
  expiresAt ? Math.max(0, Math.round((Date.parse(expiresAt) - now) / 86_400_000)) : null;

/** Expiry as a warning: gold within two weeks, coral within three days. */
export const expiryTone = (days: number): Tone =>
  days <= 3 ? 'bad' : days <= 14 ? 'waiting' : 'idle';

/** Where a credential stands, as a tone and words; `stamp` is the verified time in words. */
export function credentialState(
  c: CredentialRow,
  stamp: (iso: string) => string,
): { tone: Tone; text: string } {
  if (!c.provided)
    return { tone: 'bad', text: c.ok === false && c.detail ? c.detail : 'Not provided' };
  if (c.ok === false) return { tone: 'bad', text: `Failed: ${c.detail ?? ''}` };
  if (c.verifiedAt) return { tone: 'ok', text: `Verified ${stamp(c.verifiedAt)}` };
  return { tone: 'idle', text: 'Not yet verified' };
}

/**
 * What a row may do. Re-verify a credential that was given; repository access can be checked
 * before it is given (that is how a fresh installation of the GitHub App is picked up). A demo
 * project's declared credentials can't be added; the check button shows, disabled.
 */
export function credentialActions(
  c: CredentialRow,
  spec: IntakeCredentialSpec | undefined,
  demo: boolean,
) {
  const recheck = c.provided || (c.credentialId === 'github' && !demo);
  return {
    showCheck: recheck || !spec,
    canCheck: recheck,
    checkLabel: c.provided ? 'Re-verify' : 'Check again',
    canEdit: Boolean(spec),
    editLabel: c.provided ? 'Replace' : 'Add',
  };
}

/* ---------- budgets ---------- */

/** A share in whole percent; null when there is no limit to measure against. */
export const share = (used: number, limit: number): number | null =>
  limit > 0 && Number.isFinite(used) ? Math.round((used / limit) * 100) : null;

/** The bar's color by meaning: gold from 80% (new tasks wait), coral at 100% (the project pauses). */
export const budgetHue = (pct: number | null) =>
  pct === null || pct < 80 ? 'var(--ink)' : pct < 100 ? 'var(--gold)' : 'var(--coral-text)';

export interface BudgetLine {
  key: 'usd' | 'tokens' | 'hours';
  label: string;
  used: string;
  limit: string;
  pct: number | null;
}

/** Hours since Start; none before it. */
export const hoursSince = (startedAt: string | null, now: number) =>
  startedAt ? Math.max(0, (now - Date.parse(startedAt)) / 3_600_000) : 0;

export function budgetLines(
  s: Pick<SettingsSnapshot, 'budgets' | 'spent'>,
  hours: number,
  usd: (n: number) => string,
): BudgetLine[] {
  return [
    {
      key: 'usd',
      label: 'Cost',
      used: usd(s.spent.usd),
      limit: `of ${usd(s.budgets.usd)}`,
      pct: share(s.spent.usd, s.budgets.usd),
    },
    {
      key: 'tokens',
      label: 'Tokens',
      used: `${(s.spent.tokens / 1e6).toFixed(1)}M`,
      limit: `of ${(s.budgets.tokens / 1e6).toFixed(0)}M`,
      pct: share(s.spent.tokens, s.budgets.tokens),
    },
    {
      key: 'hours',
      label: 'Time',
      used: `${Math.floor(hours)} h`,
      limit: `of ${s.budgets.hours} h`,
      pct: share(hours, s.budgets.hours),
    },
  ];
}

/** The budget form's values, as typed, and what they send. */
export type BudgetDraft = { usd: string; tokens: string; hours: string };
export const budgetDraft = (b: SettingsSnapshot['budgets']): BudgetDraft => ({
  usd: String(b.usd),
  tokens: String(b.tokens / 1e6),
  hours: String(b.hours),
});
export const budgetBody = (v: BudgetDraft) => ({
  usd: Number(v.usd),
  tokens: Math.round(Number(v.tokens) * 1e6),
  hours: Number(v.hours),
});
export const budgetValid = (v: BudgetDraft) => {
  const b = budgetBody(v);
  return b.usd > 0 && b.tokens > 0 && b.hours > 0;
};

/* ---------- who decides ---------- */

export const AUTONOMY_LEVELS: [AutonomyLevel, string][] = [
  ['ask', 'Always you'],
  ['shadow', 'Shadow'],
  ['lead', 'Lead decides'],
  ['agents', 'Agent decides'],
];
export const levelName = (level: AutonomyLevel) =>
  AUTONOMY_LEVELS.find(([l]) => l === level)?.[1] ?? level;

/** PUT /settings/autonomy: every unlocked category's level, with one changed. */
export function autonomyValue(
  rows: SettingsSnapshot['autonomy'],
  category: string,
  level: AutonomyLevel,
): Record<string, AutonomyLevel> {
  return Object.fromEntries(
    rows
      .filter((x) => !x.locked)
      .map((x) => [x.category, x.category === category ? level : x.level]),
  );
}

/** PUT /settings/standingApprovals: the Director's approved steps, with one toggled. */
export function standingApprovalsValue(
  rows: SettingsSnapshot['standingApprovals'],
  toggled: string,
): string[] {
  return rows
    .filter((x) => !x.byPlaybook && (x.id === toggled ? !x.approved : x.approved))
    .map((x) => x.id);
}

/** A card type's name in the policy table. */
const POLICY_TYPE: Record<string, string> = {
  decision: 'Decision',
  blocker: 'Blocker',
  access: 'Access',
  budget: 'Budget',
  risk: 'Risk',
  gate: 'Gate',
};
export const policyTypeName = (type: string) => POLICY_TYPE[type] ?? type;

/** "20 min", "4 h", or what happens when there is no default. */
export function after(min: number | null, behaviour: string): string {
  if (min === null) return behaviour;
  return min >= 60 && min % 60 === 0 ? `${min / 60} h` : `${min} min`;
}

/* ---------- the build and its host ---------- */

/** The build repository's default name: after the source repository, or the project's name. */
export const suggestedRepoName = (source: string, projectName: string, platformId: string) =>
  `${isRepo(source) ? source.trim().split('/')[1] : slug(projectName)}-${platformId}`;

export interface HostingStep {
  step: string;
  ok: boolean;
  summary: string;
  deploymentId?: string;
}
export interface HostingDeployment {
  deploymentId: string;
  state: string;
  url: string | null;
  editingHost: string | null;
  error: string | null;
}
export const FINISHED = new Set(['READY', 'ERROR', 'CANCELED']);

/** A setup step's line: its summary until a deployment reports, then the deployment's state. */
export function hostingStepLine(s: HostingStep, d: HostingDeployment | undefined) {
  const failed = !s.ok || d?.state === 'ERROR' || d?.state === 'CANCELED';
  const text = d
    ? `${d.state.toLowerCase()}${
        d.editingHost
          ? `, live at ${d.editingHost}`
          : d.state === 'READY' && d.url
            ? `, ${d.url}`
            : ''
      }${d.error ? `: ${d.error}` : ''}`
    : s.summary;
  const tone: Tone = failed ? 'bad' : d && !FINISHED.has(d.state) ? 'waiting' : 'ok';
  return { tone, text };
}

/** The editing host's address, from the hosting project's name. */
export const editingHostOf = (name: string) => (name ? `https://${name}-editing.vercel.app` : null);

/* ---------- intake values ---------- */

export const shownValue = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v.join(', ') : (v ?? '');

/** Target fields some credential's check was made against: fixed once given. */
export const checkedFields = (spec: PlaybookSummary['intake']) =>
  new Set(spec.steps.flatMap((st) => st.credentials.flatMap((c) => c.uses)));

/** The hosting project's name, as intake recorded it. */
export const hostingProjectOf = (p: ProjectSummary) =>
  typeof p.intake?.target.hostingProject === 'string' ? p.intake.target.hostingProject : '';
