import type {
  IntakeCredentialSpec,
  IntakeFieldSpec,
  IntakeSpec,
  PlaybookSummary,
  ProjectTarget,
} from '@lw/contracts';
import type { VerifyConfig, VerifyResult } from '@lw/connectors';
import type { Playbook } from '@lw/playbook-sdk';
import { createSitecoreAI } from '../sitecoreai/pack';

/**
 * Platform packs: what is true of a platform whatever the job. A playbook (build a site, run one,
 * optimize one) names its pack; the pack says which values and credentials exist, how each
 * credential is checked and used, what a project may write, and what agents should know about
 * the platform. The playbook chooses which of them its intake collects.
 */

export type { TargetValues } from './values';
import type { TargetValues } from './values';

export type PlatformField = Omit<IntakeFieldSpec, 'key'>;

export interface PlatformCredential extends Omit<
  IntakeCredentialSpec,
  'credentialId' | 'required'
> {
  /** Checks the credential against the live service. */
  check(secret: Record<string, string>, target: TargetValues): Promise<VerifyResult>;
  /** What it reaches, for Settings. */
  scope(target: TargetValues): string;
  /** The field whose last characters Settings shows. */
  hintField: string;
}

export interface PlatformPack {
  id: string;
  name: string;
  fields: Record<string, PlatformField>;
  credentials: Record<string, PlatformCredential>;
  /** Cleans values before they are recorded (a CM host given as a URL becomes its host). */
  normalize(target: TargetValues): TargetValues;
  /** How a project names its target: subtitle, Mission Control, the intake brief. */
  describe(target: TargetValues): { label: string; target: ProjectTarget };
  /** Scope placeholders for the tool gateway: what this project owns. */
  bindings(target: TargetValues): Record<string, string>;
  /** What every agent is told about the target, including what it may change. */
  context(target: TargetValues): string[];
  /** The project credential a tool server's calls carry, and how it becomes a token. */
  toolCredential(server: string):
    | {
        credentialId: string;
        token(secret: Record<string, string>): Promise<{ token: string; expiresAt: number }>;
      }
    | undefined;
  /** Platform knowledge documents roles can list (`knowledge/<id>.md`). */
  knowledgeDir: string;
  /** Acceptance checks only the platform knows how to run, by validator id. */
  checks?: Record<string, PlatformCheck>;
  /**
   * The environment variables the head needs on its host, resolved from the project's sealed
   * credentials and the platform's own APIs. Absent for platforms with no head.
   */
  headEnv?(
    target: TargetValues,
    which: 'preview' | 'production',
    deps: HeadEnvDeps,
  ): Promise<{ vars: HeadEnvVar[]; missing: string[] }>;
}

/** What a platform check can see and call. Read-only by design: checks never change anything. */
export interface PlatformCheckContext {
  projectId: string;
  target: TargetValues;
  /** The approved Blueprint, parsed, or null. */
  blueprint: {
    collections: Record<
      string,
      {
        key: string;
        name: string;
        status?: string;
        pilot?: boolean;
        attrs?: Record<string, unknown>;
      }[]
    >;
  } | null;
  /** A read operation on one of the platform's tool servers, with the project's credential. */
  read(
    server: string,
    op: string,
    args: Record<string, unknown>,
  ): Promise<{ code: number; body: unknown }>;
  /** A project credential's fields, or null when it wasn't given. */
  credential(credentialId: string): Promise<Record<string, string> | null>;
}

export interface CheckResult {
  status: 'pass' | 'fail' | 'pending';
  detail: string;
}

export type PlatformCheck = (ctx: PlatformCheckContext) => Promise<CheckResult>;

export interface HeadEnvVar {
  key: string;
  value: string;
  /** Server-only secret: stored unreadable on the host. */
  sensitive: boolean;
}

