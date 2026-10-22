import type { MetricKey, TaskContract, Workstream } from '@lw/contracts';
import type { Playbook, TaskTemplate } from '@lw/playbook-sdk';
import type { Blueprint, BlueprintItem } from './blueprint';

export interface PlannedTask {
  taskId: string;
  templateId: string;
  phase: number;
  role: string;
  workstream: Workstream | null;
  title: string;
  /**
   * `work`: a real task. `placeholder`: a forEach template before the Blueprint exists.
   * `checkpoint`: no agent work; done when its dependencies are (a Director gate if `gate` is set).
   */
  kind: 'work' | 'placeholder' | 'checkpoint';
  /** Blueprint item keys this task covers (several for a batch, none for a singleton). */
  itemKeys: string[];
  /** Collection the task was expanded from, if any. */
  collection: string | null;
  dependsOn: string[];
  acceptance: string[];
  /** Optional Director gate this checkpoint represents. */
  gate: string | null;
  /** Dispatch hint from the template: ready tasks of the same template per agent session. */
  batchSize: number;
  /** Count metric driven by this task's template, if any. */
  metric: MetricKey | null;
  estimateHours: number | null;
  /** Engagement-view row title. */
  groupTitle: string | null;
  contract: TaskContract | null;
}

export interface Plan {
  playbook: { id: string; version: string };
  blueprintVersion: number | null;
  phases: { number: number; dependsOn: number[] }[];
  /** Phase order, then dependency order within a phase. */
  tasks: PlannedTask[];
}

export interface CompileOptions {
  /** Optional gates the Director switched on in Settings (e.g. `pilot-slice-review`). */
  enabledGates?: string[];
}

export class PlanError extends Error {
  constructor(readonly problems: string[]) {
    super(`Plan does not compile:\n- ${problems.join('\n- ')}`);
  }
}

export const PILOT_CHECKPOINT = 'pilot-checkpoint';
const PLACEHOLDER_KEY = 'all';

/**
 * Compiles a playbook (and, once approved, a Blueprint) into the project's task graph. Pure and
 * deterministic: the same inputs always give the same ids in the same order, which is what lets a
 * re-plan be diffed against the running plan.
 */
export function compilePlan(
  playbook: Playbook,
  blueprint: Blueprint | null,
  options: CompileOptions = {},
): Plan {
  const problems: string[] = [];
  const roles = new Map(playbook.roles.map((r) => [r.role, r]));
  const tasks: PlannedTask[] = [];

  // 1. Expand templates.
  const expanded = new Map<string, { template: TaskTemplate; key: string | null }>();
  for (const template of playbook.plan.templates) {
    const workstream = roles.get(template.role)?.workstream ?? null;
    for (const unit of expand(template, blueprint, problems)) {
      if (expanded.has(unit.taskId)) {
        problems.push(`duplicate task id ${unit.taskId}`);
        continue;
      }
      expanded.set(unit.taskId, { template, key: unit.key });
      tasks.push({
        taskId: unit.taskId,
        templateId: template.id,
        phase: template.phase,
        role: template.role,
        workstream,
        title: unit.title,
        kind: unit.kind,
        itemKeys: unit.itemKeys,
        collection: template.forEach ?? null,
        dependsOn: [],
        acceptance: template.acceptance,
        gate: null,
        batchSize: template.batchSize ?? 1,
        metric: template.metric ?? null,
        estimateHours: template.estimate ?? null,
        groupTitle: template.activity ?? activityTitle(template.title),
        contract: template.contract
          ? {
              inputs: fill(template.contract.inputs, unit.name),
              outputs: fill(template.contract.outputs, unit.name),
              acceptance: fill(
                template.contract.acceptance ?? (template.acceptance.join('. ') || 'Lead review'),
                unit.name,
              ),
              rollback: fill(template.contract.rollback, unit.name),
              maxAttempts: template.contract.maxAttempts,
            }
          : null,
      });
    }
  }

  // 2. Pilot slice checkpoint (only once there is a Blueprint to know the pilot items).
  const pilot = playbook.plan.pilot;
  let pilotKeys = new Set<string>();
  if (pilot && blueprint) {
    pilotKeys = new Set(
      (blueprint.collections[pilot.collection] ?? [])
        .filter((i) => i.pilot && i.status !== 'drop')
        .map((i) => i.key),
    );
    if (pilotKeys.size) {
      const enabled = pilot.optionalGate && options.enabledGates?.includes(pilot.optionalGate);
      tasks.push({
        taskId: PILOT_CHECKPOINT,
        templateId: PILOT_CHECKPOINT,
        phase: pilot.phase,
        role: playbook.roles.find((r) => r.tier === 'chief_of_staff')!.role,
        workstream: null,
        title: enabled ? 'Pilot slice review' : 'Pilot slice complete',
        kind: 'checkpoint',
        itemKeys: [...pilotKeys],
        collection: pilot.collection,
        dependsOn: [],
        acceptance: [],
        gate: enabled ? pilot.optionalGate! : null,
        batchSize: 1,
        metric: null,
        estimateHours: null,
        groupTitle: null,
        contract: null,
      });
    }
  }

  // 3. Resolve dependencies.
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  for (const t of tasks) {
    const source = expanded.get(t.taskId);
    const deps = new Set<string>();
    for (const pattern of source?.template.dependsOn ?? []) {
      const bound = pattern.replaceAll('{key}', source?.key ?? '');
      if (bound.endsWith('*')) {
        const prefix = bound.slice(0, -1);
        for (const other of tasks) {
          if (
            other.taskId !== t.taskId &&
            other.taskId.startsWith(prefix) &&
            other.kind !== 'checkpoint'
          ) {
            deps.add(other.taskId);
          }
        }
      } else if (byId.has(bound)) {
        deps.add(bound);
      } else {
        problems.push(`${t.taskId} depends on unknown task ${bound}`);
      }
    }
    t.dependsOn = [...deps];
  }

  if (pilot && pilotKeys.size) {
    const checkpoint = byId.get(PILOT_CHECKPOINT)!;
    const inPilotPhase = tasks.filter(
      (t) => t.phase === pilot.phase && t.collection === pilot.collection && t.kind === 'work',
    );
    checkpoint.dependsOn = inPilotPhase
      .filter((t) => t.itemKeys.every((k) => pilotKeys.has(k)))
      .map((t) => t.taskId);
    for (const t of inPilotPhase) {
      const key = t.itemKeys[0]!;
      // Non-pilot work waits on the checkpoint. A task that already waits on another task for the
      // same item (register waits on port) inherits the wait through it.
      const waitsOnSameItem = t.dependsOn.some((d) => byId.get(d)?.itemKeys[0] === key);
      if (!pilotKeys.has(key) && !waitsOnSameItem) t.dependsOn.push(PILOT_CHECKPOINT);
    }
  }

  for (const t of tasks) {
    for (const d of t.dependsOn) {
      const dep = byId.get(d)!;
      if (dep.phase > t.phase)
        problems.push(
          `${t.taskId} (phase ${t.phase}) depends on later-phase task ${d} (phase ${dep.phase})`,
        );
    }
  }

  const ordered = problems.length ? tasks : topoSort(tasks, problems);
  if (problems.length) throw new PlanError(problems);

  return {
    playbook: { id: playbook.manifest.id, version: playbook.manifest.version },
    blueprintVersion: blueprint?.version ?? null,
    phases: playbook.manifest.phases.map((p) => ({
      number: p.number,
      dependsOn: p.dependsOn ?? (p.number === 0 ? [] : [p.number - 1]),
    })),
    tasks: ordered,
  };
}

