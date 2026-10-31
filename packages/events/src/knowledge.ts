import { randomUUID } from 'node:crypto';
import type { KnowledgeEntry, KnowledgeEvidence, KnowledgeScope } from '@lw/contracts';
import type { SqlClient } from './postgres';

export type KnowledgeStatus = KnowledgeEntry['status'];
export type KnowledgeKind = KnowledgeEntry['kind'];

/** A new entry. `sourceKey` names what it came from, so adding it again adds nothing. */
export interface KnowledgeInput {
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  scope: KnowledgeScope;
  title: string;
  text: string;
  roles?: string[];
  operations?: string[];
  templates?: string[];
  tags?: string[];
  evidence?: KnowledgeEvidence[];
  author: KnowledgeEntry['author'];
  source?: KnowledgeEntry['source'];
  sourceKey?: string;
}

/** What an edit may change; each edit is a new version. */
export type KnowledgePatch = Partial<
  Pick<
    KnowledgeInput,
    'kind' | 'scope' | 'title' | 'text' | 'roles' | 'operations' | 'templates' | 'tags'
  >
>;

/** Where a task runs, to find the entries that apply to it. */
export interface KnowledgeContext {
  projectId: string;
  playbookId: string | null;
  platform: string | null;
  role: string;
  /** The operations the role may call, "server.op". */
  operations: string[];
  templateId: string | null;
  /** Words to match: the task's title, its items, its template. */
  text: string;
  /** Seed documents the role already has in full (its prompt's knowledge): not repeated. */
  docs: string[];
}

export interface KnowledgeFilter {
  status?: KnowledgeStatus;
  kind?: KnowledgeKind;
  /** Entries a project's retrospectives proposed. */
  projectId?: string;
  q?: string;
}

/**
 * The team's knowledge across projects. Proposed entries reach no brief until approved; edits are
 * new versions; every change is kept in the entry's history.
 */
export interface KnowledgeStore {
  list(filter?: KnowledgeFilter): Promise<KnowledgeEntry[]>;
  get(id: string): Promise<KnowledgeEntry | null>;
  /** Null when an entry with the same source key exists. */
  create(input: KnowledgeInput): Promise<KnowledgeEntry | null>;
  /** Adds the entries whose source keys aren't there yet; how many it added. */
  seed(inputs: KnowledgeInput[]): Promise<number>;
  edit(id: string, patch: KnowledgePatch): Promise<KnowledgeEntry>;
  setStatus(id: string, status: KnowledgeStatus): Promise<KnowledgeEntry>;
  /** Active entries that apply to a task, best first. */
  retrieve(ctx: KnowledgeContext, limit?: number): Promise<KnowledgeEntry[]>;
  used(ids: string[], use: { projectId: string; taskId: string }): Promise<void>;
  history(id: string): Promise<{ at: string; kind: string; detail: Record<string, unknown> }[]>;
}

interface Body {
  text: string;
  roles: string[];
  operations: string[];
  templates: string[];
  tags: string[];
  evidence: KnowledgeEvidence[];
  author: KnowledgeEntry['author'];
  source: KnowledgeEntry['source'];
}

interface Row {
  id: string;
  ref: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  scope_kind: KnowledgeScope['kind'];
  scope_id: string;
  title: string;
  body: Body;
  version: number;
  used: number;
  created_at: string | Date;
  updated_at: string | Date;
  rank?: number;
}

const iso = (t: string | Date) => new Date(t).toISOString();
const clean = (s: string, max: number) => s.trim().replace(/\s+/g, ' ').slice(0, max);
const list = (xs: string[] | undefined) =>
  [...new Set((xs ?? []).map((x) => x.trim()))].filter(Boolean);

