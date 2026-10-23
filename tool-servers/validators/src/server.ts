import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  assertNavigable,
  BlockedUrlError,
  type GuardedBrowser,
  type UrlPolicy,
} from '@lw/tool-browser';
import type {
  BlobStore,
  OperationCatalog,
  ToolCallContext,
  ToolResult,
  ToolServer,
} from '@lw/tool-gateway';
import { z } from 'zod';
import { diffPngs } from './diff';
import { runLighthouse } from './lighthouse';

const axeSource = readFileSync(
  createRequire(import.meta.url).resolve('axe-core/axe.min.js'),
  'utf8',
);

const STANDARDS = {
  wcag2a: ['wcag2a'],
  wcag2aa: ['wcag2a', 'wcag2aa'],
  wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
} as const;

const AxeArgs = z.object({
  url: z.string(),
  standard: z.enum(Object.keys(STANDARDS) as [keyof typeof STANDARDS]).default('wcag22aa'),
});
const DiffArgs = z.object({
  baseline: z.string(),
  candidate: z.string(),
  threshold: z.number().min(0).max(1).default(0.1),
  tolerancePercent: z.number().min(0).max(100).default(0.5),
});
const LighthouseArgs = z.object({
  url: z.string(),
  formFactor: z.enum(['mobile', 'desktop']).default('mobile'),
});

const CATALOG: OperationCatalog = {
  'axe.run': {
    description:
      'Accessibility check of one page with axe-core against a WCAG level (default WCAG 2.2 AA): violations by rule with impact, the number of elements affected and example selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        standard: { type: 'string', enum: Object.keys(STANDARDS) },
      },
      required: ['url'],
      additionalProperties: false,
    },
    mutates: false,
    untrusted: true,
  },
  'visual.diff': {
    description:
      'Pixel comparison of two screenshots (blob references from browser.screenshot): percentage of differing pixels, pass/fail against a tolerance, and a stored diff image highlighting the differences.',
    inputSchema: {
      type: 'object',
      properties: {
        baseline: {
          type: 'string',
          description: 'blob:// reference of the source-site screenshot',
        },
        candidate: {
          type: 'string',
          description: 'blob:// reference of the migrated-site screenshot',
        },
        threshold: {
          type: 'number',
          description: 'Per-pixel colour sensitivity 0..1 (default 0.1)',
        },
        tolerancePercent: {
          type: 'number',
          description: 'Allowed differing pixels, % (default 0.5)',
        },
      },
      required: ['baseline', 'candidate'],
      additionalProperties: false,
    },
    mutates: false,
  },
  'lighthouse.run': {
    description:
      'Lighthouse audit of one page (mobile by default): performance, accessibility, best-practices and SEO scores out of 100, Core Web Vitals, and the failing audits that cost the most.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        formFactor: { type: 'string', enum: ['mobile', 'desktop'] },
      },
      required: ['url'],
      additionalProperties: false,
    },
    mutates: false,
    untrusted: true,
  },
};

export interface ValidatorsServerOptions {
  browser: GuardedBrowser;
  blobs: BlobStore;
  /** The hosts a project's pages may be checked on (source site, previews). */
  policy: (projectId: string) => UrlPolicy;
  navigationTimeoutMs?: number;
  /**
   * The platform's structural checks (site, templates, renderings), when the stack has them:
   * read-only looks at the target, judged against the Blueprint.
   */
  structural?: (
    projectId: string,
    scope: 'site' | 'templates' | 'renderings' | 'all',
  ) => Promise<{ id: string; status: 'pass' | 'fail' | 'pending'; detail: string }[]>;
}

const STRUCTURAL: OperationCatalog[string] = {
  description:
    "Check the project's structure in the CMS against the approved Blueprint: `site` (site, Home, the project's own folders), `templates` (each template with standard values), `renderings` (each rendering, offered in Available Renderings), or `all`. Read-only.",
  inputSchema: {
    type: 'object',
    properties: { scope: { type: 'string', enum: ['site', 'templates', 'renderings', 'all'] } },
    additionalProperties: false,
  },
  mutates: false,
};
const StructuralArgs = z.object({
  scope: z.enum(['site', 'templates', 'renderings', 'all']).default('all'),
});

const invalid = (e: z.ZodError): ToolResult => {
  const message = e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { code: 422, body: { error: message }, summary: message };
};

