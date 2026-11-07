import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { ImportError, type TemplateImporter } from './importer';
import type { ImportJob, PageState } from './store';

const importId = {
  type: 'string',
  description: "The import's id from import.start; this template's latest import when left out.",
};

const CATALOG: OperationCatalog = {
  start: {
    description:
      "Import a large site's page template in bulk, in the background; returns at once with an importId. It builds every other page of the template the way its example pages are built (the page item, its Data folder and datasources, its layout), filled from each source page by the proven mapping (template-mapping-<template>), through the same write checks as your own writes. A page that doesn't fit (its parent isn't built, its source lacks a mapped value) becomes an exception, for you. Follow it with import.status. An import of the template that is running or done is returned instead of starting another: pass retry: true to try its exceptions and failures again (after fixing the mapping, or building their parents).",
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string', description: "The page-templates item's key." },
        retry: { type: 'boolean' },
      },
      required: ['template'],
      additionalProperties: false,
    },
    mutates: false,
  },
  status: {
    description:
      "An import's progress: pages written, exceptions and failures (grouped by reason, with examples), pace and time left. Give waitSeconds (up to 300) to wait for it to finish before answering; call it again until status is no longer running.",
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string' },
        importId,
        waitSeconds: { type: 'integer', minimum: 0, maximum: 300 },
      },
      additionalProperties: false,
    },
    mutates: false,
  },
  pages: {
    description:
      "An import's pages, up to 200 rows at a time (path, state, item ID, reason), by state: done, exception, failed or queued. Page through with offset.",
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string' },
        importId,
        state: { type: 'string', enum: ['done', 'exception', 'failed', 'queued'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        offset: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    mutates: false,
  },
  revert: {
    description:
      "Take an import back out of Sitecore: every page it created, with its Data folder and datasources, moved to the Recycle Bin (restorable there). Pages built before the import, or that have items it didn't make, are left and listed. Only on the Director's decision (submit needs_decision first): it removes hundreds of pages. Give confirm: the importId, to say you mean it. Stop a running import first.",
    inputSchema: {
      type: 'object',
      properties: { template: { type: 'string' }, importId, confirm: { type: 'string' } },
      required: ['confirm'],
      additionalProperties: false,
    },
    mutates: true,
  },
  stop: {
    description: 'Stop an import; the pages written stay.',
    inputSchema: {
      type: 'object',
      properties: { template: { type: 'string' }, importId },
      additionalProperties: false,
    },
    mutates: false,
  },
};

/**
 * The bulk import, for agents: start it, follow it, list its pages. The writes themselves go
 * through the gateway as the task that started it (see TemplateImporter).
 */
export class ImportToolServer implements ToolServer {
  readonly name = 'import';
  readonly catalog = CATALOG;

  constructor(private readonly importer: TemplateImporter) {}

  target(projectId: string): string {
    return projectId;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    try {
      if (op === 'start') {
        const template = String(args.template ?? '');
        const { job, existing } = await this.importer.start(ctx.projectId, ctx.taskId, template, {
          retry: args.retry === true,
          role: ctx.role,
        });
        const c = await this.importer.store.counts(job.id);
        const total = Object.values(c).reduce((a, b) => a + b, 0);
        const lead =
          existing === 'running'
            ? `An import of ${template} is already running (${job.id}): follow it`
            : existing === 'paused'
              ? `The import of ${template} is paused (${job.id}): ${job.message ?? ''} Fix what it says, then import.start with retry: true`
              : existing === 'done'
                ? `${template} was imported already (${job.id}): ${c.done} pages, ${c.exception + c.failed} exceptions. Pass retry: true to try the exceptions again`
                : existing === 'retried'
                  ? `Retrying ${c.queued} pages of ${template} (${job.id})`
                  : `Importing ${total} pages of ${template} in the background (${job.id})`;
        return {
          code: existing ? 200 : 202,
          body: { importId: job.id, status: job.status, existing, pages: total },
          summary: `${lead}. Next: import.status with waitSeconds`,
        };
      }
      const job = await this.find(ctx.projectId, args);
      if (!job)
        return {
          code: 404,
          body: { error: 'No import found: start one with import.start' },
          summary: 'No import found',
        };
      if (op === 'status') {
        const wait = Math.min(300, Math.max(0, Number(args.waitSeconds) || 0)) * 1000;
        return this.status((await this.importer.wait(job.id, wait)) ?? job);
      }
      if (op === 'pages') {
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 100));
        const offset = Math.max(0, Number(args.offset) || 0);
        const state = typeof args.state === 'string' ? (args.state as PageState) : undefined;
        const rows = await this.importer.store.pages(job.id, {
          ...(state ? { states: [state] } : {}),
          limit: limit + 1,
          offset,
        });
        const page = rows.slice(0, limit);
        return {
          code: 200,
          body: {
            importId: job.id,
            offset,
            next: rows.length > limit ? offset + limit : null,
            pages: page.map((p) => ({
              path: p.path,
              state: p.state,
              ...(p.itemId ? { itemId: p.itemId } : {}),
              ...(p.reason ? { reason: p.reason } : {}),
            })),
          },
          summary: `${page.length} ${state ?? ''} pages of import ${job.id} from ${offset + 1}`,
        };
      }
      if (op === 'stop') return this.status((await this.importer.stop(job.id)) ?? job);
      if (op === 'revert') {
        if (args.confirm !== job.id)
          return {
            code: 422,
            body: { error: `Give confirm: "${job.id}" to revert import ${job.id}` },
            summary: `Revert not confirmed: confirm must be ${job.id}`,
          };
        const r = await this.importer.revert(job.id, ctx.role);
        return {
          code: 200,
          body: { importId: job.id, removed: r.removed, kept: r.kept },
          summary: `Reverted import ${job.id}: ${r.removed} pages moved to the Recycle Bin${r.kept.length ? `; ${r.kept.length} left (${r.kept.slice(0, 3).join('; ')})` : ''}`,
        };
      }
      return { code: 400, body: { error: `Unknown operation ${op}` } };
    } catch (err) {
      if (err instanceof ImportError)
        return { code: 422, body: { error: err.message }, summary: `Can't import: ${err.message}` };
      throw err;
    }
  }

  private async find(projectId: string, args: Record<string, unknown>): Promise<ImportJob | null> {
    if (typeof args.importId === 'string' && args.importId) {
      const j = await this.importer.store.get(args.importId);
      return j && j.projectId === projectId ? j : null;
    }
    return typeof args.template === 'string'
      ? this.importer.store.latest(projectId, args.template)
      : null;
  }

  private async status(job: ImportJob): Promise<ToolResult> {
    const store = this.importer.store;
    const c = await store.counts(job.id);
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const left = c.queued + c.inflight;
    const since = job.stats.writingSince ? Date.parse(job.stats.writingSince) : null;
    const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    const minutes = since ? Math.max((end - since) / 60_000, 1 / 60) : null;
    const perMinute = minutes ? Math.round((job.stats.written / minutes) * 10) / 10 : null;
    const eta = job.status === 'running' && perMinute && left ? Math.ceil(left / perMinute) : null;
    const off = await store.pages(job.id, { states: ['exception', 'failed'] });
    const reasons = new Map<string, { reason: string; count: number; examples: string[] }>();
    for (const p of off) {
      // Group by the reason's kind, not each page's own detail.
      const key = (p.reason ?? 'unknown').replace(/\/[^\s,:)]+/g, '…').slice(0, 160);
      const e = reasons.get(key) ?? { reason: key, count: 0, examples: [] };
      e.count++;
      if (e.examples.length < 3) e.examples.push(p.path);
      reasons.set(key, e);
    }
    const canary = job.stats.canary;
    const share = total ? Math.round(((c.exception + c.failed) / total) * 100) : 0;
    const body = {
      importId: job.id,
      template: job.template,
      status: job.status,
      pages: { total, written: c.done, exceptions: c.exception, failed: c.failed, left },
      uploads: job.stats.uploads,
      perMinute,
      etaMinutes: eta,
      exceptions: [...reasons.values()].sort((a, b) => b.count - a.count).slice(0, 12),
      ...(canary ? { canary } : {}),
      ...(job.message ? { message: job.message } : {}),
    };
    const head = `Import ${job.id} of ${job.template}`;
    const summary =
      job.status === 'paused'
        ? `${head}: paused. ${job.message ?? ''}`
        : job.status === 'reverted'
          ? `${head}: reverted. ${job.message ?? ''}`
          : job.status === 'running'
            ? `${head}: running, ${c.done} of ${total} pages written${perMinute ? ` (${perMinute}/min${eta ? `, about ${eta} min left` : ''})` : ''}; ${c.exception + c.failed} exceptions so far`
            : `${head}: ${job.status}, ${c.done} of ${total} pages written, ${c.exception + c.failed} exceptions (${share}%)${job.message ? `. ${job.message}` : ''}${
                share > 10
                  ? ". More than 1 in 10 pages don't fit: the mapping is likely wrong for them. Read the reasons, fix template-mapping, and retry, rather than building them one by one"
                  : c.exception + c.failed
                    ? '. Build each exception page yourself as you would any page (import.pages state exception lists them), or retry once what they wait on is done'
                    : ''
              }`;
    return { code: 200, body, summary };
  }
}
