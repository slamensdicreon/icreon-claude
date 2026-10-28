import { join } from 'node:path';
import {
  AgentRuntime,
  type ContextProvider,
  type DirectiveInput,
  type DirectiveReading,
  type ModelClient,
  type ReviewInput,
  type ReviewVerdict,
  type ScreenInput,
  type ScreenVerdict,
} from '@lw/agent-runtime';
import type { EventStore, Projections } from '@lw/events';
import {
  createStubActivities,
  loadFixtures,
  withAgentRunner,
  withLiveGuard,
  type Activities,
} from '@lw/orchestrator';
import { Blueprint, releaseApprovalId, type PlannedTask } from '@lw/plan';
import type { PlatformCheck, PlatformPack, ScreenComparison, ScreenPair } from '@lw/platforms';
import { withReview } from './review';
import { sliceScreenshot } from './screens';
import { loadRolePrompts, type Playbook } from '@lw/playbook-sdk';
import { BrowserToolServer, GuardedBrowser, type UrlPolicy } from '@lw/tool-browser';
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
  ArtifactLibrary,
  ArtifactsToolServer,
  BlackboardToolServer,
  DecisionLogToolServer,
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
}

export interface Stack {
  activities: Activities;
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
  const chromium = new GuardedBrowser({ allowPrivateNetworks: opts.allowPrivateNetworks });
  const policy = (projectId: string): UrlPolicy => {
    const s = opts.projections.get(projectId);
    const url = s?.sourceUrl;
    const host = url ? new URL(url).hostname : null;
    return {
      allowedHosts: [
        // The site and its www form: one usually redirects to the other.
        ...(host ? [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`] : []),
        // The new site, for visual QA and parity: its production URL, its fixed editing address,
        // and the provider's other addresses for it (team and per-deployment URLs).
        ...projectHosts(s?.hosting ?? null),
      ],
      allowPrivateNetworks: opts.allowPrivateNetworks,
    };
  };
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
            return await screens({
              path: page.path,
              source,
              candidate,
              model: judge.model.id,
              effort: judge.model.effort,
            });
          } catch (err) {
            return { error: (err as Error).message };
          }
        }
      : undefined;
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
  const STRUCTURE = ['site', 'templates', 'renderings'] as const;
  const servers: ToolServer[] = [
    new BrowserToolServer({
      blobs,
      policy,
      browser: chromium,
      assetHosts: (projectId) => assetHosts(opts.projections, library, projectId),
    }),
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
  });

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
    async interpretDirective(req) {
      if (!opts.directives || !(await isLive(req.projectId))) return stubs.interpretDirective(req);
      const items = Object.entries(req.blueprint?.collections ?? {}).flatMap(([collection, list]) =>
        list.map((i) => ({ collection, key: i.key, name: i.name, status: i.status })),
      );
      try {
        const r = await opts.directives({ text: req.text, items, tasks: req.tasks ?? [] });
        if (r.kind === 'status') return { kind: 'status' };
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
          prompt: (role) => prompts[role.role] ?? null,
        }),
        runsLive,
      )
    : base;
  // Locks keep two sessions off the same item at once; a session that ended holds nothing, so
  // a task that escalated can't block the others (every registration shares the toolbox item).
  const sessions: Activities = {
    ...agents,
    async runAgent(req) {
      try {
        return await agents.runAgent(req);
      } finally {
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
    effect: (server, op) => {
      const spec = servers.find((x) => x.name === server)?.catalog[op];
      return !spec ? null : spec.releases ? 'release' : spec.mutates ? 'write' : 'read';
    },
    onAccepted: (projectId, taskId) => locks.release(projectId, taskId),
    platform: { checks: opts.platform.checks, read: readOnly, credential, compareScreens },
  });
  const activities = withLiveGuard(reviewed, {
    store: opts.store,
    isLive,
    // Without Claude, nothing is connected: every specialist task on a live project blocks.
    missing: (task) =>
      runsLive(task) ? [] : opts.model ? missingFor(task) : ['model.claude (AGENTS=claude)'],
    roleName: (role) => roleOf(opts.playbook, role)?.name ?? role,
  });

  return { activities, liveRoles: live, gateway, library, close: () => chromium.close() };
}

/**
 * Hosts the project's own records (the Blueprint and the inventories) point media at, such as an
 * uploads CDN: a media download may come from them as well as from the source site.
 */
async function assetHosts(projections: Projections, library: ArtifactLibrary, projectId: string) {
  await projections.catchUp(projectId);
  const docs = Object.values(projections.get(projectId)?.artifacts ?? {}).filter((a) =>
    ['blueprint', 'inventory'].includes(a.kind),
  );
  const hosts = new Set<string>();
  for (const a of docs) {
    const d = await library.read(projectId, a.artifactId);
    for (const m of d?.content.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/:"'\s?#]|$)/gi) ??
      [])
      hosts.add(m[1]!.toLowerCase());
  }
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

/** The approved Blueprint's entries for a task's items, as JSON for its brief (capped). */
async function blueprintEntries(
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
function projectContext(projections: Projections, platform: PlatformPack): ContextProvider {
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
        s?.hosting?.url
          ? `Migrated preview site: ${s.hosting.url} (Vercel project ${s.hosting.project}; also the editing host once registered).`
          : s?.hosting
            ? `Migrated preview site: Vercel project ${s.hosting.project} exists; nothing is deployed to production yet.`
            : 'Migrated preview site: none deployed yet.',
        ...(s?.preview.target?.url && s.preview.target.url !== s.hosting?.url
          ? [`Latest preview deployment: ${s.preview.target.url} (${s.preview.target.label}).`]
          : []),
        docs.length
          ? `Documents you can read with artifacts.read:\n${docs.join('\n')}`
          : 'No documents written yet.',
      ].join('\n');
    },
  };
}
