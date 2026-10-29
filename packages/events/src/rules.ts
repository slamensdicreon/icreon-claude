import { randomUUID } from 'node:crypto';
import type {
  DecisionCategory,
  RuleHistoryItem,
  RuleScope,
  RuleSource,
  RuleView,
} from '@lw/contracts';
import type { SqlClient } from './postgres';

export type RuleStatus = RuleView['status'];

/** What a new rule says. */
export interface RuleInput {
  when: string;
  then: string;
  category: DecisionCategory;
  scope: RuleScope;
  roles?: string[];
  sources?: RuleSource[];
  author: RuleView['author'];
  status: RuleStatus;
}

/** What an edit may change; each edit is a new version. */
export type RulePatch = Partial<Pick<RuleInput, 'when' | 'then' | 'category' | 'scope' | 'roles'>>;

/** Where a question came up, to find the rules that may answer it. */
export interface RuleContext {
  projectId: string;
  playbookId: string | null;
  platform: string | null;
  category: DecisionCategory;
  role: string;
}

/** A rule applied, or the Director overriding it, on one card. */
export interface RuleUse {
  projectId: string;
  escalationId: string;
}

/**
 * Rules from the Director's answers: when this happens, do that. Proposed rules apply nowhere
 * until activated; edits are new versions; every change and use is kept in the rule's history.
 */
export interface RuleStore {
  list(filter?: { status?: RuleStatus }): Promise<RuleView[]>;
  get(id: string): Promise<RuleView | null>;
  create(input: RuleInput): Promise<RuleView>;
  edit(id: string, patch: RulePatch): Promise<RuleView>;
  setStatus(id: string, status: RuleStatus): Promise<RuleView>;
  /** Active rules for a question: its category, a scope that covers the project, its role. */
  matching(ctx: RuleContext): Promise<RuleView[]>;
  applied(id: string, use: RuleUse): Promise<void>;
  overridden(id: string, use: RuleUse): Promise<void>;
  history(id: string): Promise<RuleHistoryItem[]>;
}

/** Rule body kept as JSON beside the indexed columns. */
interface Body {
  when: string;
  then: string;
  roles: string[];
  sources: RuleSource[];
  author: RuleView['author'];
}

interface Row {
  id: string;
  ref: string;
  status: RuleStatus;
  category: DecisionCategory;
  scope_kind: RuleScope['kind'];
  scope_id: string;
  body: Body;
  version: number;
  applied: number;
  overridden: number;
  created_at: string | Date;
  updated_at: string | Date;
}

const iso = (t: string | Date) => new Date(t).toISOString();

