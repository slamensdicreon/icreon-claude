import { fileURLToPath } from 'node:url';
import { anthropicModelClient, checkModels, readDirective, reviewTask } from '@lw/agent-runtime';
import { GithubApp, SITECORE_DEFAULTS, VaultCredentials } from '@lw/connectors';
import {
  masterKey,
  openStore,
  PostgresIntegrationStore,
  PostgresVault,
  Projections,
} from '@lw/events';
import type { NewEvent } from '@lw/contracts';
import { createWorker, taskQueueFor } from '@lw/orchestrator';
import { loadCatalog } from '@lw/playbook-sdk';
import { createPlatforms, ownedPaths, sitecoreTarget, text } from '@lw/platforms';
import { SandboxToolServer, SitecoreCliToolServer, VercelBoxProvider } from '@lw/tool-sandbox';
import { composeStack } from '@lw/stack';
import { openBlobStore, type ToolServer } from '@lw/tool-gateway';
import { GithubToolServer } from '@lw/tool-github';
import { ResearchToolServer } from '@lw/tool-research';
import { HostingToolServer } from '@lw/tool-hosting';
import {
  DeployClient,
  SitecoreAuthoringToolServer,
  SitecoreDeployToolServer,
} from '@lw/tool-sitecore';
import { NativeConnection } from '@temporalio/worker';
import { z } from 'zod';

/**
 * The orchestration worker as its own process: runs project and task workflows and their
 * activities, writing to the shared Postgres event log the Control API reads. Scale it out by
 * running more copies; Temporal spreads the work. On Vercel it is a Daemon.
 *
 * AGENTS=claude runs every role whose tools are all connected on Claude; the rest stay stubs.
 * Swapping agents is a change of activities only, never of workflows.
 */
const env = z
  .object({
    TEMPORAL_ADDRESS: z.string(),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    /** Temporal Cloud API key; connects over TLS. */
    TEMPORAL_API_KEY: z.string().optional(),
    DATABASE_URL: z.string(),
    /** Direct connection for LISTEN (Neon's pooled DATABASE_URL can't carry it). */
    DATABASE_URL_UNPOOLED: z.string().optional(),
    /** Working files (clones, builds); ephemeral on a Daemon. */
    DATA_DIR: z.string().default('/tmp/launchworks'),
    /** Artifacts and screenshots, shared with the Control API: `local` under DATA_DIR, or Blob. */
    BLOB_STORE: z.enum(['local', 'vercel']).default('local'),
    AGENTS: z.enum(['stub', 'claude']).default('stub'),
    /** Opens the credentials the New Project wizard sealed (same key as the Control API). */
    CREDENTIALS_KEY: z.string().optional(),
    CREDENTIALS_KEY_PREVIOUS: z.string().optional(),
    /** Our Vercel team, where each project's head is deployed for preview and editing. */
    VERCEL_PREVIEWS_TOKEN: z.string().optional(),
    VERCEL_PREVIEWS_TEAM_ID: z.string().optional(),
    /** The Vercel project build sandboxes are created under (ours, not a client's). */
    VERCEL_SANDBOX_PROJECT_ID: z.string().optional(),
    /** Every folder under it holding a playbook.yaml is served, each on its own task queue. */
    PLAYBOOKS_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks', import.meta.url))),
  })
  .parse(process.env);

const opened = await openStore('postgres', {
  dataDir: env.DATA_DIR,
  databaseUrl: env.DATABASE_URL,
  listenUrl: env.DATABASE_URL_UNPOOLED,
});
// Shared by the tool servers and the stacks (one folder in dev; object storage when deployed).
const blobs = openBlobStore(env.BLOB_STORE, env.DATA_DIR);
// Tool servers read per-project facts (the source site) from the read models.
const projections = new Projections(opened.store);
await projections.start();
const catalog = await loadCatalog(env.PLAYBOOKS_DIR);
const platforms = createPlatforms({ sitecore: SITECORE_DEFAULTS });

