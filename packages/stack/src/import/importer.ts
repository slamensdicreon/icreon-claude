import { randomUUID } from 'node:crypto';
import { mappingProblems, parseSource, type MappingEntry } from '@lw/platforms';
import {
  CrawlReports,
  fetchPage,
  layoutData,
  OfflineParser,
  Pacer,
  type CrawlStore,
  type GuardedBrowser,
  type SelectQuery,
  type UrlPolicy,
} from '@lw/tool-browser';
import {
  emptyImportStats,
  type ImportJob,
  type ImportPage,
  type ImportStats,
  type ImportStore,
} from './store';

/** A tool call made as the importing task, through the gateway (scopes, audit, locks). */
export type ImportCall = (
  projectId: string,
  role: string,
  taskId: string,
  stepIndex: number,
  server: string,
  op: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; code: number; body: unknown; message?: string; retryable?: boolean }>;

export interface BlueprintLike {
  collections: Record<
    string,
    { key: string; name: string; status?: string; attrs?: Record<string, unknown> }[]
  >;
}

export interface ImporterDeps {
  store: ImportStore;
  crawls: CrawlStore;
  browser: GuardedBrowser;
  policy: (projectId: string) => UrlPolicy;
  call: ImportCall;
  blueprint: (projectId: string) => Promise<BlueprintLike | null>;
  document: (projectId: string, artifactId: string) => Promise<unknown>;
  /** Writes the import's report (template-import-<key>), for its acceptance check. */
  report: (projectId: string, template: string, content: unknown) => Promise<void>;
  /** The site's item path (`/sitecore/content/Brands/acme`): pages live under its Home. */
  sitePath: (projectId: string) => string | null;
  /** Pages written at once (default 4): Sitecore's pace, not the source's. */
  concurrency?: number;
  /**
   * The first pages written, then checked before the rest (default 5; 0 turns it off): a mapping
   * wrong in a way the examples didn't show costs five pages, not eight hundred.
   */
  canary?: number;
  /**
   * The page checks on these paths (rendering, text against the source); null when no checks are
   * connected. A failed check pauses the import after its canary pages.
   */
  verify?: (
    projectId: string,
    paths: string[],
  ) => Promise<{ id: string; status: 'pass' | 'fail' | 'pending'; detail: string }[] | null>;
  leaseMs?: number;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  log?: (msg: string, err?: unknown) => void;
}

/** A refusal the agent can act on (fix the mapping, wait for the crawl), said in a sentence. */
export class ImportError extends Error {}

interface Field {
  name: string;
  value: string;
}

/** An item to make on every page, as the example page has it. */
interface DatasourcePlan {
  name: string;
  exampleId: string;
  templateId: string;
  fields: Field[];
  /** Copied as it is (fields and child items): mapped `same` with field "*". */
  whole: boolean;
  children: { name: string; templateId: string; fields: Field[] }[];
}

/** What every page of the template is built from: the example page, read once. */
export interface ImportPlan {
  /** The role of the agent that started it: the writes are made with its grants and scope. */
  role: string;
  home: string;
  example: { path: string; itemPath: string };
  pageTemplateId: string;
  pageFields: Field[];
  dataFolder: { name: string; templateId: string } | null;
  datasources: DatasourcePlan[];
  renderingsXml: string;
  mapping: MappingEntry[];
  mediaFolder: string | null;
}

const hex = (id: string) => id.replace(/[^0-9a-f]/gi, '').toLowerCase();
/** `{AAAAAAAA-BBBB-...}`, as layout XML writes IDs. */
const braced = (id: string) => {
  const h = hex(id).toUpperCase();
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
};
const xmlAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fieldsOf = (body: unknown): Field[] =>
  ((body as { fields?: { nodes?: Field[] } })?.fields?.nodes ?? []).map((f) => ({
    name: f.name,
    value: f.value ?? '',
  }));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Applies a large site's proven template mapping to every other page of the template, in the
 * background: for each page, the source values its mapping names, then the page item, its Data
 * folder and datasources, and its layout, cloned from the example page and filled in. Writes go
 * through the gateway as the task that started the import, so the role's scopes, the write
 * locks and the audit trail all apply. A page that doesn't fit (its parent isn't built, its
 * source lacks a mapped value, its source is gone) is an exception, for an agent; an import
 * survives a restart and resumes where it was.
 */
