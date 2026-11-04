import type { TriageInput } from '@lw/agent-runtime';
import { DECISION_CATEGORY_LABEL, type DecisionCategory } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';
import type { KnowledgeStore, RuleStore } from '@lw/events';
import type { Playbook } from '@lw/playbook-sdk';
import type { ArtifactLibrary } from '@lw/tool-workspace';
import { relevantDecisions, relevantLessons } from './triage-context';

export interface LeadTriageDeps {
  playbook: Playbook;
  library: ArtifactLibrary;
  rules?: RuleStore | null;
  knowledge?: KnowledgeStore | null;
}

/** An agent's question as triage receives it. */
export interface LeadTriageRequest {
  projectId: string;
  taskId: string;
  role: string;
  category: DecisionCategory;
  card: {
    title: string;
    context: string;
    impact: string;
    options: { id: string; label: string; recommended: boolean }[];
  };
  previous: string[];
}

/**
 * Only what was known when the card was raised: the project's decisions before it, and rules and
 * lessons made before it or learned on other projects. A replay shows the Lead nothing the card
 * itself taught.
 */
export interface KnownAt {
  at: string;
}

/** The approved Blueprint's entries for a task's items, as JSON for its brief (capped). */
export async function blueprintEntries(
  library: ArtifactLibrary,
  projectId: string,
  task: { collection: string | null; itemKeys: string[] },
) {
  if (!task.collection || !task.itemKeys.length) return null;
  const doc = await library.read(projectId, 'blueprint');
  if (!doc) return null;
  try {
    const bp = JSON.parse(doc.content) as {
      collections?: Record<string, { key: string }[]>;
    };
    const wanted = new Set(task.itemKeys);
    const entries = (bp.collections?.[task.collection] ?? []).filter((i) => wanted.has(i.key));
    if (!entries.length) return null;
    const text = JSON.stringify(entries, null, 1);
    return text.length > 12_000
      ? `${text.slice(0, 12_000)}\n… (cut; read the rest from the Blueprint)`
      : text;
  } catch {
    return null;
  }
}

/**
 * What the Lead over a role sees of a question: the task, its Blueprint entry, the specialist's
 * permissions, the rules that cover it, the project's decisions that bear on it and the team's
 * lessons. One builder for live triage and for replays, so a replay asks what live triage asks.
 * Null when the role has no Lead (nor a Chief of Staff) to ask.
 */
export async function leadTriageInput(
  deps: LeadTriageDeps,
  s: ProjectState,
  req: LeadTriageRequest,
  known?: KnownAt,
): Promise<{
  input: TriageInput;
  lead: { role: string; name: string };
  byRef: Map<string, string>;
} | null> {
  const { playbook } = deps;
  const roles = new Map(playbook.roles.map((r) => [r.role, r]));
  const role = roles.get(req.role);
  const lead = (role?.reportsTo && roles.get(role.reportsTo)) || roles.get('chief-of-staff');
  if (!lead) return null;
  const task = s.tasks[req.taskId];
  const template = playbook.plan.templates.find((t) => t.id === task?.group);
  const before = (iso: string) => !known || iso < known.at;
  // From this project, only what existed before the card; from others, what the team knows now.
  const learnedFairly = (createdAt: string, projectIds: (string | null | undefined)[]) =>
    before(createdAt) || (projectIds.length > 0 && projectIds.every((p) => p && p !== s.projectId));
  const covering = (
    (await deps.rules
      ?.matching({
        projectId: req.projectId,
        playbookId: s.playbook?.id ?? playbook.manifest.id,
        platform: s.intake?.platform ?? null,
        category: req.category,
        role: req.role,
      })
      .catch(() => [])) ?? []
  ).filter((r) =>
    learnedFairly(
      r.createdAt,
      r.sources.map((x) => x.projectId),
    ),
  );
  const decisionsKnown = known ? s.decisions.filter((d) => before(d.ts)) : s.decisions;
  const input: TriageInput = {
    lead: {
      name: lead.persona ? `${lead.persona}, ${lead.name}` : lead.name,
      mandate: lead.mandate,
      model: lead.model.id,
      effort: 'low',
    },
    specialist: role?.name ?? req.role,
    category: DECISION_CATEGORY_LABEL[req.category],
    charter: playbook.manifest.charter,
    task: { title: task?.title ?? req.taskId, acceptance: role?.acceptance ?? [] },
    blueprint: await blueprintEntries(deps.library, req.projectId, {
      collection: template?.forEach ?? null,
      itemKeys: task?.itemKeys ?? [],
    }),
    card: req.card,
    permissions: Object.entries(role?.tools ?? {}).map(
      ([server, grant]) =>
        `${server}: ${grant.ops.join(', ')}${grant.scope?.paths?.length ? ` (writes only under ${grant.scope.paths.join(', ')})` : ''}`,
    ),
    previous: req.previous,
    rules: covering.map((x) => ({ id: x.ref, when: x.when, then: x.then })),
    decisions: relevantDecisions(
      { tasks: s.tasks, decisions: decisionsKnown },
      req.taskId,
      req.card,
    ),
    lessons: deps.knowledge
      ? await relevantLessons(
          deps.knowledge,
          {
            projectId: req.projectId,
            playbookId: s.playbook?.id ?? playbook.manifest.id,
            platform: s.intake?.platform ?? null,
            role: req.role,
            operations: Object.entries(role?.tools ?? {}).flatMap(([server, g]) =>
              g.ops.map((op) => `${server}.${op}`),
            ),
          },
          req.card,
          6,
          known
            ? (e) =>
                e.author === 'seed' ||
                learnedFairly(e.createdAt, e.source?.projectId ? [e.source.projectId] : [])
            : undefined,
        )
      : [],
  };
  return {
    input,
    lead: { role: lead.role, name: lead.persona ?? lead.name },
    byRef: new Map(covering.map((r) => [r.ref, r.id])),
  };
}