/** Quality checks the QA roles run: accessibility, visual parity, Lighthouse. */
export class ValidatorsToolServer implements ToolServer {
  readonly name = 'validators';
  readonly catalog: OperationCatalog;
  /** Lighthouse runs a whole browser; one at a time per worker keeps timings comparable. */
  private lighthouseQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ValidatorsServerOptions) {
    this.catalog = opts.structural ? { ...CATALOG, 'structural.run': STRUCTURAL } : CATALOG;
  }

  target(projectId: string): string {
    return this.opts.policy(projectId).allowedHosts[0] ?? projectId;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    try {
      switch (op) {
        case 'axe.run': {
          const a = AxeArgs.safeParse(args);
          return a.success ? await this.axe(ctx.projectId, a.data) : invalid(a.error);
        }
        case 'visual.diff': {
          const a = DiffArgs.safeParse(args);
          return a.success ? await this.diff(ctx.projectId, a.data) : invalid(a.error);
        }
        case 'lighthouse.run': {
          const a = LighthouseArgs.safeParse(args);
          if (!a.success) return invalid(a.error);
          const run = this.lighthouseQueue.then(() => this.lighthouse(ctx.projectId, a.data));
          this.lighthouseQueue = run.catch(() => {});
          return await run;
        }
        case 'structural.run': {
          const a = StructuralArgs.safeParse(args);
          if (!a.success) return invalid(a.error);
          if (!this.opts.structural) return { code: 404, body: { error: 'Not connected' } };
          const results = await this.opts.structural(ctx.projectId, a.data.scope);
          const count = (k: string) => results.filter((r) => r.status === k).length;
          return {
            code: 200,
            body: { results },
            summary: `Structure (${a.data.scope}): ${count('pass')} passed, ${count('fail')} failed, ${count('pending')} pending`,
          };
        }
        default:
          return { code: 400, body: { error: `Unknown operation ${op}` } };
      }
    } catch (err) {
      if (err instanceof BlockedUrlError)
        return { code: 403, body: { error: err.message }, summary: `Blocked: ${err.message}` };
      throw err;
    }
  }

  private async axe(projectId: string, a: z.infer<typeof AxeArgs>): Promise<ToolResult> {
    const policy = this.opts.policy(projectId);
    const url = await assertNavigable(a.url, policy);
    return this.opts.browser.withContext(policy, async (context) => {
      const page = await context.newPage();
      const response = await page.goto(url.toString(), {
        waitUntil: 'load',
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      });
      // Evaluated over the DevTools protocol, so the page's CSP doesn't block it.
      await page.evaluate(axeSource);
      const results = (await page.evaluate(
        `axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(STANDARDS[a.standard])} }, resultTypes: ['violations'] })`,
      )) as AxeResults;
      const violations = results.violations
        .map((v) => ({
          rule: v.id,
          impact: v.impact,
          help: v.help,
          helpUrl: v.helpUrl,
          elements: v.nodes.length,
          examples: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
        }))
        .sort((x, y) => IMPACT.indexOf(x.impact) - IMPACT.indexOf(y.impact));
      const counts = Object.fromEntries(
        IMPACT.map((i) => [i, violations.filter((v) => v.impact === i).length]),
      );
      return {
        code: response?.status() ?? 0,
        body: { url: page.url(), standard: a.standard, violations, counts },
        summary: violations.length
          ? `axe ${a.standard} on ${url.pathname}: ${violations.length} rules violated (${counts.critical} critical, ${counts.serious} serious)`
          : `axe ${a.standard} on ${url.pathname}: no violations`,
      };
    });
  }

  private async diff(projectId: string, a: z.infer<typeof DiffArgs>): Promise<ToolResult> {
    // Screenshots of one project are never compared with, or revealed to, another.
    const mine = `blob://${projectId}/`;
    for (const ref of [a.baseline, a.candidate]) {
      if (!ref.startsWith(mine))
        return { code: 403, body: { error: `${ref} is not one of this project's files` } };
    }
    let images: [Uint8Array, Uint8Array];
    try {
      images = [await this.opts.blobs.get(a.baseline), await this.opts.blobs.get(a.candidate)];
    } catch {
      return { code: 404, body: { error: 'Screenshot not found' } };
    }
    const d = diffPngs(images[0], images[1], a.threshold);
    if (!d) return { code: 422, body: { error: 'Both references must be PNG screenshots' } };
    const key = createHash('sha256')
      .update(`${a.baseline}|${a.candidate}|${a.threshold}`)
      .digest('hex');
    const diffRef = await this.opts.blobs.put(projectId, `diffs/${key}.png`, d.png, 'image/png');
    const pass = d.mismatchPercent <= a.tolerancePercent;
    return {
      code: 200,
      body: {
        mismatchPercent: d.mismatchPercent,
        tolerancePercent: a.tolerancePercent,
        pass,
        baseline: d.baseline,
        candidate: d.candidate,
        diffRef,
      },
      summary: `${pass ? 'Visual match' : 'Visual mismatch'}: ${d.mismatchPercent}% of pixels differ (tolerance ${a.tolerancePercent}%)`,
    };
  }

  private async lighthouse(
    projectId: string,
    a: z.infer<typeof LighthouseArgs>,
  ): Promise<ToolResult> {
    const policy = this.opts.policy(projectId);
    const url = await assertNavigable(a.url, policy);
    const r = await runLighthouse(url.toString(), a.formFactor, {
      chromePath: this.opts.browser.executablePath,
      proxyFlags: (await this.opts.browser.egress()).chromeFlags(),
    });
    if ('error' in r)
      return { code: 502, body: { error: r.error }, summary: `Lighthouse failed: ${r.error}` };
    // A redirect off the project's hosts means the report describes someone else's page.
    const finalHost = new URL(r.finalUrl).hostname.toLowerCase();
    if (!policy.allowedHosts.map((h) => h.toLowerCase()).includes(finalHost)) {
      return { code: 403, body: { error: `The page redirected to ${finalHost}` } };
    }
    const s = r.scores;
    return {
      code: 200,
      body: r,
      summary: `Lighthouse ${a.formFactor} ${url.pathname}: performance ${s.performance}, accessibility ${s.accessibility}, best practices ${s.bestPractices}, SEO ${s.seo}`,
    };
  }
}

const IMPACT = ['critical', 'serious', 'moderate', 'minor', null] as const;

interface AxeResults {
  violations: {
    id: string;
    impact: (typeof IMPACT)[number];
    help: string;
    helpUrl: string;
    nodes: { target: string[] }[];
  }[];
}