export interface HeadEnvDeps {
  /** A project credential's fields, or null when it wasn't given. */
  credential(credentialId: string): Promise<Record<string, string> | null>;
  /** The platform's editing secret for the project's environment, or null when unavailable. */
  editingSecret(): Promise<string | null>;
}

export interface PlatformConfig {
  sitecore: VerifyConfig;
}

/** Every platform pack, by id. */
export function createPlatforms(cfg: PlatformConfig): Map<string, PlatformPack> {
  return new Map([createSitecoreAI(cfg.sitecore)].map((p) => [p.id, p]));
}

export class IntakeError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join(' '));
  }
}

/** The playbook's intake with the pack's field and credential specs filled in. */
export function intakeSpec(playbook: Playbook, pack: PlatformPack): IntakeSpec {
  const { intake } = playbook.manifest;
  const problems: string[] = [];
  const steps = intake.steps.map((step) => ({
    title: step.title,
    intro: step.intro ?? null,
    fields: step.fields.flatMap((key): IntakeFieldSpec[] => {
      const f = pack.fields[key];
      if (!f) problems.push(`${playbook.manifest.id}: ${pack.id} has no intake field "${key}"`);
      return f ? [{ key, ...f }] : [];
    }),
    credentials: step.credentials.flatMap(({ id, required }): IntakeCredentialSpec[] => {
      const c = pack.credentials[id];
      if (!c) problems.push(`${playbook.manifest.id}: ${pack.id} has no credential "${id}"`);
      return c
        ? [
            {
              credentialId: id,
              system: c.system,
              description: c.description,
              required,
              fields: c.fields,
              uses: c.uses,
            },
          ]
        : [];
    }),
  }));
  if (problems.length) throw new IntakeError(problems);
  return {
    source: {
      repo: intake.source.repo,
      url: intake.source.url,
      intro: intake.source.intro ?? null,
    },
    steps,
    brief: intake.brief,
  };
}

export function playbookSummary(playbook: Playbook, pack: PlatformPack): PlaybookSummary {
  const m = playbook.manifest;
  return {
    id: m.id,
    version: m.version,
    name: m.name,
    description: m.description,
    platform: { id: pack.id, name: pack.name },
    charter: m.charter,
    intake: intakeSpec(playbook, pack),
  };
}

/**
 * Target values as the playbook's intake declares them: only its fields, lists split, required
 * ones present, patterns matched, then normalized by the pack.
 */
export function validateTarget(spec: IntakeSpec, raw: TargetValues): TargetValues {
  const problems: string[] = [];
  const out: TargetValues = {};
  for (const f of spec.steps.flatMap((s) => s.fields)) {
    const v = raw[f.key];
    if (f.kind === 'list') {
      const list = (Array.isArray(v) ? v : String(v ?? '').split(','))
        .map((x) => x.trim())
        .filter(Boolean);
      const value = list.length ? list : f.defaultValue ? f.defaultValue.split(',') : [];
      if (f.required && !value.length) problems.push(`${f.label} is required.`);
      if (value.length) out[f.key] = value;
      continue;
    }
    const value = (Array.isArray(v) ? v.join(',') : (v ?? '')).trim() || f.defaultValue || '';
    if (!value) {
      if (f.required) problems.push(`${f.label} is required.`);
      continue;
    }
    const pattern = f.pattern ?? (f.kind === 'slug' ? '^[a-z0-9][a-z0-9-]{0,99}$' : null);
    if (pattern && !new RegExp(pattern).test(value)) {
      problems.push(
        f.kind === 'slug'
          ? `${f.label}: lowercase letters, digits and dashes.`
          : `${f.label} doesn't look right.`,
      );
    }
    out[f.key] = value;
  }
  if (problems.length) throw new IntakeError(problems);
  return out;
}

export { list, text } from './values';
export {
  ownedPaths,
  sitecoreBindings,
  sitecoreTarget,
  type SitecoreTarget,
} from '../sitecoreai/pack';
