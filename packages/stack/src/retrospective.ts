import type { RetroInput, Retro } from '@lw/agent-runtime';
import type { KnowledgeEntry } from '@lw/contracts';
import { retroEvidence } from '@lw/domain';
import type { EventStore, KnowledgeStore, Projections } from '@lw/events';
import type { Playbook } from '@lw/playbook-sdk';

export interface RetrospectiveDeps {
  projections: Projections;
  store: EventStore;
  knowledge: KnowledgeStore;
  /** The playbook a project runs on, for its roles and the Chief of Staff's model. */
  playbookOf(id: string | undefined): Playbook;
  retrospect(input: RetroInput): Promise<Retro & { tokens: number }>;
}

export interface RetrospectiveResult {
  phase: number;
  summary: string;
  /** New proposals; ones already proposed for this phase aren't added again. */
  proposed: KnowledgeEntry[];
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

/**
 * A phase's retrospective: what it cost, grouped by cause by Cypher into proposed lessons,
 * procedures and gaps with their evidence. Proposals reach no brief until the Director approves
 * them; running it again adds only what is new.
 */
export async function runRetrospective(
  deps: RetrospectiveDeps,
  projectId: string,
  phase: number,
): Promise<RetrospectiveResult> {
  await deps.projections.catchUp(projectId);
  const s = deps.projections.get(projectId);
  if (!s) throw new Error(`No project "${projectId}".`);
  const evidence = retroEvidence(s, await deps.store.read(projectId), phase);
  if (!evidence.items.length && !evidence.procedures.length)
    return {
      phase,
      summary: 'Nothing in this phase cost a card, a rejection or a wait.',
      proposed: [],
    };
  const playbook = deps.playbookOf(s.playbook?.id);
  const platform = s.intake?.platform ?? null;
  const known = (await deps.knowledge.list()).filter((e) => e.status !== 'retired');
  const cos = playbook.roles.find((r) => r.role === 'chief-of-staff');
  const retro = await deps.retrospect({
    project: s.name,
    platform,
    phase: { number: phase, name: evidence.name, tasks: evidence.tasks },
    roles: playbook.roles.map((r) => ({ id: r.role, name: r.name })),
    items: evidence.items,
    procedures: evidence.procedures,
    known: known.slice(0, 120).map((e) => `${e.ref} ${e.title}`),
    model: cos?.model.id,
  });
  const labels = new Map([
    ...evidence.items.map((i) => [i.ref, i.title] as const),
    ...evidence.procedures.map((p) => [p.ref, p.title] as const),
  ]);
  const proposed: KnowledgeEntry[] = [];
  for (const p of retro.proposals) {
    const scope =
      p.scope === 'platform' && platform
        ? { kind: 'platform' as const, id: platform }
        : p.scope === 'role' && p.roles.length === 1
          ? { kind: 'role' as const, id: p.roles[0]! }
          : p.scope === 'project'
            ? { kind: 'project' as const, id: projectId }
            : { kind: 'playbook' as const, id: s.playbook?.id ?? playbook.manifest.id };
    const created = await deps.knowledge.create({
      kind: p.kind,
      status: 'proposed',
      scope,
      title: p.title,
      text: `${p.text}${p.cost ? ` (Phase ${phase} cost: ${p.cost}.)` : ''}`,
      roles: p.roles,
      operations: p.operations,
      tags: p.tags,
      evidence: p.evidence.map((ref) => ({
        projectId,
        ref,
        label: labels.get(ref) ?? ref,
      })),
      author: 'cypher',
      source: { doc: null, projectId, phase },
      sourceKey: `${projectId}:phase-${phase}:${slug(p.title)}`,
    });
    if (created) proposed.push(created);
  }
  return { phase, summary: retro.summary, proposed };
}

/**
 * Runs each live project's retrospective when one of its phases ends. Proposals wait for the
 * Director on the project's Lessons learned page. Returns the unsubscribe.
 */
export function retrospectAtPhaseExit(
  deps: RetrospectiveDeps,
  log: (message: string, err?: unknown) => void = console.log,
): () => void {
  return deps.store.subscribe((e) => {
    if (e.type !== 'phase.exited') return;
    const s = deps.projections.get(e.projectId);
    if (s && (s.mode !== 'live' || !s.intake)) return;
    void runRetrospective(deps, e.projectId, e.data.phase)
      .then((r) =>
        log(
          `Retrospective of ${e.projectId} phase ${r.phase}: ${r.proposed.length} proposal(s). ${r.summary}`,
        ),
      )
      .catch((err: unknown) =>
        log(`Retrospective of ${e.projectId} phase ${e.data.phase} failed`, err),
      );
  });
}