function view(r: Row): KnowledgeEntry {
  return {
    id: r.id,
    ref: r.ref,
    kind: r.kind,
    status: r.status,
    scope: { kind: r.scope_kind, id: r.scope_id },
    title: r.title,
    text: r.body.text,
    roles: r.body.roles,
    operations: r.body.operations,
    templates: r.body.templates,
    tags: r.body.tags,
    evidence: r.body.evidence,
    author: r.body.author,
    source: r.body.source,
    version: r.version,
    used: r.used,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function bodyOf(input: KnowledgeInput): Body {
  if (!input.title.trim() || !input.text.trim())
    throw new Error('A knowledge entry needs a title and what to know.');
  return {
    text: clean(input.text, 2000),
    roles: list(input.roles),
    operations: list(input.operations),
    templates: list(input.templates),
    tags: list(input.tags),
    evidence: (input.evidence ?? []).slice(0, 30),
    author: input.author,
    source: input.source ?? null,
  };
}

/** Does an entry apply where this task runs? Its scope, then what it is limited to. */
export function knowledgeCovers(e: KnowledgeEntry, ctx: KnowledgeContext): boolean {
  if (e.status !== 'active' || e.kind === 'gap') return false;
  if (e.source?.doc && ctx.docs.includes(e.source.doc)) return false;
  const { kind, id } = e.scope;
  const inScope =
    kind === 'global' ||
    (kind === 'platform' && id === ctx.platform) ||
    (kind === 'playbook' && id === ctx.playbookId) ||
    (kind === 'role' && id === ctx.role) ||
    (kind === 'project' && id === ctx.projectId);
  if (!inScope) return false;
  if (e.roles.length && !e.roles.includes(ctx.role)) return false;
  if (e.templates.length && !(ctx.templateId && e.templates.includes(ctx.templateId))) return false;
  // An operation "item.create" matches "sitecore-authoring.item.create".
  if (
    e.operations.length &&
    !e.operations.some((op) => ctx.operations.some((g) => g === op || g.endsWith(`.${op}`)))
  )
    return false;
  return true;
}

const STOP = new Set(
  'a an and are as at be by for from in into is it of on or the to with this that page pages task'.split(
    ' ',
  ),
);
/** The words of a task worth matching on. */
export function knowledgeWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    ),
  ].slice(0, 30);
}

/** Two shared words, a text-search match, or an entry written for this role or operation. */
const RELEVANT = 0.6;

/**
 * How well an entry fits a task, beyond its scope: limited to this role, template or operation
 * counts most (it was written for exactly this), then shared words.
 */
function fit(e: KnowledgeEntry, ctx: KnowledgeContext, words: string[], rank = 0) {
  const hay = `${e.title} ${e.text} ${e.tags.join(' ')}`.toLowerCase();
  const shared = words.filter((w) => hay.includes(w)).length;
  return (
    (e.roles.includes(ctx.role) ? 2 : 0) +
    (ctx.templateId && e.templates.includes(ctx.templateId) ? 2 : 0) +
    (e.operations.length ? 1 : 0) +
    (e.scope.kind === 'project' || e.scope.kind === 'role' ? 0.5 : 0) +
    shared * 0.3 +
    rank * 4
  );
}

export class PostgresKnowledgeStore implements KnowledgeStore {
  constructor(private readonly sql: SqlClient) {}

  async list(filter: KnowledgeFilter = {}): Promise<KnowledgeEntry[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (clause: string, v: unknown) => {
      args.push(v);
      where.push(clause.replace('?', `$${args.length}`));
    };
    if (filter.status) add('status = ?', filter.status);
    if (filter.kind) add('kind = ?', filter.kind);
    if (filter.projectId) add("body->'source'->>'projectId' = ?", filter.projectId);
    if (filter.q?.trim()) add("search @@ websearch_to_tsquery('english', ?)", filter.q.trim());
    const { rows } = await this.sql.query<Row>(
      `SELECT * FROM lw_knowledge ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, ref DESC`,
      args,
    );
    return rows.map(view);
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    const { rows } = await this.sql.query<Row>('SELECT * FROM lw_knowledge WHERE id = $1', [id]);
    return rows[0] ? view(rows[0]) : null;
  }

  async create(input: KnowledgeInput): Promise<KnowledgeEntry | null> {
    const body = bodyOf(input);
    const id = randomUUID();
    const { rows } = await this.sql.query<Row>(
      `INSERT INTO lw_knowledge (id, ref, kind, status, scope_kind, scope_id, title, body, source_key)
       VALUES ($1, 'K-' || nextval('lw_knowledge_ref'), $2, $3, $4, $5, $6, $7::jsonb, $8)
       ON CONFLICT (source_key) DO NOTHING RETURNING *`,
      [
        id,
        input.kind,
        input.status,
        input.scope.kind,
        input.scope.id,
        clean(input.title, 200),
        JSON.stringify(body),
        input.sourceKey ?? null,
      ],
    );
    if (!rows[0]) return null;
    await this.log(id, 'created', { status: input.status, author: input.author });
    return view(rows[0]);
  }

  async seed(inputs: KnowledgeInput[]): Promise<number> {
    const keys = inputs.map((i) => i.sourceKey).filter((k): k is string => !!k);
    const { rows } = await this.sql.query<{ source_key: string }>(
      'SELECT source_key FROM lw_knowledge WHERE source_key = ANY($1::text[])',
      [keys],
    );
    const have = new Set(rows.map((r) => r.source_key));
    let added = 0;
    for (const input of inputs)
      if (!input.sourceKey || !have.has(input.sourceKey)) if (await this.create(input)) added++;
    return added;
  }

