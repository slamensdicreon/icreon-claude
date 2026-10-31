import type { KnowledgeEntry } from '@lw/contracts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pitfallSeeds, type EventStore, type KnowledgeStore, type Projections } from '@lw/events';
import type { PlannedTask } from '@lw/plan';
import type { PlatformPack } from '@lw/platforms';
import type { Playbook } from '@lw/playbook-sdk';

/** About 1,500 tokens of lessons: a few that fit, not everything known. */
const BUDGET = 6_000;
const MOST = 6;

const line = (e: KnowledgeEntry) =>
  `- [${e.ref}] ${e.title}: ${e.text}${e.kind === 'procedure' ? ' (a procedure that worked)' : ''}`;

/**
 * The lessons a task's brief carries: the active entries that apply where it runs (its platform,
 * playbook, role, project, template and operations), best first, within a budget. Which ones it
 * got is recorded on the project's log, so how each entry does can be counted.
 */
export async function lessonsFor(
  deps: {
    knowledge: KnowledgeStore;
    projections: Projections;
    store: EventStore;
    playbook: Playbook;
  },
  projectId: string,
  task: PlannedTask,
): Promise<string | null> {
  await deps.projections.catchUp(projectId);
  const s = deps.projections.get(projectId);
  const role = deps.playbook.roles.find((r) => r.role === task.role);
  if (!s || !role) return null;
  const found = await deps.knowledge.retrieve(
    {
      projectId,
      playbookId: s.playbook?.id ?? deps.playbook.manifest.id,
      platform: s.intake?.platform ?? null,
      role: task.role,
      operations: Object.entries(role.tools).flatMap(([server, g]) =>
        g.ops.map((op) => `${server}.${op}`),
      ),
      templateId: task.templateId,
      text: [task.title, task.templateId, ...task.itemKeys].join(' '),
      docs: role.knowledge,
    },
    MOST * 2,
  );
  const picked: KnowledgeEntry[] = [];
  let size = 0;
  for (const e of found) {
    const n = line(e).length;
    if (picked.length >= MOST || size + n > BUDGET) continue;
    picked.push(e);
    size += n;
  }
  if (!picked.length) return null;
  await deps.store.append(projectId, [
    {
      type: 'knowledge.used',
      actor: { kind: 'system', id: 'knowledge' },
      subject: { kind: 'task', id: task.taskId },
      severity: 'routine',
      data: {
        taskId: task.taskId,
        entries: picked.map((e) => e.id),
        refs: picked.map((e) => e.ref),
      },
    },
  ]);
  await deps.knowledge.used(
    picked.map((e) => e.id),
    { projectId, taskId: task.taskId },
  );
  return [
    "Lessons from earlier work (the team's knowledge; apply them where they fit, and if your evidence says otherwise, trust the evidence and say so in your result):",
    ...picked.map(line),
  ].join('\n');
}

/**
 * Seeds the knowledge store from each platform's known-pitfalls table: rows not there yet are
 * added as active lessons. Safe to run on every start.
 */
export async function seedPlatformKnowledge(
  knowledge: KnowledgeStore,
  packs: Pick<PlatformPack, 'id' | 'knowledgeDir'>[],
): Promise<number> {
  let added = 0;
  for (const pack of packs) {
    const md = await readFile(join(pack.knowledgeDir, 'known-pitfalls.md'), 'utf8').catch(
      () => null,
    );
    if (md) added += await knowledge.seed(pitfallSeeds(pack.id, md));
  }
  return added;
}
