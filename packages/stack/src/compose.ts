import { join } from 'node:path';
import {
  AgentRuntime,
  BlobCheckpoints,
  type ContextProvider,
  type DirectiveInput,
  type DirectiveReading,
  type ModelClient,
  type ReviewInput,
  type ReviewVerdict,
  type ScreenInput,
  type ScreenVerdict,
  type Triage,
  type TriageInput,
  type AttributeInput,
  type Attribution,
} from '@lw/agent-runtime';
import { autonomyFor } from '@lw/domain';
import type { EventStore, KnowledgeStore, Projections, RuleStore, SqlClient } from '@lw/events';
import {
  createStubActivities,
  loadFixtures,
  withAgentRunner,
  withLiveGuard,
  type Activities,
} from '@lw/orchestrator';
import { Blueprint, releaseApprovalId, type PlannedTask } from '@lw/plan';
import type { PlatformCheck, PlatformPack, ScreenComparison, ScreenPair } from '@lw/platforms';
import { selfCheck, withReview } from './review';
import { factsBrief } from './facts';
import { lessonsFor } from './knowledge';
import { blueprintEntries, leadTriageInput } from './lead-triage';
import { sliceScreenshot } from './screens';
import { loadRolePrompts, type Playbook } from '@lw/playbook-sdk';
import {
  BrowserToolServer,
  Crawler,
  GuardedBrowser,
  MemoryCrawlStore,
  PostgresCrawlStore,
  type UrlPolicy,
} from '@lw/tool-browser';
export { GuardedBrowser } from '@lw/tool-browser';
import {
  LocalBlobStore,
  MemoryIdempotencyStore,
  MemoryWriteLocks,
  TokenBucketLimiter,
  ToolGateway,
  type BlobStore,
  type CredentialProvider,
  type ToolServer,
} from '@lw/tool-gateway';
import { ValidatorsToolServer } from '@lw/tool-validators';
import {
  ImportToolServer,
  MemoryImportStore,
  TemplateImporter,
  type ImportCall,
  type ImportStore,
} from './import';
import {
  AcceptanceToolServer,
  ArtifactLibrary,
  ArtifactsToolServer,
  BlackboardToolServer,
  DecisionLogToolServer,
  FactsToolServer,
} from '@lw/tool-workspace';

export interface StackOptions {
  store: EventStore;
  /** Read models, for per-project facts (source site) the tool servers need. */
  projections: Projections;
  playbook: Playbook;
  playbookDir: string;
  /** The playbook's platform pack: scopes, target context and platform knowledge. */
  platform: PlatformPack;
  /** Working files (clones, builds). Blobs go under `${dataDir}/blobs` unless `blobs` is given. */
  dataDir: string;
  /** Where artifacts, screenshots and assets are kept; shared with the Control API. */
  blobs?: BlobStore;
  /** Claude, when configured. Without it every role runs on stub agents. */
  model?: ModelClient | null;
  /** Reads Director messages on live projects (Claude); without it, the simple reader is used. */
  directives?: ((input: DirectiveInput) => Promise<DirectiveReading>) | null;
  /** A Lead's review of each finished task on live projects (Claude); without it, checks only. */
  review?: ((input: ReviewInput) => Promise<ReviewVerdict & { tokens: number }>) | null;
  /** Sorts failed checks into a task's own work and its components' (the Lead's model). */
  attribute?: ((input: AttributeInput) => Promise<Attribution>) | null;
  /**
   * A Lead's triage of an agent's question on live projects (Claude), for the categories the
   * project lets a Lead decide or shadow; without it, every question reaches the Director.
   */
  triage?: ((input: TriageInput) => Promise<Triage>) | null;
  /** Rules from the Director's answers: triage shows the Lead the ones that cover a question. */
  rules?: RuleStore;
  /** The team's knowledge across projects: the lessons that apply go in each brief. */
  knowledge?: KnowledgeStore;
  /** Judges a migrated page against its source from screenshots (Claude); without it, the visual check is pending. */
  screens?: ((input: ScreenInput) => Promise<ScreenVerdict & { tokens: number }>) | null;
  /** Extra servers (tests); the browser and workspace servers are always connected. */
  servers?: ToolServer[];
  /** Credentials for tool calls (the vault-backed provider in the worker). */
  credentials?: CredentialProvider;
  /** A project credential's fields from the vault, for acceptance checks (Edge Context IDs). */
  credential?: (projectId: string, credentialId: string) => Promise<Record<string, string> | null>;
  /** Tests point the browser at a fixture site on 127.0.0.1. */
  allowPrivateNetworks?: boolean;
  /**
   * One Chromium for every stack in the process. Its owner closes it; without one, the stack
   * launches and closes its own.
   */
  browser?: GuardedBrowser;
  /**
   * Background crawls (browser.crawl.start), shared by every stack in the process so each crawl
   * runs once; see createCrawler. Without one, the stack keeps its crawls in memory.
   */
  crawler?: Crawler;
  /** Where bulk imports are kept (Postgres in the worker, so they resume); memory otherwise. */
  imports?: ImportStore;
}

/**
 * The hosts a project's browser may visit: its source site (both spellings: one usually
 * redirects to the other) and its new site, for visual QA and parity.
 */