function view(r: Row): RuleView {
  return {
    id: r.id,
    ref: r.ref,
    status: r.status,
    category: r.category,
    scope: { kind: r.scope_kind, id: r.scope_id },
    when: r.body.when,
    then: r.body.then,
    roles: r.body.roles,
    sources: r.body.sources,
    author: r.body.author,
    version: r.version,
    applied: r.applied,
    overridden: r.overridden,
    flagged: r.overridden >= 2,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** Does a rule's scope and role list cover this question? */
/**
 * Whether a rule is offered for a question. Its category doesn't limit it: the Director's rule on
 * a scope gap is often met as a retry card (a Lead rejecting the page for that gap), and the Lead
 * judges the rule's own `when`. Rules of the card's category come first.
 */
export function ruleCovers(rule: RuleView, ctx: RuleContext): boolean {
  if (rule.status !== 'active') return false;
  if (rule.roles.length && !rule.roles.includes(ctx.role)) return false;
  const { kind, id } = rule.scope;
  return kind === 'project'
    ? id === ctx.projectId
    : kind === 'playbook'
      ? id === ctx.playbookId
      : id === ctx.platform;
}

const clean = (s: string, max: number) => s.trim().replace(/\s+/g, ' ').slice(0, max);

function check(input: Pick<RuleInput, 'when' | 'then'>) {
  if (!input.when.trim() || !input.then.trim())
    throw new Error('A rule needs both when it applies and what to do.');
}

export class PostgresRuleStore implements RuleStore {
  constructor(private readonly sql: SqlClient) {}

  async list(filter: { status?: RuleStatus } = {}): Promise<RuleView[]> {
    const { rows } = filter.status
      ? await this.sql.query<Row>(
          'SELECT * FROM lw_rules WHERE status = $1 ORDER BY created_at DESC',
          [filter.status],
        )
      : await this.sql.query<Row>('SELECT * FROM lw_rules ORDER BY created_at DESC');
    return rows.map(view);
  }

  async get(id: string): Promise<RuleView | null> {
    const { rows } = await this.sql.query<Row>('SELECT * FROM lw_rules WHERE id = $1', [id]);
    return rows[0] ? view(rows[0]) : null;
  }

  async create(input: RuleInput): Promise<RuleView> {
    check(input);
    const id = randomUUID();
    const body: Body = {
      when: clean(input.when, 600),
      then: clean(input.then, 600),
      roles: input.roles ?? [],
      sources: input.sources ?? [],
      author: input.author,
    };
    const { rows } = await this.sql.query<Row>(
      `INSERT INTO lw_rules (id, ref, status, category, scope_kind, scope_id, body)
       VALUES ($1, 'R-' || nextval('lw_rule_ref'), $2, $3, $4, $5, $6::jsonb) RETURNING *`,
      [id, input.status, input.category, input.scope.kind, input.scope.id, JSON.stringify(body)],
    );
    await this.log(id, 'created', { status: input.status, author: input.author });
    return view(rows[0]!);
  }

  async edit(id: string, patch: RulePatch): Promise<RuleView> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`No rule "${id}".`);
    const next = {
      when: patch.when !== undefined ? clean(patch.when, 600) : cur.when,
      then: patch.then !== undefined ? clean(patch.then, 600) : cur.then,
    };
    check(next);
    const body: Body = {
      ...next,
      roles: patch.roles ?? cur.roles,
      sources: cur.sources,
      author: cur.author,
    };
    const scope = patch.scope ?? cur.scope;
    const { rows } = await this.sql.query<Row>(
      `UPDATE lw_rules SET body = $2::jsonb, category = $3, scope_kind = $4, scope_id = $5,
         version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(body), patch.category ?? cur.category, scope.kind, scope.id],
    );
    await this.log(id, 'edited', {
      version: rows[0]!.version,
      before: { when: cur.when, then: cur.then },
    });
    return view(rows[0]!);
  }

  async setStatus(id: string, status: RuleStatus): Promise<RuleView> {
    const { rows } = await this.sql.query<Row>(
      'UPDATE lw_rules SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, status],
    );
    if (!rows[0]) throw new Error(`No rule "${id}".`);
    if (status !== 'proposed')
      await this.log(id, status === 'active' ? 'activated' : 'retired', {});
    return view(rows[0]);
  }

  async matching(ctx: RuleContext): Promise<RuleView[]> {
    const { rows } = await this.sql.query<Row>(
      `SELECT * FROM lw_rules WHERE status = 'active' AND (
         (scope_kind = 'project' AND scope_id = $2) OR
         (scope_kind = 'playbook' AND scope_id = $3) OR
         (scope_kind = 'platform' AND scope_id = $4))
       ORDER BY (category = $1) DESC, created_at`,
      [ctx.category, ctx.projectId, ctx.playbookId ?? '', ctx.platform ?? ''],
    );
    return rows.map(view).filter((r) => ruleCovers(r, ctx));
  }

  async applied(id: string, use: RuleUse): Promise<void> {
    await this.sql.query('UPDATE lw_rules SET applied = applied + 1 WHERE id = $1', [id]);
    await this.log(id, 'applied', { ...use });
  }

  async overridden(id: string, use: RuleUse): Promise<void> {
    await this.sql.query('UPDATE lw_rules SET overridden = overridden + 1 WHERE id = $1', [id]);
    await this.log(id, 'overridden', { ...use });
  }

  async history(id: string): Promise<RuleHistoryItem[]> {
    const { rows } = await this.sql.query<{
      at: string | Date;
      kind: RuleHistoryItem['kind'];
      detail: Record<string, unknown>;
    }>('SELECT at, kind, detail FROM lw_rule_history WHERE rule_id = $1 ORDER BY seq', [id]);
    return rows.map((r) => ({ at: iso(r.at), kind: r.kind, detail: r.detail }));
  }

  private async log(id: string, kind: RuleHistoryItem['kind'], detail: Record<string, unknown>) {
    await this.sql.query(
      'INSERT INTO lw_rule_history (rule_id, kind, detail) VALUES ($1, $2, $3::jsonb)',
      [id, kind, JSON.stringify(detail)],
    );
  }
}

/** In memory: tests and local runs on the memory store. */
export class MemoryRuleStore implements RuleStore {
  private readonly rules = new Map<string, RuleView>();
  private readonly log: Map<string, RuleHistoryItem[]> = new Map();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async list(filter: { status?: RuleStatus } = {}): Promise<RuleView[]> {
    return [...this.rules.values()]
      .filter((r) => !filter.status || r.status === filter.status)
      .reverse();
  }

  async get(id: string): Promise<RuleView | null> {
    return this.rules.get(id) ?? null;
  }

  async create(input: RuleInput): Promise<RuleView> {
    check(input);
    const at = new Date(this.now()).toISOString();
    const rule: RuleView = {
      id: randomUUID(),
      ref: `R-${++this.seq}`,
      status: input.status,
      category: input.category,
      scope: input.scope,
      when: clean(input.when, 600),
      then: clean(input.then, 600),
      roles: input.roles ?? [],
      sources: input.sources ?? [],
      author: input.author,
      version: 1,
      applied: 0,
      overridden: 0,
      flagged: false,
      createdAt: at,
      updatedAt: at,
    };
    this.rules.set(rule.id, rule);
    this.push(rule.id, 'created', { status: input.status, author: input.author });
    return rule;
  }

  async edit(id: string, patch: RulePatch): Promise<RuleView> {
    const cur = this.rules.get(id);
    if (!cur) throw new Error(`No rule "${id}".`);
    const next: RuleView = {
      ...cur,
      when: patch.when !== undefined ? clean(patch.when, 600) : cur.when,
      then: patch.then !== undefined ? clean(patch.then, 600) : cur.then,
      category: patch.category ?? cur.category,
      scope: patch.scope ?? cur.scope,
      roles: patch.roles ?? cur.roles,
      version: cur.version + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    check(next);
    this.rules.set(id, next);
    this.push(id, 'edited', { version: next.version, before: { when: cur.when, then: cur.then } });
    return next;
  }

  async setStatus(id: string, status: RuleStatus): Promise<RuleView> {
    const cur = this.rules.get(id);
    if (!cur) throw new Error(`No rule "${id}".`);
    const next = { ...cur, status, updatedAt: new Date(this.now()).toISOString() };
    this.rules.set(id, next);
    if (status !== 'proposed') this.push(id, status === 'active' ? 'activated' : 'retired', {});
    return next;
  }

  async matching(ctx: RuleContext): Promise<RuleView[]> {
    const covering = [...this.rules.values()].filter((r) => ruleCovers(r, ctx));
    return [
      ...covering.filter((r) => r.category === ctx.category),
      ...covering.filter((r) => r.category !== ctx.category),
    ];
  }

  async applied(id: string, use: RuleUse): Promise<void> {
    this.bump(id, 'applied');
    this.push(id, 'applied', { ...use });
  }

  async overridden(id: string, use: RuleUse): Promise<void> {
    this.bump(id, 'overridden');
    this.push(id, 'overridden', { ...use });
  }

  async history(id: string): Promise<RuleHistoryItem[]> {
    return this.log.get(id) ?? [];
  }

  private bump(id: string, field: 'applied' | 'overridden') {
    const cur = this.rules.get(id);
    if (!cur) return;
    const next = { ...cur, [field]: cur[field] + 1 };
    this.rules.set(id, { ...next, flagged: next.overridden >= 2 });
  }

  private push(id: string, kind: RuleHistoryItem['kind'], detail: Record<string, unknown>) {
    this.log.set(id, [
      ...(this.log.get(id) ?? []),
      { at: new Date(this.now()).toISOString(), kind, detail },
    ]);
  }
}
