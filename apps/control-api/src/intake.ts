import { randomUUID } from 'node:crypto';
import type {
  NewEvent,
  ProjectIntake,
  VerifyIntakeCredential,
  VerifyIntakeResult,
} from '@lw/contracts';
import { CommandError, type ProjectState } from '@lw/domain';
import type { EventStore, SecretVault } from '@lw/events';
import type { Playbook } from '@lw/playbook-sdk';
import type { GithubApp } from '@lw/connectors';
import { phaseDefs, roster } from '@lw/playbook-sdk/pure';
import {
  verifyContextId,
  verifyEnvironmentClient,
  verifyOrganizationClient,
  type VerifyConfig,
  type VerifyResult,
} from '@lw/connectors';

/** What the orchestrator needs to start a project the wizard registered. */
export interface StartInput {
  projectId: string;
  name: string;
  client: string;
  sourceUrl: string | null;
  budgets: ProjectState['budgets'];
}

export interface IntakeDeps {
  store: EventStore;
  playbook: Playbook;
  vault: SecretVault;
  verify: VerifyConfig;
  /** Starts the real orchestrator for a project. Absent where none is connected. */
  start?: (input: StartInput) => Promise<void>;
  /** The Launchworks GitHub App, which gives agents the source repository. */
  github?: GithubApp;
  /** Stops a project's run for good (Temporal terminate), for a reset. */
  stop?: (projectId: string) => Promise<void>;
  /** Where the project's documents and screenshots are kept, emptied by a reset. */
  blobs?: { deleteProject(projectId: string): Promise<void> };
  /** Our GitHub organization, where each project's build repository is created. */
  buildOrg?: string;
}

const INTAKE = { kind: 'system', id: 'intake' } as const;

/** One credential the wizard collects: what Settings calls it, and how it is checked. */
interface CredentialSpec {
  credentialId: string;
  system: string;
  scope: (s: { cmHost: string }) => string;
  check: (
    cfg: VerifyConfig,
    secret: Record<string, string>,
    ctx: { cmHost: string },
  ) => Promise<VerifyResult>;
}

const SPECS: Record<'environment' | 'organization' | 'edgePreview' | 'edgeLive', CredentialSpec> = {
  environment: {
    credentialId: 'sitecore-environment',
    system: 'SitecoreAI environment client',
    scope: ({ cmHost }) => `Authoring API, ${hostOf(cmHost)}`,
    check: (cfg, s, { cmHost }) =>
      verifyEnvironmentClient(cfg, {
        cmHost,
        clientId: s.clientId!,
        clientSecret: s.clientSecret!,
      }),
  },
  organization: {
    credentialId: 'sitecore-organization',
    system: 'SitecoreAI organization client',
    scope: () => 'Deploy API, all environments',
    check: (cfg, s) =>
      verifyOrganizationClient(cfg, { clientId: s.clientId!, clientSecret: s.clientSecret! }),
  },
  edgePreview: {
    credentialId: 'edge-preview',
    system: 'Experience Edge, preview',
    scope: () => 'Context ID (preview)',
    check: (cfg, s) => verifyContextId(cfg, { contextId: s.contextId!, label: 'preview' }),
  },
  edgeLive: {
    credentialId: 'edge-live',
    system: 'Experience Edge, live',
    scope: () => 'Context ID (live)',
    check: (cfg, s) => verifyContextId(cfg, { contextId: s.contextId!, label: 'live' }),
  },
};

