import { join } from 'node:path';
import {
  AgentRuntime,
  type ContextProvider,
  type DirectiveInput,
  type DirectiveReading,
  type ModelClient,
  type ReviewInput,
  type ReviewVerdict,
} from '@lw/agent-runtime';
import type { EventStore, Projections } from '@lw/events';
import {
  createStubActivities,
  loadFixtures,
  withAgentRunner,
  withLiveGuard,
  type Activities,
} from '@lw/orchestrator';
import { Blueprint, releaseApprovalId } from '@lw/plan';
import type { PlatformCheck, PlatformPack } from '@lw/platforms';
import { withReview } from './review';
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
    const url = opts.projections.get(projectId)?.sourceUrl;
    const host = url ? new URL(url).hostname : null;
    return {
      // The site and its www form: one usually redirects to the other.
      allowedHosts: host ? [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`] : [],
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
      blueprint,
      read: (server, op, args) => readOnly(projectId, server, op, args),
      credential: (id) => credential(projectId, id),
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
    new BrowserToolServer({ blobs, policy, browser: chromium }),
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
        const r = await opts.directives({ text: req.text, items });
        if (r.kind === 'status') return { kind: 'status' };
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
          prompt: (role) => prompts[role.role] ?? null,
        }),
        (role) => live.includes(role),
      )
    : base;
  // Done means checked: automated checks, then the Lead's review of what was actually done.
  const reviewed = withReview(agents, {
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
    platform: { checks: opts.platform.checks, read: readOnly, credential },
  });
  const activities = withLiveGuard(reviewed, {
    store: opts.store,
    isLive,
    // Without Claude, nothing is connected: every specialist task on a live project blocks.
    missing: (role) =>
      live.includes(role)
        ? []
        : opts.model
          ? (missing.get(role) ?? [])
          : ['model.claude (AGENTS=claude)'],
    roleName: (role) => roleOf(opts.playbook, role)?.name ?? role,
  });

  return { activities, liveRoles: live, gateway, library, close: () => chromium.close() };
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
