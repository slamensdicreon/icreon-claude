import type {
  ApplyProposals,
  InForceSnapshot,
  KnowledgeEntry,
  PlaybookSummary,
  ProposalRecommendation,
  RuleView,
} from '@lw/contracts';
import type { KnowledgeStore, RuleStore } from '@lw/events';

/**
 * Can this entry reach an agent on the playbook? The same scope test a brief applies (see
 * `knowledgeCovers` and the store's retrieve), without the per-task relevance ranking: which ones
 * a brief carries also depends on the task. Project-scoped entries never reach a new project.
 */
function reach(e: KnowledgeEntry, pb: PlaybookSummary): string[] | null {
  const roles = pb.roles.map((r) => r.role);
  const s = e.scope;
  const scoped =
    s.kind === 'global' ||
    (s.kind === 'platform' && s.id === pb.platform.id) ||
    (s.kind === 'playbook' && s.id === pb.id) ||
    (s.kind === 'role' && roles.includes(s.id));
  if (!scoped) return null;
  const allowed = s.kind === 'role' ? [s.id] : roles;
  const named = e.roles.length ? e.roles.filter((r) => allowed.includes(r)) : allowed;
  if (!named.length) return null;
  // Every one of the playbook's roles: say "every role" rather than listing them.
  return named.length === roles.length ? [] : named;
}

/** Does a rule apply to the playbook's projects? Project rules belong to one project. */
const ruleReaches = (r: RuleView, pb: PlaybookSummary) =>
  (r.scope.kind === 'playbook' && r.scope.id === pb.id) ||
  (r.scope.kind === 'platform' && r.scope.id === pb.platform.id);

/** What a new project on the playbook starts with, from what's active and what's waiting. */
export function inForce(
  pb: PlaybookSummary,
  knowledge: KnowledgeEntry[],
  rules: RuleView[],
): InForceSnapshot {
  const active = knowledge.filter((e) => e.status === 'active');
  const entries = active
    .filter((e) => e.kind !== 'gap')
    .map((e) => ({ e, roles: reach(e, pb) }))
    .filter((x): x is { e: KnowledgeEntry; roles: string[] } => x.roles !== null)
    .sort((a, b) => b.e.used - a.e.used || a.e.ref.localeCompare(b.e.ref))
    .map(({ e, roles }) => ({
      id: e.id,
      ref: e.ref,
      kind: e.kind as 'lesson' | 'procedure',
      title: e.title,
      text: e.text,
      scope: e.scope,
      roles,
      used: e.used,
      updatedAt: e.updatedAt,
    }));
  const gaps = active
    .filter((e) => e.kind === 'gap' && reach(e, pb) !== null)
    .map((e) => ({ id: e.id, ref: e.ref, title: e.title, text: e.text }));
  return {
    playbook: { id: pb.id, name: pb.name, version: pb.version },
    platform: { id: pb.platform.id, name: pb.platform.name },
    roles: pb.roles.map((r) => ({ role: r.role, name: r.name })),
    rules: rules
      .filter((r) => r.status === 'active' && ruleReaches(r, pb))
      .sort((a, b) => b.applied - a.applied),
    entries,
    gaps,
    pending: {
      knowledge: knowledge.filter((e) => e.status === 'proposed' && reach(e, pb) !== null).length,
      rules: rules.filter((r) => r.status === 'proposed' && ruleReaches(r, pb)).length,
    },
  };
}

/** The waiting proposals as the review lists them, before any recommendation. */
export function unsorted(knowledge: KnowledgeEntry[], rules: RuleView[]): ProposalRecommendation[] {
  return [
    ...knowledge
      .filter((e) => e.status === 'proposed')
      .map((e) => ({
        kind: 'knowledge' as const,
        id: e.id,
        ref: e.ref,
        label: e.title,
        action: 'approve' as const,
        reason: '',
        edit: null,
        duplicateOf: null,
      })),
    ...rules
      .filter((r) => r.status === 'proposed')
      .map((r) => ({
        kind: 'rule' as const,
        id: r.id,
        ref: r.ref,
        label: `When ${r.when}`,
        action: 'approve' as const,
        reason: '',
        edit: null,
        duplicateOf: null,
      })),
  ];
}

export interface Applied {
  approved: number;
  edited: number;
  rejected: number;
  failed: { id: string; error: string }[];
}

const SCOPES = {
  knowledge: ['global', 'platform', 'playbook', 'role', 'project'],
  rule: ['project', 'playbook', 'platform'],
} as const;

/**
 * The Director's decisions on waiting proposals: approve, edit then approve, or reject. Each one
 * stands on its own, so one that fails (gone, or no longer proposed) doesn't stop the rest.
 */
export async function applyProposals(
  stores: { knowledge?: KnowledgeStore; rules?: RuleStore },
  { decisions }: ApplyProposals,
): Promise<Applied> {
  const out: Applied = { approved: 0, edited: 0, rejected: 0, failed: [] };
  const proposed = {
    knowledge: new Set(
      ((await stores.knowledge?.list({ status: 'proposed' })) ?? []).map((e) => e.id),
    ),
    rule: new Set(((await stores.rules?.list({ status: 'proposed' })) ?? []).map((r) => r.id)),
  };
  for (const d of decisions) {
    try {
      if (!proposed[d.kind].has(d.id)) throw new Error('not a waiting proposal');
      const scope =
        d.edit?.scope && (SCOPES[d.kind] as readonly string[]).includes(d.edit.scope.kind)
          ? d.edit.scope
          : undefined;
      if (d.edit?.scope && !scope)
        throw new Error(`a ${d.kind} can't have scope ${d.edit.scope.kind}`);
      if (d.kind === 'knowledge') {
        const store = stores.knowledge!;
        if (d.action === 'reject') {
          await store.setStatus(d.id, 'retired');
          out.rejected++;
          continue;
        }
        if (d.action === 'edit' && d.edit) {
          await store.edit(d.id, {
            ...(d.edit.title ? { title: d.edit.title } : {}),
            ...(d.edit.text ? { text: d.edit.text } : {}),
            ...(scope ? { scope: scope as KnowledgeEntry['scope'] } : {}),
            ...(d.edit.roles ? { roles: d.edit.roles } : {}),
          });
          out.edited++;
        } else out.approved++;
        await store.setStatus(d.id, 'active');
      } else {
        const store = stores.rules!;
        if (d.action === 'reject') {
          await store.setStatus(d.id, 'retired');
          out.rejected++;
          continue;
        }
        if (d.action === 'edit' && d.edit) {
          await store.edit(d.id, {
            ...(d.edit.when ? { when: d.edit.when } : {}),
            ...(d.edit.then ? { then: d.edit.then } : {}),
            ...(scope ? { scope: scope as RuleView['scope'] } : {}),
            ...(d.edit.roles ? { roles: d.edit.roles } : {}),
          });
          out.edited++;
        } else out.approved++;
        await store.setStatus(d.id, 'active');
      }
    } catch (err) {
      out.failed.push({ id: d.id, error: (err as Error).message });
    }
  }
  return out;
}