  async edit(id: string, patch: KnowledgePatch): Promise<KnowledgeEntry> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`No knowledge entry "${id}".`);
    const body = bodyOf({
      ...cur,
      ...patch,
      evidence: cur.evidence,
      author: cur.author,
      source: cur.source,
    });
    const scope = patch.scope ?? cur.scope;
    const { rows } = await this.sql.query<Row>(
      `UPDATE lw_knowledge SET kind = $2, scope_kind = $3, scope_id = $4, title = $5,
         body = $6::jsonb, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [
        id,
        patch.kind ?? cur.kind,
        scope.kind,
        scope.id,
        clean(patch.title ?? cur.title, 200),
        JSON.stringify(body),
      ],
    );
    await this.log(id, 'edited', {
      version: rows[0]!.version,
      before: { title: cur.title, text: cur.text },
    });
    return view(rows[0]!);
  }

  async setStatus(id: string, status: KnowledgeStatus): Promise<KnowledgeEntry> {
    const { rows } = await this.sql.query<Row>(
      'UPDATE lw_knowledge SET status = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, status],
    );
    if (!rows[0]) throw new Error(`No knowledge entry "${id}".`);
    await this.log(id, status === 'active' ? 'activated' : status, {});
    return view(rows[0]);
  }

  async retrieve(ctx: KnowledgeContext, limit = 8): Promise<KnowledgeEntry[]> {
    const words = knowledgeWords(ctx.text);
    // Any word may match: the text search ranks, the filters decide.
    const query = words.join(' OR ');
    const { rows } = await this.sql.query<Row>(
      `SELECT *, ${query ? "ts_rank(search, websearch_to_tsquery('english', $5))" : '0'} AS rank
       FROM lw_knowledge WHERE status = 'active' AND kind <> 'gap' AND (
         scope_kind = 'global' OR
         (scope_kind = 'platform' AND scope_id = $1) OR
         (scope_kind = 'playbook' AND scope_id = $2) OR
         (scope_kind = 'role' AND scope_id = $3) OR
         (scope_kind = 'project' AND scope_id = $4))`,
      [
        ctx.platform ?? '',
        ctx.playbookId ?? '',
        ctx.role,
        ctx.projectId,
        ...(query ? [query] : []),
      ],
    );
    return rows
      .map((r) => ({ e: view(r), rank: Number(r.rank ?? 0) }))
      .filter(({ e }) => knowledgeCovers(e, ctx))
      .map(({ e, rank }) => ({ e, score: fit(e, ctx, words, rank) }))
      .filter(({ e, score }) => score >= RELEVANT || e.roles.length || e.templates.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ e }) => e);
  }

  async used(ids: string[], use: { projectId: string; taskId: string }): Promise<void> {
    if (!ids.length) return;
    await this.sql.query('UPDATE lw_knowledge SET used = used + 1 WHERE id = ANY($1::text[])', [
      ids,
    ]);
    for (const id of ids) await this.log(id, 'used', { ...use });
  }

  async history(id: string) {
    const { rows } = await this.sql.query<{
      at: string | Date;
      kind: string;
      detail: Record<string, unknown>;
    }>('SELECT at, kind, detail FROM lw_knowledge_history WHERE entry_id = $1 ORDER BY seq', [id]);
    return rows.map((r) => ({ at: iso(r.at), kind: r.kind, detail: r.detail }));
  }

  private async log(id: string, kind: string, detail: Record<string, unknown>) {
    await this.sql.query(
      'INSERT INTO lw_knowledge_history (entry_id, kind, detail) VALUES ($1, $2, $3::jsonb)',
      [id, kind, JSON.stringify(detail)],
    );
  }
}

/** In memory: tests and local runs on the memory store. */
export class MemoryKnowledgeStore implements KnowledgeStore {
  private readonly entries = new Map<string, KnowledgeEntry>();
  private readonly keys = new Set<string>();
  private readonly log = new Map<
    string,
    { at: string; kind: string; detail: Record<string, unknown> }[]
  >();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async list(filter: KnowledgeFilter = {}): Promise<KnowledgeEntry[]> {
    const words = filter.q ? knowledgeWords(filter.q) : [];
    return [...this.entries.values()]
      .filter((e) => !filter.status || e.status === filter.status)
      .filter((e) => !filter.kind || e.kind === filter.kind)
      .filter((e) => !filter.projectId || e.source?.projectId === filter.projectId)
      .filter((e) => {
        const hay = `${e.title} ${e.text} ${e.tags.join(' ')}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .reverse();
  }

  async get(id: string): Promise<KnowledgeEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async create(input: KnowledgeInput): Promise<KnowledgeEntry | null> {
    if (input.sourceKey && this.keys.has(input.sourceKey)) return null;
    const body = bodyOf(input);
    const at = new Date(this.now()).toISOString();
    const e: KnowledgeEntry = {
      id: randomUUID(),
      ref: `K-${++this.seq}`,
      kind: input.kind,
      status: input.status,
      scope: input.scope,
      title: clean(input.title, 200),
      ...body,
      version: 1,
      used: 0,
      createdAt: at,
      updatedAt: at,
    };
    if (input.sourceKey) this.keys.add(input.sourceKey);
    this.entries.set(e.id, e);
    this.push(e.id, 'created', { status: input.status, author: input.author });
    return e;
  }

  async seed(inputs: KnowledgeInput[]): Promise<number> {
    let added = 0;
    for (const input of inputs) if (await this.create(input)) added++;
    return added;
  }

  async edit(id: string, patch: KnowledgePatch): Promise<KnowledgeEntry> {
    const cur = this.entries.get(id);
    if (!cur) throw new Error(`No knowledge entry "${id}".`);
    const body = bodyOf({ ...cur, ...patch, evidence: cur.evidence, author: cur.author });
    const next: KnowledgeEntry = {
      ...cur,
      ...body,
      source: cur.source,
      kind: patch.kind ?? cur.kind,
      scope: patch.scope ?? cur.scope,
      title: clean(patch.title ?? cur.title, 200),
      version: cur.version + 1,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.entries.set(id, next);
    this.push(id, 'edited', {
      version: next.version,
      before: { title: cur.title, text: cur.text },
    });
    return next;
  }

  async setStatus(id: string, status: KnowledgeStatus): Promise<KnowledgeEntry> {
    const cur = this.entries.get(id);
    if (!cur) throw new Error(`No knowledge entry "${id}".`);
    const next = { ...cur, status, updatedAt: new Date(this.now()).toISOString() };
    this.entries.set(id, next);
    this.push(id, status === 'active' ? 'activated' : status, {});
    return next;
  }

  async retrieve(ctx: KnowledgeContext, limit = 8): Promise<KnowledgeEntry[]> {
    const words = knowledgeWords(ctx.text);
    return [...this.entries.values()]
      .filter((e) => knowledgeCovers(e, ctx))
      .map((e) => ({ e, score: fit(e, ctx, words) }))
      .filter(({ e, score }) => score >= RELEVANT || e.roles.length || e.templates.length)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ e }) => e);
  }

  async used(ids: string[], use: { projectId: string; taskId: string }): Promise<void> {
    for (const id of ids) {
      const cur = this.entries.get(id);
      if (!cur) continue;
      this.entries.set(id, { ...cur, used: cur.used + 1 });
      this.push(id, 'used', { ...use });
    }
  }

  async history(id: string) {
    return this.log.get(id) ?? [];
  }

  private push(id: string, kind: string, detail: Record<string, unknown>) {
    this.log.set(id, [
      ...(this.log.get(id) ?? []),
      { at: new Date(this.now()).toISOString(), kind, detail },
    ]);
  }
}

/**
 * Lessons from a platform's known-pitfalls table (Symptom | Likely cause | What to do), one entry
 * a row, keyed so seeding again adds only new rows. Roles that carry the document in full don't
 * get them again in their briefs.
 */
export function pitfallSeeds(platform: string, markdown: string): KnowledgeInput[] {
  const rows = markdown
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim()),
    )
    .filter((cells) => cells.length >= 3 && !/^-+$/.test(cells[0]!.replace(/:/g, '')));
  const [, ...body] = rows;
  return body
    .filter((c) => c[0] && c[2])
    .map(([symptom, cause, todo]) => ({
      kind: 'lesson' as const,
      status: 'active' as const,
      scope: { kind: 'platform' as const, id: platform },
      title: symptom!,
      text: `${cause ? `Likely cause: ${cause.replace(/\.$/, '')}. ` : ''}What to do: ${todo}`,
      tags: ['pitfall'],
      author: 'seed' as const,
      source: { doc: 'known-pitfalls', projectId: null, phase: null },
      evidence: [{ projectId: null, ref: 'known-pitfalls', label: `${platform} known pitfalls` }],
      sourceKey: `${platform}:known-pitfalls:${symptom!
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 120)}`,
    }));
}