export function sourcePolicy(
  projections: Projections,
  allowPrivateNetworks?: boolean,
): (projectId: string) => UrlPolicy {
  return (projectId) => {
    const s = projections.get(projectId);
    const url = s?.sourceUrl;
    const host = url ? new URL(url).hostname : null;
    return {
      allowedHosts: [
        ...(host ? [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`] : []),
        // The new site: its production URL, its fixed editing address, and the provider's other
        // addresses for it (team and per-deployment URLs).
        ...projectHosts(s?.hosting ?? null),
      ],
      allowPrivateNetworks,
    };
  };
}

/**
 * The process's background crawler: crawls kept in Postgres when there is one (they survive a
 * restart and any worker resumes them), in memory otherwise. Call `resumeAll()` once the worker
 * is up, and `shutdown()` when it stops.
 */
export function createCrawler(opts: {
  projections: Projections;
  browser: GuardedBrowser;
  sql?: SqlClient | null;
  allowPrivateNetworks?: boolean;
}): Crawler {
  return new Crawler({
    store: opts.sql ? new PostgresCrawlStore(opts.sql) : new MemoryCrawlStore(),
    browser: opts.browser,
    policy: sourcePolicy(opts.projections, opts.allowPrivateNetworks),
  });
}

export interface Stack {
  activities: Activities;
  /** Bulk imports of large sites' page templates: resume them once the worker is up. */
  importer: TemplateImporter;
  /** Roles running on real agents; the rest are stubs. */
  liveRoles: string[];
  gateway: ToolGateway;
  library: ArtifactLibrary;
  close(): Promise<void>;
}

/**
 * Each specialist role's granted operations that no connected tool server provides, as
 * "server.op". A role with any missing operation doesn't run on a live project: it blocks and
 * says what's missing, rather than running half-equipped.
 */
export function missingOps(playbook: Playbook, servers: ToolServer[]): Map<string, string[]> {
  const available = new Map(servers.map((s) => [s.name, s.catalog]));
  return new Map(
    playbook.roles
      .filter((r) => r.tier === 'specialist')
      .map((r) => [
        r.role,
        Object.entries(r.tools).flatMap(([server, grant]) =>
          grant.ops.filter((op) => !available.get(server)?.[op]).map((op) => `${server}.${op}`),
        ),
      ]),
  );
}

/**
 * What a task's role lacks (from `missingOps`), limited to the tool servers its template says it
 * uses: a task that needs none of the missing servers runs although its role isn't fully connected.
 */
export function missingForTask(
  playbook: Playbook,
  missing: Map<string, string[]>,
  task: Pick<PlannedTask, 'role' | 'templateId'>,
): string[] {
  const uses = playbook.plan.templates.find((t) => t.id === task.templateId)?.uses;
  return (missing.get(task.role) ?? []).filter((op) => !uses || uses.includes(op.split('.')[0]!));
}

/** Roles whose every granted operation is served by a connected tool server. */
export function liveRoles(playbook: Playbook, servers: ToolServer[]): string[] {
  return [...missingOps(playbook, servers)]
    .filter(
      ([role, missing]) => !missing.length && Object.keys(roleOf(playbook, role).tools).length,
    )
    .map(([role]) => role);
}

const roleOf = (playbook: Playbook, role: string) => playbook.roles.find((r) => r.role === role)!;

/**
 * The composition root for orchestration activities: tool servers behind the gateway, the agent
 * runtime for roles that can run live, stub agents for the rest, and the Blueprint read from the
 * blackboard once an agent has written one.
 */
export async function composeStack(opts: StackOptions): Promise<Stack> {
  const blobs = opts.blobs ?? new LocalBlobStore(join(opts.dataDir, 'blobs'));
  const library = new ArtifactLibrary(opts.store, blobs);
  // One Chromium behind one egress proxy for every browser-driven server.
  const chromium =
    opts.browser ?? new GuardedBrowser({ allowPrivateNetworks: opts.allowPrivateNetworks });
  const policy = sourcePolicy(opts.projections, opts.allowPrivateNetworks);
  // Acceptance checks read the project's systems, never change them.
  const readOnly = async (
    projectId: string,
    server: string,
    op: string,
    args: Record<string, unknown>,
  ) => {
    const s = servers.find((x) => x.name === server);
    const spec = s?.catalog[op];
    if (!s || !spec) return { code: 404, body: { error: `${server}.${op} isn't connected` } };
    if (spec.mutates) return { code: 403, body: { error: `${server}.${op} changes things` } };
    const token = await (opts.credentials ?? { tokenFor: async () => '' }).tokenFor(
      projectId,
      server,
    );
    return s.call(op, args, { projectId, token, role: 'quality-lead', taskId: 'acceptance' });
  };
  const credential = async (projectId: string, credentialId: string) =>
    opts.credential ? opts.credential(projectId, credentialId) : null;
  // The Quality Lead's model looks at the pages, as the client will.
  const judge =
    opts.playbook.roles.find((r) => r.role === 'quality-lead') ??
    opts.playbook.roles.find((r) => r.role === 'chief-of-staff');
  const screens = opts.screens;
  // What the last comparison of each page said, so the next one doesn't contradict it.
  const lastFindings = new Map<string, string[]>();
  /** Desktop screenshots of both pages, sliced, judged side by side. */
  const compareScreens =
    screens && judge
      ? async (projectId: string, page: ScreenPair): Promise<ScreenComparison> => {
          const shoot = async (url: string) => {
            const r = await readOnly(projectId, 'browser', 'screenshot', {
              url,
              breakpoints: ['desktop'],
            });
            const ref = (r.body as { shots?: { ref?: string }[] } | null)?.shots?.[0]?.ref;
            if (r.code !== 200 || !ref)
              throw new Error(`no screenshot of ${url} (${JSON.stringify(r.body).slice(0, 200)})`);
            return sliceScreenshot(await blobs.get(ref));
          };
          try {
            const [source, candidate] = await Promise.all([
              shoot(page.source),
              shoot(page.candidate),
            ]);
            // What the Director settled (a widget left out, a deliberate accessibility change)
            // is not a difference to report on every page again.
            const state = opts.projections.get(projectId);
            const accepted =
              (await opts.rules
                ?.matching({
                  projectId,
                  playbookId: state?.playbook?.id ?? opts.playbook.manifest.id,
                  platform: state?.intake?.platform ?? null,
                  category: 'scope',
                  role: judge.role,
                })
                .catch(() => [])) ?? [];
            const key = `${projectId}:${page.path}`;
            const verdict = await screens({
              path: page.path,
              source,
              candidate,
              model: judge.model.id,
              effort: judge.model.effort,
              accepted: [
                ...accepted.map((r) => `${r.ref}: when ${r.when} ${r.then}`),
                ...(await decidedForPage(projectId, page.path)),
              ],
              previous: lastFindings.get(key),
              measured: await measuredSections(projectId, page),
            });
            lastFindings.set(key, [...verdict.differences, ...(verdict.minor ?? [])]);
            return verdict;
          } catch (err) {
            return { error: (err as Error).message };
          }
        }
      : undefined;
  /**
   * What's already settled about a page, so a comparison doesn't report it again: forms made by
   * hand in SitecoreAI Forms (when the Blueprint keeps Form as the SDK's built-in), and the
   * Director's or rules' decisions that name the page.
   */
  async function decidedForPage(projectId: string, path: string): Promise<string[]> {
    const out: string[] = [];
    const doc = await library.read(projectId, 'blueprint').catch(() => null);
    try {
      const bp = doc ? (JSON.parse(doc.content) as Blueprint) : null;
      const builtInForm = (bp?.collections.components ?? []).some(
        (c) => c.status !== 'drop' && c.attrs?.builtIn === true && /\bform\b/i.test(c.name),
      );
      if (builtInForm)
        out.push(
          "Forms are made by hand in SitecoreAI Forms before UAT: a form that is missing or different isn't a difference to report.",
        );
    } catch {
      /* unreadable Blueprint: nothing settled from it */
    }
    if (path.length > 1) {
      const named = new RegExp(
        `(^|[\\s(:'"])${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s).,:;'"]|$)`,
      );
      const decisions = opts.projections.get(projectId)?.decisions ?? [];
      for (const d of decisions.filter((x) => x.decidedBy !== 'default').slice(-200))
        if (named.test(`${d.question} ${d.answer} ${d.rationale}`))
          out.push(`${d.ref}: ${d.question} → ${d.answer}. ${d.rationale}`.slice(0, 400));
    }
    return out.slice(-8);
  }

  /** Both pages' top-level sections as the browser measures them, for the judge to stand on. */
  async function measuredSections(
    projectId: string,
    page: ScreenPair,
  ): Promise<string | undefined> {
    const outline = async (url: string) => {
      const r = await readOnly(projectId, 'browser', 'page.markup', { url });
      const sections =
        (r.body as { sections?: { tag: string; headings: string[]; backgrounds?: string[] }[] })
          ?.sections ?? [];
      if (r.code !== 200 || !sections.length) return null;
      return sections
        .map(
          (s, i) =>
            `${i + 1}. ${s.tag}${s.headings.length ? ` (${s.headings.slice(0, 3).join(' | ')})` : ''}${s.backgrounds?.length ? ' [background image]' : ''}`,
        )
        .join('; ');
    };
    try {
      const [a, b] = await Promise.all([outline(page.source), outline(page.candidate)]);
      return a && b ? `Measured sections, in order. Source: ${a}. New page: ${b}.` : undefined;
    } catch {
      return undefined;
    }
  }

  /** One of the platform's checks, with the project's target, Blueprint and read access. */
  const runPlatformCheck = async (projectId: string, check: PlatformCheck) => {
    await opts.projections.catchUp(projectId);
    const intake = opts.projections.get(projectId)?.intake;
    if (!intake) return { status: 'pending' as const, detail: 'The project has no target.' };
    const doc = await library.read(projectId, 'blueprint');
    let blueprint = null;
    try {
      blueprint = doc ? JSON.parse(doc.content) : null;
    } catch {
      /* unreadable: the check sees none */
    }
    return check({
      projectId,
      target: intake.target,
      // The validators check the whole Blueprint.
      scope: { collection: null, items: [] },
      blueprint,
      read: (server, op, args) => readOnly(projectId, server, op, args),
      credential: (id) => credential(projectId, id),
      compareScreens: compareScreens && ((page) => compareScreens(projectId, page)),
      document: async (id) => {
        const d = await library.read(projectId, id);
        try {
          return d ? (JSON.parse(d.content) as unknown) : null;
        } catch {
          return null;
        }
      },
    });
  };
  // How the platform's checks reach the project's systems: for the Lead's review and self-checks.
  const platformAccess = {
    checks: opts.platform.checks,
    read: readOnly,
    credential,
    compareScreens,
  };
  // The task each agent session is running, so its self-check knows what to run.
  const running = new Map<string, PlannedTask>();
  const selfChecks = new Map<string, number>();
  const SELF_CHECKS = 3;
  const runChecks = selfCheck({
    store: opts.store,
    projections: opts.projections,
    playbook: opts.playbook,
    library,
    platform: platformAccess,
  });
  // Hosts the project's documents point media at, by the documents' versions.
  const hostsSeen = new Map<string, { key: string; hosts: string[] }>();
  const STRUCTURE = ['site', 'templates', 'renderings'] as const;
  const browserServer = new BrowserToolServer({
    blobs,
    policy,
    browser: chromium,
    crawler: opts.crawler,
    assetHosts: (projectId) => assetHosts(opts.projections, library, projectId, hostsSeen),
    // Pages the Director saved from their own browser (.mhtml): read before the live site.
    captures: async (projectId) =>
      (opts.projections.get(projectId)?.files ?? [])
        .filter((f) => isSavedPage(f.name, f.contentType))
        .map((f) => ({ ref: f.ref, name: f.name })),
    // The source site's pages are read once and reused for six hours; the new site's never.
    sourceHosts: (projectId) => {
      const url = opts.projections.get(projectId)?.sourceUrl;
      if (!url) return [];
      const host = new URL(url).hostname;
      return [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`];
    },
  });
  // Bulk imports write through the gateway as the task that started them; it exists below.
  let gatewayRef: ToolGateway | null = null;
  const importCall: ImportCall = async (projectId, role, taskId, stepIndex, server, op, args) => {
    const r = await gatewayRef!.call({
      projectId,
      taskId,
      stepIndex,
      attempt: 0,
      role,
      server,
      op,
      args,
    });
    if (r.ok) {
      const b = r.body as { untrusted?: boolean; content?: unknown } | null;
      return { ok: true, code: r.code, body: b?.untrusted ? b.content : r.body };
    }
    if ('denied' in r)
      return {
        ok: false,
        code: 403,
        body: null,
        message: r.message,
        retryable: r.denied === 'locked',
      };
    return { ok: false, code: r.code, body: null, message: r.message, retryable: r.retryable };
  };
  const importer = new TemplateImporter({
    store: opts.imports ?? new MemoryImportStore(),
    crawls: browserServer.crawler.store,
    browser: chromium,
    policy,
    call: importCall,
    blueprint: async (projectId) => {
      const doc = await library.read(projectId, 'blueprint').catch(() => null);
      try {
        return doc ? (JSON.parse(doc.content) as Blueprint) : null;
      } catch {
        return null;
      }
    },
    document: async (projectId, artifactId) => {
      const doc = await library.read(projectId, artifactId).catch(() => null);
      try {
        return doc ? JSON.parse(doc.content) : null;
      } catch {
        return null;
      }
    },
    report: async (projectId, template, content) => {
      await library.write(projectId, {
        artifactId: `template-import-${template}`,
        kind: 'report',
        title: `Bulk import: ${template}`,
        format: 'json',
        content: JSON.stringify(content, null, 2),
        producer: 'content-migrator',
        summary: null,
        audience: 'team',
      });
    },
    sitePath: (projectId) => {
      const i = opts.projections.get(projectId)?.intake;
      return i ? (opts.platform.bindings(i.target).sitePath ?? null) : null;
    },
    // The canary pages through the platform's page checks: they render, and show the source's text.
    verify: async (projectId, paths) => {
      const checks = opts.platform.checks;
      if (!checks) return null;
      const out: { id: string; status: 'pass' | 'fail' | 'pending'; detail: string }[] = [];
      for (const id of ['head.pages-render', 'parity.render']) {
        const check = checks[id];
        if (!check) continue;
        const r = await runPlatformCheck(projectId, (ctx) =>
          check({
            ...ctx,
            blueprint: {
              collections: {
                ...(ctx.blueprint?.collections ?? {}),
                pages: paths.map((path, i) => ({
                  key: `canary-${i}`,
                  name: path,
                  attrs: { path },
                })),
              },
            },
          }),
        );
        out.push({ id, status: r.status, detail: r.detail });
      }
      return out;
    },
  });
  const servers: ToolServer[] = [
    browserServer,
    new ImportToolServer(importer),
    new ValidatorsToolServer({
      blobs,
      policy,
      browser: chromium,
      structural: opts.platform.checks
        ? async (projectId, scope) => {
            const ids = scope === 'all' ? STRUCTURE : [scope];
            const out = [];
            for (const id of ids) {
              const check = opts.platform.checks?.[`structural.${id}`];
              try {
                const r = check
                  ? await runPlatformCheck(projectId, check)
                  : { status: 'pending' as const, detail: 'No check for this platform.' };
                out.push({ id: `structural.${id}`, ...r });
              } catch (err) {
                out.push({
                  id: `structural.${id}`,
                  status: 'pending' as const,
                  detail: `Could not run: ${(err as Error).message}`,
                });
              }
            }
            return out;
          }
        : undefined,
      parity: opts.platform.checks?.['parity.page']
        ? (projectId) => runPlatformCheck(projectId, opts.platform.checks!['parity.page']!)
        : undefined,
    }),
    new ArtifactsToolServer(library),
    new BlackboardToolServer(library),
    new DecisionLogToolServer((id) => opts.projections.get(id)?.decisions ?? []),
    new FactsToolServer({
      facts: async (projectId) => {
        await opts.projections.catchUp(projectId);
        return Object.values(opts.projections.get(projectId)?.facts ?? {});
      },
      publish: async (projectId, fact, ctx) => {
        await opts.store.append(projectId, [
          {
            type: 'fact.published',
            actor: { kind: 'agent', id: ctx.role },
            subject: { kind: 'task', id: ctx.taskId },
            severity: 'routine',
            data: { ...fact, taskId: ctx.taskId, by: ctx.role, source: 'agent' },
          },
        ]);
      },
    }),
    new AcceptanceToolServer(async (projectId, taskId) => {
      const key = `${projectId}:${taskId}`;
      const task = running.get(key);
      if (!task) return null;
      // Checks can take screenshots and a model's look: a few runs per session, then the review.
      const n = (selfChecks.get(key) ?? 0) + 1;
      selfChecks.set(key, n);
      if (n > SELF_CHECKS)
        return [
          {
            id: 'self-check',
            status: 'pending',
            detail: `Already checked ${SELF_CHECKS} times this session; submit, and your Lead's review runs the checks.`,
          },
        ];
      return runChecks(projectId, task);
    }),
    ...(opts.servers ?? []),
  ];
  // One writer per item; a task's locks go when its result is accepted.
  const locks = new MemoryWriteLocks();
  const gateway = new ToolGateway({
    playbook: opts.playbook,
    servers,
    // Scope placeholders, from the project's intake: what this project owns.
    bindings: (projectId): Record<string, string> => {
      const i = opts.projections.get(projectId)?.intake;
      return i ? opts.platform.bindings(i.target) : {};
    },
    credentials: opts.credentials ?? { tokenFor: async () => 'no-external-credential' },
    idempotency: new MemoryIdempotencyStore(),
    rollback: { hasRecipe: async () => false },
    locks,
    // A release runs only after the Director approved its checkpoint.
    releases: {
      approved: async (projectId, taskId) => {
        await opts.projections.catchUp(projectId);
        return opts.projections.get(projectId)?.tasks[releaseApprovalId(taskId)]?.state === 'done';
      },
    },
    limiter: new TokenBucketLimiter(10, 5),
    store: opts.store,
    // What a create made (a rendering's ID, a page's item), for later tasks to look up.
    facts: (call, body) => {
      const i = opts.projections.get(call.projectId)?.intake;
      return i && opts.platform.facts ? opts.platform.facts(call, body, i.target) : [];
    },
  });
  gatewayRef = gateway;

  const { blueprint: fixture, outputs } = await loadFixtures(opts.playbookDir);
  const stubs = createStubActivities({
    store: opts.store,
    playbook: opts.playbook,
    blueprint: fixture,
    outputs,
  });
  // A real engagement: created by the New Project wizard, so it has intake facts. Projects started
  // directly (tests, the local sample project) keep the stand-ins.
  const isLive = async (projectId: string) => {
    await opts.projections.catchUp(projectId);
    const s = opts.projections.get(projectId);
    return s?.mode === 'live' && s.intake !== null;
  };
  const base: Activities = {
    ...stubs,
    async standingApproval(req) {
      await opts.projections.catchUp(req.projectId);
      const chosen = opts.projections.get(req.projectId)?.settings.standingApprovals;
      return Array.isArray(chosen) && chosen.includes(req.release);
    },
    async finishPastLimit(req) {
      await opts.projections.catchUp(req.projectId);
      return opts.projections.get(req.projectId)?.settings.finishPastLimit !== false;
    },
    async triage(req) {
      const ask = { level: 'ask' as const, tokens: 0, usd: 0 };
      if (!(await isLive(req.projectId))) return ask;
      const s = opts.projections.get(req.projectId)!;
      const level = autonomyFor(s, req.category, opts.playbook.manifest.defaults.autonomy);
      if (level === 'ask' || level === 'agents') return { level, tokens: 0, usd: 0 };
      if (!opts.triage) return ask;
      const built = await leadTriageInput(
        { playbook: opts.playbook, library, rules: opts.rules, knowledge: opts.knowledge },
        s,
        req,
      );
      if (!built) return ask;
      const { byRef } = built;
      const r = await opts.triage(built.input);
      const who = { leadId: built.lead.role, leadName: built.lead.name };
      if (r.decision === 'answer') {
        const ruleIds = r.ruleIds.map((ref) => byRef.get(ref)).filter((id): id is string => !!id);
        // A rule that settled a question has been applied; in shadow the Director's answer tells.
        if (level === 'lead')
          for (const id of ruleIds)
            await opts.rules
              ?.applied(id, { projectId: req.projectId, escalationId: `task:${req.taskId}` })
              .catch(() => undefined);
        return { level, ...who, ...r, ruleIds };
      }
      return {
        level,
        ...who,
        decision: 'forward',
        reasoning: r.reasoning,
        tokens: r.tokens,
        usd: r.usd,
      };
    },
    async interpretDirective(req) {
      if (!opts.directives || !(await isLive(req.projectId))) return stubs.interpretDirective(req);
      const items = Object.entries(req.blueprint?.collections ?? {}).flatMap(([collection, list]) =>
        list.map((i) => ({ collection, key: i.key, name: i.name, status: i.status })),
      );
      try {
        const r = await opts.directives({
          text: req.text,
          items,
          tasks: req.tasks ?? [],
          cards: req.cards ?? [],
          roles: req.roles ?? [],
        });
        if (r.kind === 'status') return { kind: 'status' };
        if (r.kind === 'answer')
          return { kind: 'answer', interpretation: r.interpretation, answers: r.answers };
        if (r.kind === 'add')
          return {
            kind: 'add',
            interpretation: r.interpretation,
            task: { ...r.task, after: r.task.after || null },
          };
        if (r.kind === 'rerun')
          return {
            kind: 'rerun',
            interpretation: r.interpretation,
            taskIds: r.rerun,
            notes: r.notes,
          };
        if (r.kind === 'note' || !req.blueprint)
          return { kind: 'note', interpretation: r.interpretation };
        const drop = new Set(r.drop);
        return {
          kind: 'replan',
          interpretation: r.interpretation,
          blueprint: {
            version: req.blueprint.version,
            collections: Object.fromEntries(
              Object.entries(req.blueprint.collections).map(([name, list]) => [
                name,
                list.map((i) => (drop.has(i.key) ? { ...i, status: 'drop' as const } : i)),
              ]),
            ),
          },
        };
      } catch (err) {
        console.error('Directive reading failed; using the simple reader', err);
        return stubs.interpretDirective(req);
      }
    },
    // Once an agent has written a Blueprint, that is the plan of record. A live project never
    // falls back to the playbook's example: without one, the plan is empty.
    async loadBlueprint(projectId) {
      const written = await library.read(projectId, 'blueprint');
      if (written) return Blueprint.parse(JSON.parse(written.content));
      return (await isLive(projectId))
        ? { version: 1, collections: {} }
        : stubs.loadBlueprint(projectId);
    },
  };

  const live = opts.model ? liveRoles(opts.playbook, servers) : [];
  const missing = missingOps(opts.playbook, servers);
  const missingFor = (task: PlannedTask) => missingForTask(opts.playbook, missing, task);
  /** A task runs on Claude when everything it uses is connected, even if its role isn't fully. */
  const runsLive = (task: PlannedTask) =>
    live.includes(task.role) ||
    (!!opts.model &&
      Object.keys(roleOf(opts.playbook, task.role).tools).length > 0 &&
      !missingFor(task).length);
  const prompts = await loadRolePrompts(opts.playbookDir, opts.playbook, [
    opts.platform.knowledgeDir,
  ]);
  const agents = opts.model
    ? withAgentRunner(
        base,
        new AgentRuntime({
          model: opts.model,
          gateway,
          playbook: opts.playbook,
          store: opts.store,
          context: projectContext(opts.projections, opts.platform),
          board: (projectId, task) => teamBoard(opts.projections, projectId, task.taskId),
          items: (projectId, task) => blueprintEntries(library, projectId, task),
          facts: (projectId, task) => factsBrief(opts.projections, projectId, task),
          lessons: opts.knowledge
            ? (projectId, task) =>
                lessonsFor(
                  {
                    knowledge: opts.knowledge!,
                    projections: opts.projections,
                    store: opts.store,
                    playbook: opts.playbook,
                  },
                  projectId,
                  task,
                )
            : undefined,
          prompt: (role) => prompts[role.role] ?? null,
          // The source repository's tools, on a project built from its live site alone.
          // Caught up first: a read model that is behind shows no intake, and GitHub stayed on offer.
          unavailable: async (projectId) => {
            await opts.projections.catchUp(projectId);
            const intake = opts.projections.get(projectId)?.intake;
            return intake && !intake.repo ? ['github'] : [];
          },
        }),
        runsLive,
        // Each turn is saved with the artifacts, so a session survives its worker (a deploy).
        { checkpoints: new BlobCheckpoints(blobs) },
      )
    : base;
  // Locks keep two sessions off the same item at once; a session that ended holds nothing, so
  // a task that escalated can't block the others (every registration shares the toolbox item).
  const sessions: Activities = {
    ...agents,
    async runAgent(req) {
      const key = `${req.projectId}:${req.task.taskId}`;
      running.set(key, req.task);
      selfChecks.delete(key);
      try {
        const done = await agents.runAgent(req);
        // This attempt won't run again: its replayable results only hold memory now.
        await gateway.forget(req.projectId, req.task.taskId, req.attempt);
        return done;
      } finally {
        running.delete(key);
        selfChecks.delete(key);
        await locks.release(req.projectId, req.task.taskId);
      }
    },
  };
  // Done means checked: automated checks, then the Lead's review of what was actually done.
  const reviewed = withReview(sessions, {
    store: opts.store,
    projections: opts.projections,
    library,
    playbook: opts.playbook,
    isLive,
    review: opts.review ?? null,
    attribute: opts.attribute ?? null,
    effect: (server, op) => {
      const spec = servers.find((x) => x.name === server)?.catalog[op];
      return !spec ? null : spec.releases ? 'release' : spec.mutates ? 'write' : 'read';
    },
    onAccepted: (projectId, taskId) => locks.release(projectId, taskId),
    platform: platformAccess,
  });
  const activities = withLiveGuard(reviewed, {
    store: opts.store,
    isLive,
    // Without Claude, nothing is connected: every specialist task on a live project blocks.
    missing: (task) =>
      runsLive(task) ? [] : opts.model ? missingFor(task) : ['model.claude (AGENTS=claude)'],
    roleName: (role) => roleOf(opts.playbook, role)?.name ?? role,
  });

  return {
    activities,
    importer,
    liveRoles: live,
    gateway,
    library,
    close: async () => {
      // Its own crawler, if it made one, lets go of its crawls; a shared one is its owner's.
      await importer.shutdown();
      await browserServer.close();
      if (!opts.browser) await chromium.close();
    },
  };
}

/**
 * Hosts the project's own records (the Blueprint and the inventories) point media at, such as an
 * uploads CDN: a media download may come from them as well as from the source site.
 */
async function assetHosts(
  projections: Projections,
  library: ArtifactLibrary,
  projectId: string,
  seen: Map<string, { key: string; hosts: string[] }>,
) {
  await projections.catchUp(projectId);
  const docs = Object.values(projections.get(projectId)?.artifacts ?? {}).filter((a) =>
    ['blueprint', 'inventory'].includes(a.kind),
  );
  // The same documents at the same versions name the same hosts: read them again only when one
  // changes (every media download asks).
  const key = docs.map((a) => `${a.artifactId}@${a.latest}`).join('|');
  const known = seen.get(projectId);
  if (known?.key === key) return [...known.hosts];
  const hosts = new Set<string>();
  for (const a of docs) {
    const d = await library.read(projectId, a.artifactId);
    for (const h of hostsNamedIn(d?.content ?? '')) hosts.add(h);
  }
  seen.set(projectId, { key, hosts: [...hosts] });
  return [...hosts];
}

/**
 * Hosts a document points at: full URLs, URLs encoded in another (`/_next/image?url=https%3A…`),
 * and hosts written without a scheme before a path (`edge.sitecorecloud.io/acme/media/…`).
 */
export function hostsNamedIn(text: string): string[] {
  const decoded = text.replace(/%3A/gi, ':').replace(/%2F/gi, '/');
  const hosts = new Set<string>();
  for (const m of decoded.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/:"'\s?#]|$)/gi))
    hosts.add(m[1]!.toLowerCase());
  for (const m of decoded.matchAll(/(?<![\w.@/-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?=\/[\w%~-])/gi))
    hosts.add(m[1]!.toLowerCase());
  return [...hosts];
}

/**
 * The project's own new site on its hosting provider. Vercel serves a project at its production
 * alias, `<project>-editing` (the integration build), `<project>-<team>` and one address per
 * deployment, all on vercel.app and all starting with the project's name (cut to fit a label):
 * those are matched by a prefix pattern no other project's addresses share.
 */
export function projectHosts(hosting: { project: string; url: string | null } | null): string[] {
  if (!hosting) return [];
  const out: string[] = [];
  if (hosting.url) {
    try {
      out.push(new URL(hosting.url).hostname);
    } catch {
      /* not a URL */
    }
  }
  const name = hosting.project.toLowerCase();
  out.push(`${name}-editing.vercel.app`);
  // Long names are cut in generated addresses; the first 24 characters still identify it.
  if (name.length >= 8) out.push(`${name.slice(0, 24)}*.vercel.app`);
  return out;
}

/**
 * The team plan as a task sees it: every other unfinished task, with its owner and state, so an
 * agent that needs something not made yet can name the task it waits on; then the finished
 * tasks, so it can send work back to the task that made it.
 */
async function teamBoard(projections: Projections, projectId: string, taskId: string) {
  await projections.catchUp(projectId);
  const tasks = Object.values(projections.get(projectId)?.tasks ?? {})
    .filter((t) => t.kind === 'work' && t.taskId !== taskId)
    .sort((a, b) => a.phase - b.phase);
  const open = tasks.filter((t) => !['done', 'cancelled', 'rolled_back'].includes(t.state));
  const done = tasks.filter((t) => t.state === 'done');
  if (!open.length && !done.length) return null;
  const list = (ts: typeof tasks, line: (t: (typeof tasks)[number]) => string, cap: number) => [
    ...ts.slice(0, cap).map(line),
    ...(ts.length > cap ? [`- and ${ts.length - cap} more`] : []),
  ];
  return [
    'Unfinished:',
    ...(open.length
      ? list(open, (t) => `- ${t.taskId} · ${t.title} · ${t.role} · ${t.state}`, 150)
      : ['- none']),
    'Finished (send work back to these by id):',
    ...(done.length
      ? list(done, (t) => `- ${t.taskId} · ${t.title} · ${t.role}`, 250)
      : ['- none']),
  ].join('\n');
}

/** What every agent is told about the project: its source site and the documents so far. */
/**
 * What the Director told the team in the project's conversation (Cypher records each message as a
 * Decision Log entry): every agent starts its task with the latest notes, in the Director's own
 * words, so "the site was renamed" or "skip the careers video" reaches the work and not only the
 * log. Newest last; a later note wins over an earlier one it contradicts.
 */
export function directorNotes(
  decisions: {
    ref: string;
    question: string;
    decidedBy: string;
    scopeKey: string;
    escalationId: string | null;
    ts: string;
  }[],
  max = 10,
): string[] {
  const notes = decisions
    .filter(
      (d) => d.decidedBy === 'director' && !d.escalationId && d.scopeKey.startsWith('directive:'),
    )
    .slice(-max);
  if (!notes.length) return [];
  const clip = (t: string) => (t.length > 600 ? `${t.slice(0, 599)}…` : t);
  return [
    `The Director's notes for this project (newest last; they override documents written before them, and a later note wins over an earlier one):\n${notes
      .map(
        (d) =>
          `- ${d.ref} (${d.ts.slice(0, 16).replace('T', ' ')} UTC): ${clip(d.question.trim())}`,
      )
      .join('\n')}`,
  ];
}

/**
 * The files the Director gave the team, for every agent: what each is, and the ref to use. An
 * image or file for the site goes to media.upload with this ref (and a fileName), the same way a
 * downloaded asset does.
 */
export function attachedFiles(
  files: { name: string; contentType: string; bytes: number; ref: string; note: string | null }[],
): string[] {
  if (!files.length) return [];
  return [
    `Files the Director gave the team (use them instead of asking for them again; for the site's media, give media.upload the ref with fileName):\n${files
      .slice(-20)
      .map(
        (f) =>
          `- ${f.name} (${f.contentType}, ${Math.max(1, Math.round(f.bytes / 1024))} KB): ref ${f.ref}${f.note ? `. ${f.note}` : ''}`,
      )
      .join('\n')}`,
  ];
}

export function projectContext(projections: Projections, platform: PlatformPack): ContextProvider {
  return {
    async forTask(projectId) {
      const s = projections.get(projectId);
      const docs = Object.values(s?.artifacts ?? {})
        .filter((a) => a.versions.some((v) => v.ref))
        .map((a) => `- ${a.artifactId} (${a.kind}): ${a.title}, v${a.latest}`);
      return [
        `Project: ${s?.name ?? projectId} for ${s?.client ?? 'the client'}.`,
        `Source site: ${s?.sourceUrl ?? 'not given at intake'}.`,
        ...(s?.intake?.repo
          ? [`Source repository: ${s.intake.repo} (branch ${s.intake.branch ?? 'main'}).`]
          : []),
        ...(s?.intake ? platform.context(s.intake.target) : []),
        ...(s?.brief.length
          ? [
              `The client's brief (agreed at intake; acceptance is measured against it):\n${s.brief.map((b) => `- ${b.label} ${b.answer}`).join('\n')}`,
            ]
          : []),
        s?.buildRepo
          ? `Build repository: ${s.buildRepo.repo}, created from ${s.buildRepo.template}; the site's Next.js app is in ${s.buildRepo.appPath}. Read it with build-repo tools and commit only to launchworks/* branches; never commit to the source repository.`
          : 'Build repository: not created yet.',
        // Before the release, the migration is what the editing host renders (the integration
        // branch with preview content); production runs the default branch until the release.
        ...(s?.hosting
          ? [
              `Migrated site, to review and compare before the release: https://${s.hosting.project}-editing.vercel.app (the editing host: launchworks/integration with preview content). Screenshot and judge pages here.`,
              s.hosting.url
                ? `Production: ${s.hosting.url} (Vercel project ${s.hosting.project}). It runs the default branch and shows the migration only after the release deploys it, so don't judge the migration on it before then.`
                : `Production: Vercel project ${s.hosting.project} exists; nothing is deployed to production yet.`,
            ]
          : ['Migrated site: none deployed yet.']),
        ...(s?.preview.target?.url && s.preview.target.url !== s.hosting?.url
          ? [`Latest preview deployment: ${s.preview.target.url} (${s.preview.target.label}).`]
          : []),
        docs.length
          ? `Documents you can read with artifacts.read:\n${docs.join('\n')}`
          : 'No documents written yet.',
        ...directorNotes(s?.decisions ?? []),
        ...attachedFiles(s?.files ?? []),
      ].join('\n');
    },
  };
}

/** A page saved from a browser as one file ("Webpage, Single File"): MHTML. */
export function isSavedPage(name: string, contentType: string): boolean {
  return /\.mht(ml)?$/i.test(name) || /multipart\/related|message\/rfc822|mhtml/i.test(contentType);
}