// Real connections, from the secrets the project and the app hold. Without the vault key nothing
// that needs a project credential connects, and those roles block on live projects.
const vault =
  env.CREDENTIALS_KEY && opened.sql
    ? new PostgresVault(
        opened.sql,
        [env.CREDENTIALS_KEY, env.CREDENTIALS_KEY_PREVIOUS]
          .filter(Boolean)
          .map((k) => masterKey(k!)),
      )
    : null;
const github =
  vault && opened.sql
    ? new GithubApp({
        integrations: new PostgresIntegrationStore(opened.sql),
        vault,
        // Only the Control API runs the setup flow; the worker mints installation tokens.
        publicUrl: '',
        appUrl: '',
        owner: { kind: 'user' },
      })
    : null;
const project = async (projectId: string) => {
  await projections.catchUp(projectId);
  return projections.get(projectId);
};
const credentials = vault
  ? new VaultCredentials({
      project,
      vault,
      github,
      toolCredential: (platform, server) => platforms.get(platform)?.toolCredential(server),
    })
  : undefined;
const servers: ToolServer[] = [];
if (env.AGENTS === 'claude') {
  servers.push(new ResearchToolServer());
  if (github) {
    servers.push(
      new GithubToolServer({
        facts: async (id) => {
          const i = (await project(id))?.intake;
          return i?.repo ? { repo: i.repo, branch: i.branch ?? 'main' } : null;
        },
        commits: false,
      }),
      new GithubToolServer({
        name: 'build-repo',
        facts: async (id) => {
          const b = (await project(id))?.buildRepo;
          return b ? { repo: b.repo, branch: b.branch } : null;
        },
        missing:
          'This project has no build repository yet. Create it in Settings, under Build repository.',
      }),
    );
  }
  if (vault) {
    servers.push(
      new SitecoreAuthoringToolServer({
        blobs,
        facts: async (id) => {
          const s = await project(id);
          if (s?.intake?.platform !== 'sitecoreai') return null;
          const host = s.sourceUrl ? new URL(s.sourceUrl).hostname : null;
          const t = sitecoreTarget(s.intake);
          return {
            cmHost: t.cmHost,
            siteCollection: t.siteCollection,
            site: t.site,
            languages: t.languages,
            sourceHosts: host
              ? [host, host.startsWith('www.') ? host.slice(4) : `www.${host}`]
              : [],
          };
        },
      }),
    );
  }
}
if (env.AGENTS === 'claude' && vault && credentials) {
  /** Hosts the project's head is deployed on: the only ones that may become its editing host. */
  const headHosts = (s: NonNullable<Awaited<ReturnType<typeof project>>>) =>
    [s.hosting?.url, s.preview.target?.url]
      .filter((u): u is string => Boolean(u))
      .map((u) => new URL(u).host);
  servers.push(
    new SitecoreDeployToolServer({
      facts: async (id) => {
        const s = await project(id);
        if (s?.intake?.platform !== 'sitecoreai') return null;
        return { cmHost: sitecoreTarget(s.intake).cmHost, headHosts: headHosts(s) };
      },
    }),
  );
  if (env.VERCEL_PREVIEWS_TOKEN && env.VERCEL_PREVIEWS_TEAM_ID) {
    servers.push(
      new HostingToolServer({
        token: env.VERCEL_PREVIEWS_TOKEN,
        teamId: env.VERCEL_PREVIEWS_TEAM_ID,
        facts: async (id) => {
          const s = await project(id);
          const name = s?.intake ? text(s.intake.target, 'hostingProject') : '';
          return s?.buildRepo && name
            ? {
                project: name,
                repo: s.buildRepo.repo,
                branch: s.buildRepo.branch,
                rootDirectory: s.buildRepo.appPath,
              }
            : null;
        },
        // What the head needs, from the platform pack: values come from the vault and the
        // platform's APIs, never from the agent.
        env: async (id, which) => {
          const s = await project(id);
          const pack = s?.intake ? platforms.get(s.intake.platform) : undefined;
          if (!s?.intake || !pack?.headEnv)
            return { vars: [], missing: ['this platform has no head'] };
          return pack.headEnv(s.intake.target, which, {
            credential: async (credentialId) => {
              const ref = s.credentials[credentialId]?.reference;
              return ref ? (JSON.parse(await vault.open(ref)) as Record<string, string>) : null;
            },
            // Says why when it can't: "missing" alone left the team guessing.
            editingSecret: async () => {
              try {
                const deploy = new DeployClient(await credentials.tokenFor(id, 'sitecore-deploy'));
                const e = await deploy.environmentFor(sitecoreTarget(s.intake!).cmHost);
                return 'error' in e ? { problem: e.error } : await deploy.editingSecret(e.id);
              } catch (err) {
                return {
                  problem: `the organization client couldn't be used: ${err instanceof Error ? err.message : String(err)}`,
                };
              }
            },
          });
        },
        // Agents' commits aren't Vercel team members: Vercel's own Git deployments of them are
        // refused and notify the team. Deployments go through these tools instead.
        prepare: async (id) => {
          const s = await project(id);
          if (!s?.buildRepo || !github) return 'no build repository to configure';
          const done = await github.ensureNoGitDeploys(s.buildRepo);
          return done === 'added'
            ? `turned off automatic Git deployments (${s.buildRepo.appPath}/vercel.json on ${s.buildRepo.branch})`
            : 'automatic Git deployments already off';
        },
        record: async (id, r) => {
          const s = await project(id);
          const name = s?.intake ? text(s.intake.target, 'hostingProject') : '';
          const actor = { kind: 'system', id: 'hosting' } as const;
          const subject = { kind: 'project', id } as const;
          const events: NewEvent[] = [];
          if (!s?.hosting || (r.url && r.url !== s.hosting.url)) {
            events.push({
              type: 'project.updated',
              actor,
              subject,
              severity: r.url ? 'notable' : 'routine',
              data: { hosting: { provider: 'vercel', project: name, url: r.url } },
            });
          }
          // Once per deployment, however often its status is read.
          if (r.deployment && s?.preview.target?.deployment !== r.deployment.id) {
            events.push({
              type: 'preview.deployed',
              actor,
              subject,
              severity: 'notable',
              data: {
                side: 'target',
                label: `Vercel, ${r.deployment.target === 'production' ? 'production' : r.deployment.ref}`,
                url: r.deployment.url,
                deployment: r.deployment.id,
              },
            });
          }
          if (events.length) await opened.store.append(id, events);
        },
      }),
    );
  }
}
// Working copies of the build repository: builds, the Content SDK CLI and the Sitecore CLI.
if (
  env.AGENTS === 'claude' &&
  vault &&
  env.VERCEL_PREVIEWS_TOKEN &&
  env.VERCEL_PREVIEWS_TEAM_ID &&
  env.VERCEL_SANDBOX_PROJECT_ID
) {
  const provider = new VercelBoxProvider({
    token: env.VERCEL_PREVIEWS_TOKEN,
    teamId: env.VERCEL_PREVIEWS_TEAM_ID,
    projectId: env.VERCEL_SANDBOX_PROJECT_ID,
  });
  const workspace = async (id: string) => {
    const s = await project(id);
    return s?.buildRepo
      ? { repo: s.buildRepo.repo, branch: s.buildRepo.branch, appPath: s.buildRepo.appPath }
      : null;
  };
  const credential = async (id: string, credentialId: string) => {
    const ref = (await project(id))?.credentials[credentialId]?.reference;
    return ref ? (JSON.parse(await vault.open(ref)) as Record<string, string>) : null;
  };
  servers.push(
    new SandboxToolServer({
      provider,
      facts: workspace,
      // What the build reads (site, language, Context ID); never the editing secret.
      buildEnv: async (id) => {
        const s = await project(id);
        const pack = s?.intake ? platforms.get(s.intake.platform) : undefined;
        if (!s?.intake || !pack?.headEnv) return {};
        const { vars } = await pack.headEnv(s.intake.target, 'preview', {
          credential: (c) => credential(id, c),
          editingSecret: async () => ({ problem: 'builds never read the editing secret' }),
        });
        return Object.fromEntries(vars.map((v) => [v.key, v.value]));
      },
    }),
    new SitecoreCliToolServer({
      provider,
      facts: async (id) => {
        const w = await workspace(id);
        const s = await project(id);
        if (!w || s?.intake?.platform !== 'sitecoreai') return null;
        return {
          ...w,
          cmHost: sitecoreTarget(s.intake).cmHost,
          ownedPaths: ownedPaths(s.intake.target),
        };
      },
      client: async (id) => {
        const c = await credential(id, 'sitecore-environment');
        return c?.clientId && c.clientSecret
          ? { clientId: c.clientId, clientSecret: c.clientSecret }
          : null;
      },
    }),
  );
}
console.log(
  `Connected tool servers: ${servers.map((s) => s.name).join(', ') || 'none'}${vault ? '' : ' (CREDENTIALS_KEY not set: no project credentials)'}`,
);

