import type { ReviewInput, ReviewVerdict } from '@lw/agent-runtime';
import type { LwEvent, NewEvent } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';
import type { EventStore, Projections } from '@lw/events';
import type { Activities } from '@lw/orchestrator';
import type { Playbook } from '@lw/playbook-sdk';
import type { ArtifactLibrary } from '@lw/tool-workspace';

/**
 * Acceptance on live projects: a task counts as done only after its automated checks and its
 * Lead's review. A check that doesn't exist yet is "pending", never passed; the Lead judges the
 * result against the steps the specialist actually took, not against its summary.
 */

export interface CheckResult {
  status: 'pass' | 'fail' | 'pending';
  detail: string;
}

export interface CheckContext {
  projectId: string;
  state: ProjectState;
  library: ArtifactLibrary;
  fetch: typeof fetch;
}

export type Check = (ctx: CheckContext) => Promise<CheckResult>;

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const failed = (problems: string[], more = 0): CheckResult => ({
  status: 'fail',
  detail: `${problems.join('; ')}${more ? `; and ${more} more` : ''}.`,
});

async function readJson(ctx: CheckContext, artifactId: string): Promise<unknown> {
  const doc = await ctx.library.read(ctx.projectId, artifactId);
  if (!doc) return null;
  try {
    return JSON.parse(doc.content) as unknown;
  } catch {
    return null;
  }
}

type Item = {
  key: string;
  name: string;
  status?: string;
  pilot?: boolean;
  attrs?: Record<string, unknown>;
};

/** The checks that exist, by validator id. Everything else a plan names is pending. */
export const CHECKS: Record<string, Check> = {
  'credentials.verified': async ({ state }) => {
    const given = Object.values(state.credentials).filter((c) => c.provided);
    const bad = given
      .filter((c) => c.ok !== true)
      .map((c) => `${c.system}: ${c.detail ?? 'not checked'}`);
    return bad.length
      ? failed(bad)
      : pass(`${given.length} credentials verified against their services.`);
  },

  // Gate 1's model contract: every page placed, every component specified, a pilot slice chosen.
  'blueprint.coverage': async (ctx) => {
    const bp = (await readJson(ctx, 'blueprint')) as {
      collections?: Record<string, Item[]>;
    } | null;
    if (!bp?.collections) return failed(['No Blueprint has been written']);
    const inv = (await readJson(ctx, 'page-inventory')) as {
      pages?: { path?: string; url?: string }[];
    } | null;
    const inScope = (c: string) => (bp.collections![c] ?? []).filter((i) => i.status !== 'drop');
    const all = (c: string) => bp.collections![c] ?? [];
    const problems: string[] = [];
    const placed = new Set(
      all('pages').map((p) => String(p.attrs?.path ?? '').replace(/\/$/, '') || '/'),
    );
    for (const p of inv?.pages ?? []) {
      const path = (p.path ?? (p.url ? new URL(p.url).pathname : '')).replace(/\/$/, '') || '/';
      if (!placed.has(path)) problems.push(`page ${path} is neither mapped nor dropped`);
    }
    const templates = new Set(all('templates').map((t) => t.key));
    for (const p of inScope('pages')) {
      const t = p.attrs?.template;
      if (t && !templates.has(String(t)))
        problems.push(`page ${p.key} uses unknown template ${String(t)}`);
    }
    const components = inScope('components');
    if (!components.length) problems.push('no components');
    if (!components.some((c) => c.pilot)) problems.push('no pilot components');
    for (const c of components) {
      const a = c.attrs ?? {};
      if (!Array.isArray(a.fields) || !a.fields.length) problems.push(`${c.key} has no fields`);
      if (!a.rendering) problems.push(`${c.key} has no rendering name`);
      const children = a.children as { max?: unknown } | undefined;
      if (children && typeof children.max !== 'number')
        problems.push(`${c.key}'s child items have no limit`);
      if (!a.queryBudget) problems.push(`${c.key} has no query budget`);
    }
    return problems.length
      ? failed(problems.slice(0, 8), Math.max(0, problems.length - 8))
      : pass(
          `${inScope('pages').length} pages, ${templates.size} templates and ${components.length} components, each with a model contract.`,
        );
  },

  // The head answers, and its editing endpoints exist (they refuse without the secret).
  'editing-host.responds': async ({ state, fetch }) => {
    const url = state.hosting?.url;
    if (!url) return failed(['No production URL is recorded for the head']);
    const get = async (u: string) => {
      try {
        return (await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })).status;
      } catch {
        return 0;
      }
    };
    const home = await get(url);
    const config = await get(`${url.replace(/\/$/, '')}/api/editing/config`);
    const problems = [
      home === 0 || home >= 500 ? `${url} answered ${home || 'nothing'}` : null,
      config === 404 || config === 0 || config >= 500
        ? `/api/editing/config answered ${config || 'nothing'}`
        : null,
    ].filter((x): x is string => Boolean(x));
    return problems.length
      ? failed(problems)
      : pass(`${url} answers ${home}; /api/editing/config answers ${config}.`);
  },
};

