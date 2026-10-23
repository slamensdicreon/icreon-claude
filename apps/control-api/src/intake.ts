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
import { phaseDefs, roster } from '@lw/playbook-sdk/pure';
import {
  verifyContextId,
  verifyEnvironmentClient,
  verifyOrganizationClient,
  type VerifyConfig,
  type VerifyResult,
} from './verify';

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
    }
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
    // Repository access comes from the Icreon GitHub App, which isn't connected yet: record the
    // need, unprovided, so Settings shows it.
    credentialEvents.push({
      type: 'credential.registered',
      actor: INTAKE,
      subject: { kind: 'tool', id: 'github' },
      severity: 'routine',
      data: {
        credentialId: 'github',
        system: 'GitHub',
        scope: `${intake.source.repo} (read, branch, pull requests)`,
        reference: null,
        hint: null,
        expiresAt: null,
      },
    });

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
    await this.deps.start({
      projectId: s.projectId,
      name: s.name,
      client: s.client,
      sourceUrl: s.sourceUrl,
      budgets: s.budgets,
    });
  }

  /** Re-checks a stored credential of a live project and records the outcome. */
  async reverify(s: ProjectState, credentialId: string): Promise<void> {
    const c = s.credentials[credentialId];
    if (!c) throw new CommandError(404, 'unknown_credential', `No credential "${credentialId}".`);
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