// One stack per playbook: its roles, prompts, grants and platform pack.
const stacks = [];
for (const { playbook, dir } of catalog.values()) {
  const stack = await composeStack({
    store: opened.store,
    projections,
    playbook,
    playbookDir: dir,
    platform: platforms.get(playbook.manifest.platform)!,
    dataDir: env.DATA_DIR,
    blobs,
    model: env.AGENTS === 'claude' ? anthropicModelClient() : null,
    directives: env.AGENTS === 'claude' ? (input) => readDirective(input) : null,
    review: env.AGENTS === 'claude' ? (input) => reviewTask(input) : null,
    servers,
    credentials,
    credential: async (id, credentialId) => {
      const ref = (await project(id))?.credentials[credentialId]?.reference;
      return ref && vault ? (JSON.parse(await vault.open(ref)) as Record<string, string>) : null;
    },
  });
  console.log(`Live agents (${playbook.manifest.id}): ${stack.liveRoles.join(', ') || 'none'}`);
  stacks.push({ id: playbook.manifest.id, stack });
}
if (env.AGENTS === 'claude') {
  const models = [...catalog.values()].flatMap((e) => e.playbook.roles.map((r) => r.model.id));
  for (const m of await checkModels([...new Set(models)])) {
    console.log(`Claude ${m.id}: ${m.ok ? `ok (${m.detail})` : `NOT AVAILABLE, ${m.detail}`}`);
  }
}

const connection = await NativeConnection.connect({
  address: env.TEMPORAL_ADDRESS,
  ...(env.TEMPORAL_API_KEY
    ? {
        tls: true,
        apiKey: env.TEMPORAL_API_KEY,
        metadata: { 'temporal-namespace': env.TEMPORAL_NAMESPACE },
      }
    : {}),
}).catch((err: unknown) => {
  console.error(`Temporal: could not connect to ${env.TEMPORAL_ADDRESS}`, err);
  throw err;
});
console.log(`Temporal: connected to ${env.TEMPORAL_ADDRESS}, namespace ${env.TEMPORAL_NAMESPACE}`);

const workers = await Promise.all(
  stacks.map(({ id, stack }) =>
    createWorker({
      connection,
      namespace: env.TEMPORAL_NAMESPACE,
      activities: stack.activities,
      taskQueue: taskQueueFor(id),
    }),
  ),
);

// Vercel sends SIGTERM on rollout and gives the grace period to finish; the workers drain.
const stop = () => workers.forEach((w) => w.shutdown());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await Promise.all(workers.map((w) => w.run()));
for (const { stack } of stacks) await stack.close();
await opened.close();