export interface ReviewDeps {
  store: EventStore;
  projections: Projections;
  library: ArtifactLibrary;
  playbook: Playbook;
  isLive(projectId: string): Promise<boolean>;
  /** The Lead's review with Claude; without it only the checks decide. */
  review: ((input: ReviewInput) => Promise<ReviewVerdict & { tokens: number }>) | null;
  checks?: Record<string, Check>;
  fetch?: typeof fetch;
  /** Called when a task's result is accepted (its write locks go). */
  onAccepted?: (projectId: string, taskId: string) => Promise<void>;
}

export function withReview(base: Activities, deps: ReviewDeps): Activities {
  const checks = deps.checks ?? CHECKS;
  const roles = new Map(deps.playbook.roles.map((r) => [r.role, r]));
  return {
    ...base,
    async validate(req) {
      if (!(await deps.isLive(req.projectId))) return base.validate(req);
      const { task } = req;
      await deps.projections.catchUp(req.projectId);
      const state = deps.projections.get(req.projectId)!;
      const role = roles.get(task.role);
      const lead = (role?.reportsTo && roles.get(role.reportsTo)) || roles.get('chief-of-staff');
      const reviewerId = lead?.role ?? 'chief-of-staff';
      const ctx: CheckContext = {
        projectId: req.projectId,
        state,
        library: deps.library,
        fetch: deps.fetch ?? ((...a) => fetch(...a)),
      };

      // 1. Automated checks.
      const results: { id: string; status: CheckResult['status']; detail: string }[] = [];
      for (const a of task.acceptance) {
        const id = a.startsWith('validator:') ? a.slice('validator:'.length) : null;
        if (!id) continue;
        const check = checks[id];
        let r: CheckResult;
        try {
          r = check
            ? await check(ctx)
            : { status: 'pending', detail: 'No automated check exists for this yet.' };
        } catch (err) {
          r = { status: 'pending', detail: `The check could not run: ${(err as Error).message}` };
        }
        results.push({ id, ...r });
      }
      const events: NewEvent[] = results.map((r) => ({
        type: 'step.recorded',
        actor: { kind: 'agent', id: reviewerId },
        subject: { kind: 'task', id: task.taskId },
        severity: r.status === 'fail' ? 'warning' : 'routine',
        data: {
          stepId: crypto.randomUUID(),
          agentId: reviewerId,
          taskId: task.taskId,
          toolServer: 'validators',
          operation: r.id,
          resultCode: r.status === 'pass' ? 200 : r.status === 'fail' ? 422 : 202,
          durationMs: 0,
          summary: r.detail,
          outcome: r.status,
        },
      }));
      const fails = results.filter((r) => r.status === 'fail');
      const pending = results.filter((r) => r.status === 'pending').map((r) => r.id);

      // 2. The Lead's review, against the audit trail.
      let verdict: { verdict: 'accept' | 'reject'; reason: string; tokens: number };
      if (fails.length) {
        verdict = {
          verdict: 'reject',
          reason: fails.map((f) => `${f.id}: ${f.detail}`).join(' '),
          tokens: 0,
        };
      } else if (deps.review && lead) {
        const log = await deps.store.read(req.projectId);
        const steps = log
          .filter(
            (e): e is Extract<LwEvent, { type: 'step.recorded' }> =>
              e.type === 'step.recorded' && e.data.taskId === task.taskId,
          )
          .slice(-120)
          .map(
            (e) =>
              `${e.ts.slice(11, 19)} ${e.data.toolServer}.${e.data.operation} → ${e.data.outcome ?? e.data.resultCode}: ${e.data.summary}`,
          );
        const artifacts = log
          .filter(
            (e): e is Extract<LwEvent, { type: 'step.recorded' }> =>
              e.type === 'step.recorded' &&
              e.data.taskId === task.taskId &&
              e.data.toolServer === 'artifacts' &&
              e.data.resultCode < 300,
          )
          .map((e) => e.data.summary);
        try {
          verdict = await deps.review({
            lead: {
              name: lead.name,
              mandate: lead.mandate,
              model: lead.model.id,
              effort: lead.model.effort,
            },
            specialist: role?.name ?? task.role,
            charter: deps.playbook.manifest.charter,
            task: { title: task.title, acceptance: task.acceptance },
            summary: req.result.summary ?? '',
            steps,
            artifacts,
            checks: results,
          });
        } catch (err) {
          // A review that can't run doesn't hold the project up; it says so on the record.
          verdict = {
            verdict: 'accept',
            reason: `Accepted without a Lead review: the review could not run (${(err as Error).message}).`,
            tokens: 0,
          };
        }
      } else {
        verdict = {
          verdict: 'accept',
          reason: 'Checks passed; no Lead review is connected.',
          tokens: 0,
        };
      }
      const note = `${verdict.reason}${pending.length ? ` Pending, not passed: ${pending.join(', ')}.` : ''}`;
      events.push({
        type: 'review.recorded',
        actor: { kind: 'agent', id: reviewerId },
        subject: { kind: 'task', id: task.taskId },
        severity: verdict.verdict === 'reject' ? 'warning' : 'routine',
        data: {
          reviewerId,
          agentId: task.role,
          taskId: task.taskId,
          verdict: verdict.verdict,
          subject: task.title,
          note,
          tokens: verdict.tokens,
        },
      });
      await deps.store.append(req.projectId, events);
      if (verdict.verdict === 'accept') await deps.onAccepted?.(req.projectId, task.taskId);
      return verdict.verdict === 'accept'
        ? { pass: true, reason: null }
        : { pass: false, reason: verdict.reason };
    },
  };
}
