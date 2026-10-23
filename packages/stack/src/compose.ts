import { join } from 'node:path';
import { AgentRuntime, type ContextProvider, type ModelClient } from '@lw/agent-runtime';
import type { EventStore, Projections } from '@lw/events';
import {
  createStubActivities,
  loadFixtures,
  withAgentRunner,
  type Activities,
} from '@lw/orchestrator';
import { Blueprint } from '@lw/plan';
import { loadRolePrompts, type Playbook } from '@lw/playbook-sdk';
import { BrowserToolServer, GuardedBrowser, type UrlPolicy } from '@lw/tool-browser';
import {
  LocalBlobStore,
  MemoryIdempotencyStore,
  TokenBucketLimiter,
  ToolGateway,
  type BlobStore,
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
  /** Working files (clones, builds). Blobs go under `${dataDir}/blobs` unless `blobs` is given. */
  dataDir: string;
  /** Where artifacts, screenshots and assets are kept; shared with the Control API. */
  blobs?: BlobStore;
  /** Claude, when configured. Without it every role runs on stub agents. */
  model?: ModelClient | null;
  /** Extra servers (tests); the browser and workspace servers are always connected. */
  servers?: ToolServer[];
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
 * Roles whose every granted operation is served by a connected tool server. A role with any
 * missing operation stays on stub agents rather than running half-equipped.
 */
export function liveRoles(playbook: Playbook, servers: ToolServer[]): string[] {
  const available = new Map(servers.map((s) => [s.name, s.catalog]));
  return playbook.roles
    .filter((r) => r.tier === 'specialist')
    .filter((r) => {
      const grants = Object.entries(r.tools);
      return (
        grants.length > 0 &&
        grants.every(([server, grant]) => grant.ops.every((op) => available.get(server)?.[op]))
      );
    })
    .map((r) => r.role);
}

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
  const servers: ToolServer[] = [
    new BrowserToolServer({ blobs, policy, browser: chromium }),
    new ValidatorsToolServer({ blobs, policy, browser: chromium }),
    new ArtifactsToolServer(library),
    new BlackboardToolServer(library),
    new DecisionLogToolServer((id) => opts.projections.get(id)?.decisions ?? []),
    ...(opts.servers ?? []),
  ];
  const gateway = new ToolGateway({
    playbook: opts.playbook,
    servers,
    // Sitecore path bindings arrive with the tenant tool servers.
    bindings: () => ({}),
    // These servers need no external credentials; the vault-backed provider arrives with them.
    credentials: { tokenFor: async () => 'no-external-credential' },
    idempotency: new MemoryIdempotencyStore(),
    rollback: { hasRecipe: async () => false },
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
  const base: Activities = {
    ...stubs,
    // Once an agent has written a Blueprint, that is the plan of record.
    async loadBlueprint(projectId) {
      const written = await library.read(projectId, 'blueprint');
      return written
        ? Blueprint.parse(JSON.parse(written.content))
        : stubs.loadBlueprint(projectId);
    },
  };

  const live = opts.model ? liveRoles(opts.playbook, servers) : [];
  const prompts = await loadRolePrompts(opts.playbookDir, opts.playbook);
  const activities = opts.model
    ? withAgentRunner(
        base,
        new AgentRuntime({
          model: opts.model,
          gateway,
          playbook: opts.playbook,
          store: opts.store,
          context: projectContext(opts.projections),
          prompt: (role) => prompts[role.role] ?? null,
        }),
        (role) => live.includes(role),
      )
    : base;

  return { activities, liveRoles: live, gateway, library, close: () => chromium.close() };
}

/** What every agent is told about the project: its source site and the documents so far. */
function projectContext(projections: Projections): ContextProvider {
  return {
    async forTask(projectId) {
      const s = projections.get(projectId);
      const docs = Object.values(s?.artifacts ?? {})
        .filter((a) => a.versions.some((v) => v.ref))
        .map((a) => `- ${a.artifactId} (${a.kind}): ${a.title}, v${a.latest}`);
      return [
        `Project: ${s?.name ?? projectId} for ${s?.client ?? 'the client'}.`,
        `Source site: ${s?.sourceUrl ?? 'not given at intake'}.`,
        // The hosting tool server fills this once preview deployments exist.
        'Migrated preview site: none deployed yet.',
        docs.length
          ? `Documents you can read with artifacts.read:\n${docs.join('\n')}`
          : 'No documents written yet.',
      ].join('\n');
    },
  };
}