interface Unit {
  taskId: string;
  key: string | null;
  /** The item's name, for `{name}` in contracts; null for singleton templates. */
  name: string | null;
  title: string;
  kind: PlannedTask['kind'];
  itemKeys: string[];
}

function expand(template: TaskTemplate, blueprint: Blueprint | null, problems: string[]): Unit[] {
  if (!template.forEach) {
    return [
      {
        taskId: template.id,
        key: null,
        name: null,
        title: template.title,
        kind: 'work',
        itemKeys: [],
      },
    ];
  }
  if (!blueprint) {
    return [
      {
        taskId: template.id.replace('{key}', PLACEHOLDER_KEY),
        key: PLACEHOLDER_KEY,
        name: `all ${template.forEach}`,
        title: template.title.replace('{name}', `all ${template.forEach}`),
        kind: 'placeholder',
        itemKeys: [],
      },
    ];
  }
  const collection = blueprint.collections[template.forEach];
  if (!collection) {
    problems.push(`${template.id}: Blueprint has no "${template.forEach}" collection`);
    return [];
  }
  return collection
    .filter((i) => i.status !== 'drop')
    .map((i: BlueprintItem) => ({
      taskId: template.id.replace('{key}', i.key),
      key: i.key,
      name: i.name,
      title: template.title.replace('{name}', i.name),
      kind: 'work' as const,
      itemKeys: [i.key],
    }));
}

const fill = (text: string, name: string | null) => text.replaceAll('{name}', name ?? 'the item');

/** "Port {name}" → "Port". Engagement rows name the activity, not one item of it. */
function activityTitle(title: string): string | null {
  if (!title.includes('{name}')) return null;
  return title.replace(/\s*:?\s*\{name\}\s*/, ' ').trim();
}

/** Stable topological sort: phase first, then dependencies, then declaration order. */
function topoSort(tasks: PlannedTask[], problems: string[]): PlannedTask[] {
  const index = new Map(tasks.map((t, i) => [t.taskId, i]));
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const out: PlannedTask[] = [];
  const visit = (t: PlannedTask, path: string[]) => {
    const s = state.get(t.taskId);
    if (s === 'done') return;
    if (s === 'visiting') {
      problems.push(
        `dependency cycle: ${[...path.slice(path.indexOf(t.taskId)), t.taskId].join(' → ')}`,
      );
      return;
    }
    state.set(t.taskId, 'visiting');
    const deps = [...t.dependsOn].sort((a, b) => index.get(a)! - index.get(b)!);
    for (const d of deps) visit(byId.get(d)!, [...path, t.taskId]);
    state.set(t.taskId, 'done');
    out.push(t);
  };
  const roots = [...tasks].sort(
    (a, b) => a.phase - b.phase || index.get(a.taskId)! - index.get(b.taskId)!,
  );
  for (const t of roots) visit(t, []);
  return out;
}