export class TemplateImporter {
  readonly owner = `importer-${randomUUID().slice(0, 8)}`;
  private readonly active = new Map<string, Promise<void>>();
  private readonly finished = new Map<string, Set<() => void>>();
  private closing = false;

  constructor(private readonly deps: ImporterDeps) {}

  get store(): ImportStore {
    return this.deps.store;
  }

  /**
   * Starts importing the template's pages, or returns the import already doing it. `retry`
   * queues a finished import's exceptions and failures again (after a mapping fix, or once
   * their parents are built).
   */
  async start(
    projectId: string,
    taskId: string,
    template: string,
    opts: { retry?: boolean; role?: string } = {},
  ): Promise<{ job: ImportJob; existing: 'running' | 'paused' | 'done' | 'retried' | null }> {
    const last = await this.deps.store.latest(projectId, template);
    if (last?.status === 'running') {
      this.ensure(last);
      return { job: last, existing: 'running' };
    }
    if (last?.status === 'paused' && !opts.retry) return { job: last, existing: 'paused' };
    if (last && last.status === 'done' && !opts.retry) return { job: last, existing: 'done' };
    if (last && opts.retry && last.status !== 'failed' && last.status !== 'reverted') {
      // The mapping may have been fixed since: read the example page and mapping again.
      const { plan } = await this.preflight(
        projectId,
        template,
        taskId,
        opts.role ?? 'content-migrator',
      );
      // A paused import's canary pages are written again with the fixed mapping.
      const paused = last.status === 'paused';
      const n = await this.deps.store.requeue(
        last.id,
        paused ? ['exception', 'failed', 'done'] : ['exception', 'failed'],
      );
      await this.deps.store.update(last.id, {
        ...(paused ? { stats: { ...last.stats, canary: null } } : {}),
        plan,
        status: 'running',
        message: `Retrying ${n} page${n === 1 ? '' : 's'}.`,
        finishedAt: null,
      });
      const job = { ...last, plan, status: 'running' as const };
      this.ensure(job);
      return { job, existing: 'retried' };
    }
    const { plan, crawlId, pages } = await this.preflight(
      projectId,
      template,
      taskId,
      opts.role ?? 'content-migrator',
    );
    const now = new Date().toISOString();
    const job: ImportJob = {
      id: `import-${randomUUID().slice(0, 8)}`,
      projectId,
      taskId,
      template,
      crawlId,
      status: 'running',
      plan,
      stats: emptyImportStats(),
      message: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await this.deps.store.create(job);
    await this.deps.store.enqueue(job.id, pages);
    this.ensure(job);
    return { job, existing: null };
  }

  async resumeAll(): Promise<number> {
    const jobs = await this.deps.store.running();
    for (const j of jobs) this.ensure(j);
    return jobs.length;
  }

  async wait(id: string, ms: number): Promise<ImportJob | null> {
    const deadline = Date.now() + Math.max(0, ms);
    for (;;) {
      const job = await this.deps.store.get(id);
      if (!job || job.status !== 'running') return job;
      this.ensure(job);
      const left = deadline - Date.now();
      if (left <= 0) return job;
      await new Promise<void>((resolve) => {
        const set = this.finished.get(id) ?? new Set();
        const timer = setTimeout(done, Math.min(left, this.active.has(id) ? left : 2_000));
        set.add(done);
        this.finished.set(id, set);
        function done() {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        }
      });
    }
  }

  async stop(id: string): Promise<ImportJob | null> {
    const job = await this.deps.store.get(id);
    if (job?.status === 'running')
      await this.deps.store.update(id, {
        status: 'stopped',
        message: 'Stopped when asked.',
        finishedAt: new Date().toISOString(),
      });
    await this.active.get(id)?.catch(() => {});
    return this.deps.store.get(id);
  }

  /** For a worker shutting down: imports stay running for the next worker. */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active.values()]);
  }

  // ---------------------------------------------------------------------------------------------

  /**
   * Everything the import needs, checked before a page is written: the template and its proven
   * mapping, a finished crawl listing its pages, and the example page in Sitecore, whose items
   * and layout every page copies.
   */
  async preflight(
    projectId: string,
    template: string,
    taskId: string,
    role: string,
  ): Promise<{ plan: ImportPlan; crawlId: string; pages: { url: string; path: string }[] }> {
    const bp = await this.deps.blueprint(projectId);
    const item = (bp?.collections['page-templates'] ?? []).find(
      (t) => t.key === template && t.status !== 'drop',
    );
    if (!item)
      throw new ImportError(
        `The Blueprint has no page template "${template}" to import (page-templates)`,
      );
    const doc = (await this.deps.document(projectId, `template-mapping-${template}`)) as {
      mapping?: MappingEntry[];
      mediaFolder?: string;
    } | null;
    if (!doc)
      throw new ImportError(
        `No template-mapping-${template}: prove the template on its example pages first`,
      );
    const problems = mappingProblems(doc.mapping, doc.mediaFolder);
    if (problems.length)
      throw new ImportError(
        `template-mapping-${template} can't be run as it is: ${problems.slice(0, 4).join('; ')}`,
      );
    const mapping = doc.mapping!;

    const inventory = (await this.deps.document(projectId, 'page-inventory')) as {
      crawl?: { crawlId?: string };
    } | null;
    const crawlId = String(item.attrs?.crawlId ?? inventory?.crawl?.crawlId ?? '');
    const crawl = crawlId ? await this.deps.crawls.get(crawlId) : null;
    if (!crawl || crawl.projectId !== projectId)
      throw new ImportError(`No crawl ${crawlId || '(none named)'} lists this template's pages`);
    if (crawl.status === 'running')
      throw new ImportError(`Crawl ${crawlId} is still running: import once it is done`);

    const sitePath = this.deps.sitePath(projectId);
    if (!sitePath) throw new ImportError("The project's site path isn't known yet");
    const home = `${sitePath.replace(/\/$/, '')}/Home`;
    const examples = (bp!.collections.pages ?? []).filter(
      (p) => p.status !== 'drop' && p.attrs?.mergedInto === template,
    );
    const examplePaths = examples
      .map((p) => String(p.attrs?.path ?? '').replace(/\/$/, '') || '/')
      .filter(Boolean);
    if (!examplePaths.length)
      throw new ImportError(`${template} has no example pages to copy the structure from`);

    const plan = await this.readExample(
      projectId,
      role,
      taskId,
      home,
      examplePaths[0]!,
      mapping,
      doc.mediaFolder ?? null,
    );

    // The template's pages, from the crawl, except the examples (already built).
    const reports = new CrawlReports(this.deps.crawls);
    const grouping = await reports.grouping(crawl);
    const crawlTemplate = String(item.attrs?.crawlTemplate ?? '');
    const skip = new Set(examplePaths.map((p) => p.toLowerCase()));
    const pages = grouping.pages
      .filter((p) => grouping.grouping.templateOf.get(p.url) === crawlTemplate)
      .map((p) => {
        const u = new URL(p.url);
        return { url: p.url, path: u.pathname.replace(/\/$/, '') || '/' };
      })
      .filter((p) => !skip.has(p.path.toLowerCase()));
    if (!pages.length)
      throw new ImportError(
        `Crawl ${crawlId} lists no pages in template ${crawlTemplate} besides its examples`,
      );
    return { plan, crawlId, pages };
  }

  /** The example page's item, Data folder, datasources and layout, as every page will have them. */
  private async readExample(
    projectId: string,
    role: string,
    taskId: string,
    home: string,
    route: string,
    mapping: MappingEntry[],
    mediaFolder: string | null,
  ): Promise<ImportPlan> {
    // Fresh step numbers each preflight: a retry after a fix must read Sitecore again, not get
    // the gateway's recorded answer to the same request.
    let step = Date.now() * 64;
    const read = async (args: Record<string, unknown>) => {
      const r = await this.deps.call(
        projectId,
        role,
        taskId,
        step++,
        'sitecore-authoring',
        'item.read',
        args,
      );
      return r;
    };
    const itemPath = route === '/' ? home : `${home}${route}`;
    const page = await read({ path: itemPath });
    if (!page.ok)
      throw new ImportError(
        `The example page ${route} isn't in Sitecore at ${itemPath} (${page.message ?? `HTTP ${page.code}`}): migrate it first`,
      );
    const p = page.body as { itemId: string; template?: { templateId?: string } };
    const layout = await read({ path: itemPath, fields: ['__Renderings'] });
    const renderingsXml =
      fieldsOf(layout.body).find((f) => same(f.name, '__Renderings'))?.value ?? '';
    if (!/<r\b[^>]*\bid=/i.test(renderingsXml))
      throw new ImportError(`The example page ${route} has no layout to copy: compose it first`);
    const kids = await read({ path: itemPath, children: true });
    const children =
      (kids.body as { children?: { nodes?: { name: string; path: string }[] } })?.children?.nodes ??
      [];
    const data = children.find((c) => /^data$/i.test(c.name));
    let dataFolder: ImportPlan['dataFolder'] = null;
    const datasources: DatasourcePlan[] = [];
    if (data) {
      const folder = await read({ path: data.path, children: true });
      const f = folder.body as {
        template?: { templateId?: string };
        children?: { nodes?: { name: string; path: string }[] };
      };
      dataFolder = { name: data.name, templateId: f.template?.templateId ?? '' };
      for (const ds of f.children?.nodes ?? []) {
        const r = await read({ path: ds.path, children: true });
        const b = r.body as {
          itemId: string;
          template?: { templateId?: string };
          children?: { nodes?: { name: string; path: string }[] };
        };
        const whole = mapping.some((m) => same(m.component, ds.name) && m.field === '*');
        const listed = b.children?.nodes ?? [];
        if (listed.length && !whole)
          throw new ImportError(
            `The example's ${ds.name} lists ${listed.length} child items, and the bulk import can't map lists: map it as { "component": "${ds.name}", "field": "*", "from": "same" } if every page shows the same items, or leave this template's pages to agents`,
          );
        const kidsPlan: DatasourcePlan['children'] = [];
        for (const c of whole ? listed : []) {
          const cr = await read({ path: c.path });
          const cb = cr.body as { template?: { templateId?: string } };
          kidsPlan.push({
            name: c.name,
            templateId: cb.template?.templateId ?? '',
            fields: fieldsOf(cr.body),
          });
        }
        datasources.push({
          name: ds.name,
          exampleId: b.itemId,
          templateId: b.template?.templateId ?? '',
          fields: fieldsOf(r.body),
          whole,
          children: kidsPlan,
        });
      }
    }
    const known = ['page', ...datasources.map((d) => d.name)];
    const unknown = mapping.filter((m) => !known.some((k) => same(k, m.component)));
    if (unknown.length)
      throw new ImportError(
        `The mapping names ${[...new Set(unknown.map((m) => m.component))].join(', ')}, which the example page ${route} has no datasource item for (it has ${known.join(', ')})`,
      );
    return {
      role,
      home,
      example: { path: route, itemPath },
      pageTemplateId: p.template?.templateId ?? '',
      pageFields: fieldsOf(page.body),
      dataFolder,
      datasources,
      renderingsXml,
      mapping,
      mediaFolder,
    };
  }

  // ---------------------------------------------------------------------------------------------

  private ensure(job: ImportJob): void {
    if (this.active.has(job.id) || this.closing) return;
    const run = this.run(job.id)
      .catch((err: unknown) =>
        (this.deps.log ?? ((m, e) => console.error(m, e ?? '')))(`Import ${job.id} failed`, err),
      )
      .finally(() => {
        this.active.delete(job.id);
        for (const f of this.finished.get(job.id) ?? []) f();
      });
    this.active.set(job.id, run);
  }

  private async run(id: string): Promise<void> {
    const store = this.deps.store;
    const leaseMs = this.deps.leaseMs ?? 60_000;
    if (!(await store.lease(id, this.owner, leaseMs))) return;
    const job = await store.get(id);
    if (!job || job.status !== 'running') {
      await store.release(id, this.owner);
      return;
    }
    let lost = false;
    const heartbeat = setInterval(() => {
      store
        .lease(id, this.owner, leaseMs)
        .then((held) => {
          if (!held) lost = true;
        })
        .catch(() => {});
    }, leaseMs / 3);
    const stats: ImportStats = { ...emptyImportStats(), ...job.stats };
    stats.writingSince ??= new Date().toISOString();
    const plan = job.plan as ImportPlan;
    const policy = this.deps.policy(job.projectId);
    const source = new Pacer(4);
    const media = new Map<string, string>();
    try {
      await store.requeue(id);
      let checked = 0;
      let halted = false;
      /** Writes queued pages, `limit` of them at most, until none are left or it must stop. */
      const drain = (limit = Infinity) => {
        let taken = 0;
        return this.deps.browser.withContext(
          policy,
          async (offline) => {
            const parser = new OfflineParser(offline);
            const workers = Array.from({ length: this.deps.concurrency ?? 4 }, async () => {
              for (;;) {
                if (lost || this.closing || halted || taken >= limit) return;
                if (Date.now() - checked > 2_000) {
                  checked = Date.now();
                  const current = await store.get(id);
                  if (current?.status !== 'running') {
                    halted = true;
                    return;
                  }
                }
                taken++;
                const [page] = await store.claim(id, 1);
                if (!page) return;
                await this.importPage(job, plan, page, { parser, source, policy, stats, media });
              }
            });
            await Promise.all(workers);
          },
          { offline: true },
        );
      };
      const canary = this.deps.canary ?? 5;
      if (canary > 0 && stats.canary?.passed !== true) {
        await drain(canary);
        if (lost || this.closing || halted) {
          await store.update(id, { stats });
          return;
        }
        const pause = await this.checkCanary(job, stats);
        if (pause) {
          await store.update(id, { status: 'paused', stats, message: pause });
          return;
        }
      }
      await drain();
      await store.update(id, { stats });
      if (lost || this.closing || halted) return;
      const c = await store.counts(id);
      if (c.queued || c.inflight) return;
      await store.update(id, {
        status: 'done',
        stats,
        message: null,
        finishedAt: new Date().toISOString(),
      });
      await this.writeReport(job);
    } catch (err) {
      await store.update(id, {
        status: 'failed',
        stats,
        message: `The import failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        finishedAt: new Date().toISOString(),
      });
      throw err;
    } finally {
      clearInterval(heartbeat);
      await store.release(id, this.owner).catch(() => {});
    }
  }

  /**
   * After the canary pages: the reason to pause, or null to go on. All of them exceptions, or a
   * page check failing on those written, means the mapping is wrong for the template.
   */
  private async checkCanary(job: ImportJob, stats: ImportStats): Promise<string | null> {
    const done = await this.deps.store.pages(job.id, { states: ['done'] });
    if (!done.length) {
      const off = await this.deps.store.pages(job.id, { states: ['exception', 'failed'] });
      const reasons = [...new Set(off.map((p) => p.reason ?? 'unknown'))].slice(0, 3).join('; ');
      stats.canary = { passed: false, detail: reasons };
      return `Paused after its first ${off.length} pages: none could be written (${reasons}). Fix template-mapping-${job.template}, then import.start with retry: true`;
    }
    const results = this.deps.verify
      ? await this.deps
          .verify(
            job.projectId,
            done.map((p) => p.path),
          )
          .catch(() => null)
      : null;
    const failed = (results ?? []).filter((r) => r.status === 'fail');
    if (failed.length) {
      const detail = failed.map((r) => `${r.id}: ${r.detail}`).join(' ');
      stats.canary = { passed: false, detail };
      return `Paused after its first ${done.length} pages: the page checks failed on them (${detail}). Fix template-mapping-${job.template} (or the components), then import.start with retry: true: those pages are written again before the rest`;
    }
    stats.canary = {
      passed: true,
      detail: results?.length
        ? results.map((r) => `${r.id} ${r.status}`).join(', ')
        : 'no page checks connected',
    };
    return null;
  }

  /**
   * Takes an import back out of Sitecore: each page the import itself created, with its Data
   * folder and datasources, moved to the Recycle Bin (restorable there), bottom-up. Pages an
   * agent built, or that gained items the import didn't make, are left and listed. Only for an
   * import that is no longer writing.
   */
  async revert(
    id: string,
    role = 'content-migrator',
  ): Promise<{ removed: number; kept: string[] }> {
    const store = this.deps.store;
    const job = await store.get(id);
    if (!job) throw new ImportError(`No import ${id}`);
    if (job.status === 'running')
      throw new ImportError(`Import ${id} is still writing: stop it first (import.stop)`);
    const plan = job.plan as ImportPlan;
    const kept: string[] = [];
    let removed = 0;
    let k = Date.now() * 64;
    const call = (op: string, args: Record<string, unknown>) =>
      this.deps.call(job.projectId, role, job.taskId, k++, 'sitecore-authoring', op, args);
    const childrenOf = async (path: string) => {
      const r = await call('item.read', { path, children: true });
      return r.ok
        ? ((r.body as { children?: { nodes?: { name: string; path: string }[] } }).children
            ?.nodes ?? [])
        : null;
    };
    for (const page of await store.pages(id, { states: ['done'] })) {
      if (!page.created) {
        kept.push(`${page.path} (built before the import)`);
        continue;
      }
      const itemPath = page.path === '/' ? plan.home : `${plan.home}${page.path}`;
      // Only what the import makes: its Data folder, the datasources it names, and their copied
      // child items. Anything else under the page means someone added to it: leave it.
      const own = new Set(plan.datasources.map((d) => d.name.toLowerCase()));
      const top = await childrenOf(itemPath);
      if (!top) {
        await store.finish(id, page.url, { state: 'reverted', reason: 'already gone' });
        continue;
      }
      const data = plan.dataFolder?.name.toLowerCase();
      const foreign = top.filter((c) => c.name.toLowerCase() !== data);
      const dataPath = plan.dataFolder ? `${itemPath}/${plan.dataFolder.name}` : null;
      const inData = dataPath ? ((await childrenOf(dataPath)) ?? []) : [];
      const foreignData = inData.filter((c) => !own.has(c.name.toLowerCase()));
      if (foreign.length || foreignData.length) {
        kept.push(`${page.path} (it has items the import didn't make)`);
        continue;
      }
      let ok = true;
      for (const ds of inData) {
        const plannedDs = plan.datasources.find(
          (d) => d.name.toLowerCase() === ds.name.toLowerCase(),
        );
        for (const child of (await childrenOf(ds.path)) ?? []) {
          if (!plannedDs?.children.some((c) => c.name.toLowerCase() === child.name.toLowerCase())) {
            ok = false;
            break;
          }
          if (!(await call('item.delete', { path: child.path })).ok) ok = false;
        }
        if (ok && !(await call('item.delete', { path: ds.path })).ok) ok = false;
      }
      if (ok && dataPath && !(await call('item.delete', { path: dataPath })).ok) ok = false;
      if (ok && !(await call('item.delete', { path: itemPath })).ok) ok = false;
      if (!ok) {
        kept.push(`${page.path} (Sitecore refused a delete: check it by hand)`);
        continue;
      }
      removed++;
      await store.finish(id, page.url, { state: 'reverted', reason: 'removed by revert' });
    }
    await store.update(id, {
      status: 'reverted',
      message: `Reverted: ${removed} pages moved to the Recycle Bin${kept.length ? `, ${kept.length} left` : ''}.`,
      finishedAt: new Date().toISOString(),
    });
    await this.writeReport({ ...job, status: 'reverted' });
    return { removed, kept };
  }

  /** template-import-<key>: what was imported, and every exception with its reason. */
  async writeReport(job: ImportJob): Promise<void> {
    const store = this.deps.store;
    const all = await store.pages(job.id);
    const counts = await store.counts(job.id);
    const current = (await store.get(job.id)) ?? job;
    await this.deps.report(job.projectId, job.template, {
      template: job.template,
      importId: job.id,
      crawlId: job.crawlId,
      status: current.status,
      total: all.length,
      counts,
      imported: all
        .filter((p) => p.state === 'done')
        .map((p) => ({ path: p.path, itemId: p.itemId })),
      exceptions: all
        .filter((p) => p.state === 'exception' || p.state === 'failed')
        .map((p) => ({ path: p.path, state: p.state, reason: p.reason })),
    });
  }

  /** One page: its source values, then its items and layout, read back. */
  private async importPage(
    job: ImportJob,
    plan: ImportPlan,
    page: ImportPage,
    ctx: {
      parser: OfflineParser;
      source: Pacer;
      policy: UrlPolicy;
      stats: ImportStats;
      media: Map<string, string>;
    },
  ): Promise<void> {
    const store = this.deps.store;
    const attempts = page.attempts + 1;
    // Step numbers unique to this page and attempt: a retry reads and writes again.
    let k = (page.seq * 16 + Math.min(attempts, 15)) * 64;
    const call = async (server: string, op: string, args: Record<string, unknown>) => {
      const r = await this.deps.call(job.projectId, plan.role, job.taskId, k++, server, op, args);
      if (!r.ok)
        throw new CallFailed(
          `${op}: ${r.message ?? `HTTP ${r.code}`}`,
          r.retryable === true,
          r.code,
        );
      return r.body as Record<string, unknown>;
    };
    const exception = (reason: string) =>
      store.finish(job.id, page.url, { state: 'exception', reason, attempts });
    try {
      const segments = page.path.split('/').filter(Boolean);
      if (!segments.length) return await exception('the home page is never part of a template');
      const name = decodeURIComponent(segments[segments.length - 1]!);
      // Sitecore item names hold letters, digits, spaces, hyphens, underscores and $; a page whose
      // URL needs anything else is built by hand (with a redirect if its URL must change).
      if (!ITEM_NAME.test(name))
        return await exception(
          `its URL segment "${name}" isn't a valid Sitecore item name: build it by hand, naming it so its URL stays the same or adding a redirect`,
        );
      const parentRoute = `/${segments.slice(0, -1).join('/')}`;
      const parentPath = parentRoute === '/' ? plan.home : `${plan.home}${parentRoute}`;
      const itemPath = `${parentPath}/${name}`;
      const parent = await this.deps.call(
        job.projectId,
        plan.role,
        job.taskId,
        k++,
        'sitecore-authoring',
        'item.read',
        { path: parentPath },
      );
      if (!parent.ok)
        return await exception(
          `its parent ${parentRoute} isn't on the new site yet: build it, then retry the import`,
        );

      // The source values.
      const fetched = await ctx.source.run(() =>
        fetchPage(page.url, ctx.policy, this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      );
      if (fetched.status === 429 || fetched.status === 503) {
        ctx.source.throttled(fetched.retryAfterMs);
        return await store.finish(job.id, page.url, {
          state: attempts < 4 ? 'queued' : 'failed',
          reason: `the source answered HTTP ${fetched.status}`,
          attempts,
        });
      }
      if (fetched.status >= 400 || !/html/i.test(fetched.contentType))
        return await exception(`the source page answered HTTP ${fetched.status}`);
      ctx.source.succeeded();
      const values = await this.values(plan, fetched.body, fetched.finalUrl, page.path, ctx.parser);
      const missing = plan.mapping.filter((m, i) => !m.optional && m.from !== 'same' && !values[i]);
      if (missing.length)
        return await exception(
          `its source has nothing for ${missing.map((m) => `${m.component}.${m.field} (${m.from})`).join(', ')}: it doesn't fit the mapping`,
        );

      // Images: downloaded through the browser (the source or its CDN), uploaded once each.
      const stored: (string | null)[] = [];
      for (const [i, m] of plan.mapping.entries()) {
        const v = values[i] ?? null;
        if (!v || m.as !== 'image') {
          stored.push(v === null ? null : encode(m, v));
          continue;
        }
        let value = ctx.media.get(v);
        if (!value) {
          const asset = await call('browser', 'fetch.asset', { url: v });
          const file = decodeURIComponent(new URL(v).pathname.split('/').pop() || 'image');
          const base =
            file
              .replace(/\.[a-z0-9]+$/i, '')
              .replace(/[^A-Za-z0-9 _-]+/g, '-')
              .slice(0, 80) || 'image';
          const up = await call('sitecore-authoring', 'media.upload', {
            itemPath: `${plan.mediaFolder!.replace(/\/$/, '')}/${base}`,
            ref: asset.ref,
            fileName: file,
          });
          if (!up.itemId) throw new CallFailed(`media.upload gave no item ID for ${v}`, false, 500);
          value = `<image mediaid="${braced(String(up.itemId))}" />`;
          ctx.media.set(v, value);
          ctx.stats.uploads++;
        }
        stored.push(value);
      }
      const valueFor = (component: string, field: string, example: string) => {
        const i = plan.mapping.findIndex(
          (m) => same(m.component, component) && same(m.field, field),
        );
        if (i < 0) return null;
        const m = plan.mapping[i]!;
        if (m.from === 'same') return example;
        return stored[i] ?? '';
      };

      // The page item.
      const pageFields = plan.pageFields.flatMap((f) => {
        const v = valueFor('page', f.name, f.value);
        return v === null ? [] : [{ name: f.name, value: v }];
      });
      const created = await call('sitecore-authoring', 'item.create', {
        parentPath,
        name,
        templateId: plan.pageTemplateId,
        ...(pageFields.length ? { fields: pageFields } : {}),
      });
      if (created.existed && pageFields.length)
        await call('sitecore-authoring', 'item.update', { path: itemPath, fields: pageFields });
      const itemId = String(created.itemId ?? '');
      const made = created.existed !== true;

      // Its Data folder and datasources; the example's datasource IDs, mapped to this page's.
      const ids = new Map<string, string>();
      if (plan.dataFolder) {
        const dataPath = `${itemPath}/${plan.dataFolder.name}`;
        await call('sitecore-authoring', 'item.create', {
          parentPath: itemPath,
          name: plan.dataFolder.name,
          templateId: plan.dataFolder.templateId,
        });
        for (const ds of plan.datasources) {
          // Every field set, unmapped ones empty: a field left unset shows its template's default.
          const fields = ds.fields.map((f) => ({
            name: f.name,
            value: ds.whole ? f.value : (valueFor(ds.name, f.name, f.value) ?? ''),
          }));
          const made = await call('sitecore-authoring', 'item.create', {
            parentPath: dataPath,
            name: ds.name,
            templateId: ds.templateId,
            fields,
          });
          if (made.existed)
            await call('sitecore-authoring', 'item.update', {
              path: `${dataPath}/${ds.name}`,
              fields,
            });
          ids.set(hex(ds.exampleId), String(made.itemId ?? ''));
          for (const child of ds.children)
            await call('sitecore-authoring', 'item.create', {
              parentPath: `${dataPath}/${ds.name}`,
              name: child.name,
              templateId: child.templateId,
              fields: child.fields,
            });
        }
      }

      // The layout: the example's, pointing at this page's datasources.
      const xml = plan.renderingsXml
        .replace(/\bds="([^"]*)"/gi, (whole, ds: string) => {
          const to = ids.get(hex(ds));
          return to ? `ds="${braced(to)}"` : whole;
        })
        .replace(/\buid="[^"]*"/gi, () => `uid="${braced(randomUUID())}"`);
      await call('sitecore-authoring', 'layout.compose', { path: itemPath, renderingsXml: xml });
      ctx.stats.written++;
      await store.finish(job.id, page.url, {
        state: 'done',
        itemId,
        created: made,
        reason: null,
        attempts,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      const retry = err instanceof CallFailed ? err.retryable : true;
      // A refusal (scope, a rule) or a bad request won't change on a retry: the page is an
      // exception for an agent. A timeout or an unreachable service is tried again.
      if (err instanceof CallFailed && !retry)
        return await store.finish(job.id, page.url, { state: 'exception', reason, attempts });
      await store.finish(job.id, page.url, {
        state: attempts < 3 ? 'queued' : 'failed',
        reason,
        attempts,
      });
    }
  }

  /** Each mapping entry's raw value from the source page, in the mapping's order. */
  private async values(
    plan: ImportPlan,
    html: string,
    url: string,
    path: string,
    parser: OfflineParser,
  ): Promise<(string | null)[]> {
    const sources = plan.mapping.map((m) => parseSource(m.from));
    const queries: SelectQuery[] = [];
    const at = new Map<number, number>();
    for (const [i, s] of sources.entries()) {
      if ('error' in s) continue;
      if (s.kind === 'title' || s.kind === 'description') {
        at.set(i, queries.length);
        queries.push({ kind: s.kind });
      } else if (s.kind === 'css') {
        at.set(i, queries.length);
        // Rich Text takes the element's HTML unless an attribute is named.
        const attr = s.attr ?? (plan.mapping[i]!.as === 'html' ? 'html' : undefined);
        queries.push({ selector: s.selector, ...(attr ? { attr } : {}) });
      }
    }
    const selected = queries.length ? await parser.select(html, url, queries) : [];
    let components: ReturnType<typeof layoutData> | null = null;
    return sources.map((s, i) => {
      if ('error' in s) return null;
      if (s.kind === 'path') return path;
      if (s.kind === 'same') return null;
      if (s.kind === 'data') {
        components ??= layoutData(html);
        const c = components.find((x) => same(x.name, s.component));
        let v: unknown = c?.fields;
        for (const key of s.field)
          v = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
        // A Sitecore field object: { value } (text), { value: { src } } (image), { value: { href } }.
        if (v && typeof v === 'object' && 'value' in v) v = (v as { value: unknown }).value;
        if (v && typeof v === 'object')
          v = (v as { src?: unknown; href?: unknown }).src ?? (v as { href?: unknown }).href;
        return typeof v === 'string' && v.trim() ? v : typeof v === 'number' ? String(v) : null;
      }
      return selected[at.get(i)!] ?? null;
    });
  }
}

/** Sitecore's default item name rule (ItemNameValidation). */
const ITEM_NAME = /^[\w*$][\w\s\-$]*(\(\d{1,}\)){0,1}$/;

class CallFailed extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: number,
  ) {
    super(message);
  }
}

/** A value as the field stores it. */
function encode(m: MappingEntry, v: string): string {
  if (m.as === 'link') return `<link linktype="external" url="${xmlAttr(v)}" />`;
  return v;
}