function hostOf(cmHost: string): string {
  try {
    return new URL(/^https?:\/\//.test(cmHost) ? cmHost : `https://${cmHost}`).host;
  } catch {
    return cmHost;
  }
}

const result = (r: VerifyResult): VerifyIntakeResult => ({
  ok: r.ok,
  detail: r.detail,
  sites: r.sites ?? [],
  expiresAt: r.expiresAt ?? null,
});

/**
 * The New Project wizard's back end. Credentials are checked against the live services, sealed in
 * the vault, and recorded by reference; the project is recorded in `intake` and starts when the
 * Director presses Start and an orchestrator is connected.
 */
export class IntakeService {
  constructor(private readonly deps: IntakeDeps) {}

  get canStart(): boolean {
    return Boolean(this.deps.start);
  }

  /** Checks one credential before anything is stored. */
  async verify(input: VerifyIntakeCredential): Promise<VerifyIntakeResult> {
    const cfg = this.deps.verify;
    switch (input.kind) {
      case 'sitecore.environment':
        return result(await verifyEnvironmentClient(cfg, input));
      case 'sitecore.organization':
        return result(await verifyOrganizationClient(cfg, input));
      case 'edge.preview':
        return result(await verifyContextId(cfg, { contextId: input.contextId, label: 'preview' }));
      case 'edge.live':
        return result(await verifyContextId(cfg, { contextId: input.contextId, label: 'live' }));
      case 'github.repo':
        return result(await this.checkRepo(input.repo, input.branch));
    }
  }

  private async checkRepo(repo: string, branch: string) {
    if (!this.deps.github) {
      return { ok: false, detail: 'The GitHub App is not wired in this mode.' };
    }
    try {
      return await this.deps.github.checkRepo(repo, branch);
    } catch (err) {
      return { ok: false, detail: `Could not reach GitHub: ${(err as Error).message}` };
    }
  }

  /** Repository access: the app's installation when it reaches the repo, else the reason why not. */
  private async githubEvents(
    repo: string,
    branch: string,
    actor: NewEvent['actor'],
  ): Promise<NewEvent[]> {
    const r = await this.checkRepo(repo, branch);
    const reference =
      r.ok && r.installationId ? `github-app:installation/${r.installationId}` : null;
    return [
      {
        type: 'credential.registered',
        actor,
        subject: { kind: 'tool', id: 'github' },
        severity: 'routine',
        data: {
          credentialId: 'github',
          system: 'GitHub App',
          scope: `${repo} (read, branch, pull requests)`,
          reference,
          hint: null,
          expiresAt: null,
        },
      },
      {
        type: 'credential.verified',
        actor,
        subject: { kind: 'tool', id: 'github' },
        severity: r.ok ? 'routine' : 'warning',
        data: { credentialId: 'github', ok: r.ok, detail: r.detail, expiresAt: null },
      },
    ];
  }

  /** Records a new project in intake. Every credential given must pass its check first. */
  async create(intake: ProjectIntake): Promise<string> {
    const { store, playbook, vault } = this.deps;
    const projectId = `prj-${randomUUID().slice(0, 8)}`;
    const ctx = { cmHost: intake.target.cmHost };
    const given: [keyof typeof SPECS, Record<string, string>][] = [
      ['environment', intake.credentials.environment],
    ];
    if (intake.credentials.organization)
      given.push(['organization', intake.credentials.organization]);
    if (intake.credentials.edgePreviewContextId)
      given.push(['edgePreview', { contextId: intake.credentials.edgePreviewContextId }]);
    if (intake.credentials.edgeLiveContextId)
      given.push(['edgeLive', { contextId: intake.credentials.edgeLiveContextId }]);

    // Check everything server-side, whatever the wizard showed: nothing is stored on a failure.
    const checks = await Promise.all(
      given.map(async ([key, secret]) => ({
        key,
        secret,
        r: await SPECS[key].check(this.deps.verify, secret, ctx),
      })),
    );
    const failed = checks.find((c) => !c.r.ok);
    if (failed) {
      throw new CommandError(
        422,
        'credential_failed',
        `${SPECS[failed.key].system}: ${failed.r.detail}`,
      );
    }

    const credentialEvents: NewEvent[] = [];
    for (const { key, secret, r } of checks) {
      const spec = SPECS[key];
      const sealed = await vault.seal(projectId, spec.credentialId, JSON.stringify(secret));
      const hint =
        key === 'environment' || key === 'organization'
          ? tail(secret.clientSecret!)
          : tail(secret.contextId!);
      credentialEvents.push(
        {
          type: 'credential.registered',
          actor: INTAKE,
          subject: { kind: 'tool', id: spec.credentialId },
          severity: 'routine',
          data: {
            credentialId: spec.credentialId,
            system: spec.system,
            scope: spec.scope(ctx),
            reference: sealed.reference,
            hint,
            expiresAt: null,
          },
        },
        {
          type: 'credential.verified',
          actor: INTAKE,
          subject: { kind: 'tool', id: spec.credentialId },
          severity: 'routine',
          data: { credentialId: spec.credentialId, ok: true, detail: r.detail, expiresAt: null },
        },
      );
    }
    // Repository access comes from the GitHub App. A repo it can't reach yet doesn't stop intake:
    // Settings shows why, and a re-check picks up the installation once the client adds it.
    credentialEvents.push(
      ...(await this.githubEvents(intake.source.repo, intake.source.branch, INTAKE)),
    );

    const environmentSites = checks.find((c) => c.key === 'environment')?.r.sites ?? [];
    await store.append(projectId, [
      {
        type: 'project.created',
        actor: INTAKE,
        subject: { kind: 'project', id: projectId },
        severity: 'notable',
        data: {
          name: intake.name,
          client: intake.client,
          playbook: { id: playbook.manifest.id, version: playbook.manifest.version },
          budgets: intake.budgets,
          phases: phaseDefs(playbook),
          roster: roster(playbook),
          site: { sourceUrl: intake.source.url },
          subtitle: `${intake.source.repo} to SitecoreAI`,
          timezone: intake.timezone,
          source: {
            repo: intake.source.repo,
            url: intake.source.url,
            framework: null,
            label: null,
          },
          target: {
            collection: intake.target.siteCollection,
            site: intake.target.site,
            hosting: `Vercel, ${intake.hosting.project}`,
          },
          toolLabels: playbook.manifest.defaults.toolLabels,
          mode: 'live',
          intake: {
            repo: intake.source.repo,
            branch: intake.source.branch,
            cmHost: hostOf(intake.target.cmHost),
            siteCollection: intake.target.siteCollection,
            site: intake.target.site,
            languages: intake.target.languages,
            hosting: intake.hosting,
          },
        },
      },
      ...credentialEvents,
      {
        type: 'cos.message',
        actor: { kind: 'agent', id: 'chief-of-staff' },
        subject: { kind: 'project', id: projectId },
        severity: 'notable',
        data: {
          messageId: randomUUID(),
          kind: 'brief',
          title: 'Intake recorded',
          label: 'Intake',
          body: '',
          rows: [
            { label: 'Source', value: `${intake.source.repo} (${intake.source.branch})` },
            {
              label: 'Target',
              value: `${hostOf(intake.target.cmHost)}, ${intake.target.siteCollection} / ${intake.target.site}`,
            },
            {
              label: 'Sitecore',
              value: environmentSites.length
                ? `Environment client verified. Existing sites: ${environmentSites.join(', ')}.`
                : 'Environment client verified. No sites on the environment yet.',
            },
          ],
          note: this.canStart
            ? 'Nothing has run yet. Start the project from Mission Control when you are ready.'
            : 'Nothing has run yet. The project starts once the orchestrator (Temporal Cloud) is connected.',
        },
      },
    ]);
    return projectId;
  }

  /** Starts a project the wizard recorded. */
  async start(s: ProjectState): Promise<void> {
    if (s.mode !== 'live' || s.status !== 'intake') {
      throw new CommandError(409, 'already_started', `${s.name} is not waiting to start.`);
    }
    if (!this.deps.start) {
      throw new CommandError(
        503,
        'orchestrator_unavailable',
        'No orchestrator is connected, so nothing can run yet. Connect Temporal Cloud and set ORCHESTRATOR=temporal, then start the project.',
      );
    }
    // The build repository is needed from phase 3; a failure here shows in Settings, where it
    // can be retried, and doesn't hold up discovery.
    if (!s.buildRepo && this.deps.buildOrg && this.deps.github) {
      await this.createBuildRepo(s).catch((e: unknown) => {
        console.warn(`Build repository for ${s.projectId} not created: ${(e as Error).message}`);
      });
    }
    await this.deps.start({
      projectId: s.projectId,
      name: s.name,
      client: s.client,
      sourceUrl: s.sourceUrl,
      budgets: s.budgets,
    });
  }

  /**
   * Creates the project's build repository in our organization from Sitecore's starter, or
   * checks and reuses one of that name. Named after the source repository unless told otherwise.
   */
  async createBuildRepo(s: ProjectState, name?: string): Promise<void> {
    if (s.mode !== 'live' || !s.intake) {
      throw new CommandError(409, 'not_live', 'Only real projects have a build repository.');
    }
    if (s.buildRepo) {
      throw new CommandError(409, 'exists', `${s.name} already builds in ${s.buildRepo.repo}.`);
    }
    const { github, buildOrg } = this.deps;
    if (!github || !buildOrg) {
      throw new CommandError(
        503,
        'build_org_unavailable',
        'No build organization is configured. Set GITHUB_BUILD_ORG and set up the GitHub App.',
      );
    }
    const repoName = name ?? `${s.intake.repo.split('/')[1]}-sitecoreai`;
    const buildRepo = await github.createBuildRepo(
      buildOrg,
      repoName,
      `${s.name}: SitecoreAI site built by Launchworks from ${s.intake.repo}.`,
    );
    await this.deps.store.append(s.projectId, [
      {
        type: 'project.updated',
        actor: INTAKE,
        subject: { kind: 'project', id: s.projectId },
        severity: 'notable',
        data: { buildRepo },
      },
    ]);
  }

  /**
   * Takes a live project back to intake: stops its run, deletes everything it produced (events,
   * documents, screenshots) and keeps what the Director gave it (intake facts, credentials and
   * their checks, the source site). Start runs it again from the beginning.
   */
  async reset(s: ProjectState, confirmation: string): Promise<void> {
    if (s.mode !== 'live') {
      throw new CommandError(409, 'demo_project', 'Only real projects can be reset.');
    }
    if (confirmation !== s.name) {
      throw new CommandError(422, 'confirmation', `Type the project name, ${s.name}, to confirm.`);
    }
    if (s.status !== 'intake' && !this.deps.stop) {
      throw new CommandError(
        503,
        'orchestrator_unavailable',
        'No orchestrator is connected, so the running project cannot be stopped for a reset.',
      );
    }
    const { store } = this.deps;
    await this.deps.stop?.(s.projectId);
    const log = await store.read(s.projectId);
    const started = log.find((e) => e.type === 'project.status')?.seq ?? Infinity;
    const keep = log.filter(
      (e) =>
        e.seq < started ||
        e.type === 'credential.registered' ||
        e.type === 'credential.verified' ||
        e.type === 'project.updated',
    );
    await store.reset(s.projectId);
    await this.deps.blobs?.deleteProject(s.projectId);
    await store.append(s.projectId, [
      ...keep.map(
        (e) =>
          ({
            type: e.type,
            actor: e.actor,
            subject: e.subject,
            severity: e.severity,
            data: e.data,
            at: e.ts,
          }) as NewEvent,
      ),
      {
        type: 'cos.message',
        actor: { kind: 'chief_of_staff', id: 'chief-of-staff' },
        subject: { kind: 'project', id: s.projectId },
        severity: 'notable',
        data: {
          messageId: randomUUID(),
          kind: 'text',
          title: 'Reset to intake',
          body: 'The Director reset this project. The run so far, its decisions and its documents were removed; the intake facts, credentials and source site are kept. Press Start to run it again from the beginning.',
        },
      },
    ]);
  }

  /** Re-checks a stored credential of a live project and records the outcome. */
  async reverify(s: ProjectState, credentialId: string): Promise<void> {
    const c = s.credentials[credentialId];
    if (!c) throw new CommandError(404, 'unknown_credential', `No credential "${credentialId}".`);
    if (credentialId === 'github' && s.intake) {
      // Re-finds the installation, so a repo the client installed the app on since is picked up.
      await this.deps.store.append(
        s.projectId,
        await this.githubEvents(s.intake.repo, s.intake.branch, {
          kind: 'director',
          id: 'director',
        }),
      );
      return;
    }
    if (!c.reference) {
      throw new CommandError(409, 'not_provided', `${c.system} hasn't been provided yet.`);
    }
    const key = (Object.keys(SPECS) as (keyof typeof SPECS)[]).find(
      (k) => SPECS[k].credentialId === credentialId,
    );
    if (!key)
      throw new CommandError(501, 'not_supported', `${c.system} can't be checked here yet.`);
    const secret = JSON.parse(await this.deps.vault.open(c.reference)) as Record<string, string>;
    const r = await SPECS[key].check(this.deps.verify, secret, { cmHost: s.intake?.cmHost ?? '' });
    await this.deps.store.append(s.projectId, [
      {
        type: 'credential.verified',
        actor: { kind: 'director', id: 'director' },
        subject: { kind: 'tool', id: credentialId },
        severity: r.ok ? 'routine' : 'warning',
        data: { credentialId, ok: r.ok, detail: r.detail, expiresAt: null },
      },
    ]);
  }
}

const tail = (v: string) => (v.length > 8 ? v.slice(-4) : null);
