import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTIMIZELY_DEFAULTS, SITECORE_DEFAULTS } from '@lw/connectors';
import { InMemoryEventStore, Projections } from '@lw/events';
import { createPlatforms } from '@lw/platforms';
import { loadCatalog } from '@lw/playbook-sdk';
import { composeStack, hostingToolServer, missingForTask, missingOps } from '@lw/stack';
import type { ToolServer } from '@lw/tool-gateway';
import { GithubToolServer } from '@lw/tool-github';
import { OptimizelyCmsToolServer, OptimizelyGraphToolServer } from '@lw/tool-optimizely';
import { ResearchToolServer } from '@lw/tool-research';
import { SandboxToolServer, SitecoreCliToolServer, VercelBoxProvider } from '@lw/tool-sandbox';
import { SitecoreAuthoringToolServer, SitecoreDeployToolServer } from '@lw/tool-sitecore';
import { describe, expect, it } from 'vitest';

/**
 * A role runs on a live project only when every operation it is granted is served. A playbook
 * that grants an operation nobody built stops at that role's first task with "Not connected"
 * (the first Optimizely project did, on `locale.add` and `webhook.*`). This composes each
 * current playbook with every tool server the worker connects when all its settings are present
 * (the list in src/main.ts) and names what would still be missing.
 */
const platforms = createPlatforms({ sitecore: SITECORE_DEFAULTS, optimizely: OPTIMIZELY_DEFAULTS });
const none = async () => null;
const loose = <T>(value: unknown) => value as T;
const provider = new VercelBoxProvider({ token: 't', teamId: 't', projectId: 'p' });

type Options<T extends abstract new (...args: never[]) => unknown> = ConstructorParameters<T>[0];
const workerServers = (): ToolServer[] => [
  new ResearchToolServer({ client: loose({}) }),
  new GithubToolServer({ facts: none, commits: false }),
  new GithubToolServer({ name: 'build-repo', facts: none, missing: 'no build repository' }),
  new SitecoreAuthoringToolServer(
    loose<Options<typeof SitecoreAuthoringToolServer>>({ edgeContextId: none, facts: none }),
  ),
  new OptimizelyCmsToolServer({ facts: none }),
  new OptimizelyGraphToolServer({ facts: none, hmac: none }),
  new SitecoreDeployToolServer({ facts: none }),
  hostingToolServer(
    loose<Parameters<typeof hostingToolServer>[0]>({
      token: 't',
      teamId: 't',
      project: none,
      platforms,
      credential: none,
      tokenFor: none,
      github: null,
      append: none,
    }),
  ),
  new SandboxToolServer(
    loose<Options<typeof SandboxToolServer>>({
      provider,
      facts: none,
      buildEnv: async () => ({}),
    }),
  ),
  new SitecoreCliToolServer(
    loose<Options<typeof SitecoreCliToolServer>>({ provider, facts: none, client: none }),
  ),
];

/**
 * What no agent does yet, on any platform: driving the editor's own interface and recording it.
 * The Director does those steps by hand (each is a `manual` step in its plan).
 */
const BY_HAND = /^browser\.((page-builder|visual-builder)\.drive|video\.record)$/;

describe('every current playbook, on the worker with all its settings', async () => {
  const root = fileURLToPath(new URL('../../../playbooks/', import.meta.url));
  const catalog = await loadCatalog(root);

  it.each([...catalog.keys()])('%s: every role has the tools it is granted', async (id) => {
    const { playbook, dir } = catalog.get(id)!;
    const store = new InMemoryEventStore();
    const projections = new Projections(store);
    await projections.start();
    const stack = await composeStack({
      store,
      projections,
      playbook,
      playbookDir: dir,
      platform: platforms.get(playbook.manifest.platform)!,
      dataDir: await mkdtemp(join(tmpdir(), 'lw-connected-')),
      model: loose({}),
      servers: workerServers(),
    });
    try {
      const servers = [
        ...loose<{ servers: Map<string, ToolServer> }>(stack.gateway).servers.values(),
      ];
      const missing = missingOps(playbook, servers);
      const unexpected = [...missing].flatMap(([role, ops]) =>
        ops.filter((op) => !BY_HAND.test(op)).map((op) => `${role}: ${op}`),
      );
      expect(unexpected).toEqual([]);

      // A role that lacks only the by-hand operations still runs every task that doesn't use
      // them. What is left blocked must be a step the plan gives to a person.
      const names = new Set(servers.map((s) => s.name));
      const blocked = playbook.plan.templates.filter(
        (t) =>
          !t.manual &&
          missingForTask(playbook, missing, { role: t.role, templateId: t.id }).length > 0,
      );
      expect(blocked.map((t) => `${t.id} (${t.role})`)).toEqual([]);
      // And no step names a tool server that isn't connected.
      const unknown = playbook.plan.templates.flatMap((t) =>
        (t.uses ?? []).filter((u) => !names.has(u)).map((u) => `${t.id}: ${u}`),
      );
      expect(unknown).toEqual([]);
    } finally {
      await stack.close();
    }
  });
});
