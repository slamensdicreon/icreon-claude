import { randomUUID } from 'node:crypto';
import type {
  ConnectionView,
  RemixDraft,
  IntakeSpec,
  NewEvent,
  PlaybookSummary,
  ProjectIntake,
  VerifyIntakeCredential,
  VerifyIntakeResult,
} from '@lw/contracts';
import { briefApplies, SOURCE_REPO } from '@lw/contracts';
import { CommandError, type ProjectState } from '@lw/domain';
import type { EventStore, IntegrationStore, SecretVault } from '@lw/events';
import type { CatalogEntry } from '@lw/playbook-sdk';
import type { GithubApp, VerifyResult } from '@lw/connectors';
import { phaseDefs, roster } from '@lw/playbook-sdk/pure';
import {
  IntakeError,
  intakeSpec,
  playbookSummary,
  validateTarget,
  type PlatformPack,
  type TargetValues,
} from '@lw/platforms';

/** What the orchestrator needs to start a project the wizard registered. */
export interface StartInput {
  projectId: string;
  name: string;
  client: string;
  sourceUrl: string | null;
  budgets: ProjectState['budgets'];
  /** The playbook the project was created with. */
  playbookId: string;
  /** Features the brief switched on (e.g. personalization). */
  features: string[];
}

export interface IntakeDeps {
  store: EventStore;
  /** Every playbook a project can run, by id. */
  catalog: Map<string, CatalogEntry>;
  /** Platform packs, by id: what each playbook's intake fields and credentials are. */
  platforms: Map<string, PlatformPack>;
  vault: SecretVault;
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
  /** Where saved connections are kept (one tenant's shared facts and sealed secrets). */
  connections?: IntegrationStore;
}

/** A saved connection as stored: secrets by vault reference, sealed to the connection. */
interface ConnectionRecord {
  id: string;
  name: string;
  platform: string;
  target: TargetValues;
  credentials: Record<
    string,
    {
      reference: string;
      system: string;
      hint: string | null;
      checkedAt: string | null;
      ok: boolean | null;
      detail: string | null;
    }
  >;
  createdAt: string;
  createdFrom: { projectId: string; name: string } | null;
}

const CONNECTION = 'connection:';

const INTAKE = { kind: 'system', id: 'intake' } as const;

const result = (r: VerifyResult): VerifyIntakeResult => ({
  ok: r.ok,
  detail: r.detail,
  sites: r.sites ?? [],
  expiresAt: r.expiresAt ?? null,
});

/**
 * The New Project wizard's back end. The chosen playbook decides what intake collects; its
 * platform pack says what each value and credential is and how it is checked. Credentials are
 * checked against the live services, sealed in the vault, and recorded by reference; the project
 * is recorded in `intake` and starts when the Director presses Start and an orchestrator is
 * connected.
 */
export class IntakeService {
  constructor(private readonly deps: IntakeDeps) {
    // Fail at startup, not in the wizard, if a playbook names a field its pack lacks.
    for (const id of deps.catalog.keys()) this.resolve(id);
  }

  get canStart(): boolean {
    return Boolean(this.deps.start);
  }

  /**
   * The playbooks a new project can run, as the wizard shows them: entities in the order their
   * packs are registered (the established one first), each entity's playbooks in catalog order.
   */
  playbooks(): PlaybookSummary[] {
    const order = [...this.deps.platforms.keys()];
    return [...this.deps.catalog.values()]
      .map((e) => playbookSummary(e.playbook, this.resolve(e.playbook.manifest.id).pack))
      .sort((a, b) => order.indexOf(a.platform.id) - order.indexOf(b.platform.id));
  }

  private resolve(playbookId: string): {
    entry: CatalogEntry;
    pack: PlatformPack;
    spec: IntakeSpec;
  } {
    const entry = this.deps.catalog.get(playbookId);
    if (!entry) throw new CommandError(404, 'unknown_playbook', `No playbook "${playbookId}".`);
    const pack = this.deps.platforms.get(entry.playbook.manifest.platform);
    if (!pack) {
      throw new CommandError(
        501,
        'unknown_platform',
        `${entry.playbook.manifest.name} runs on "${entry.playbook.manifest.platform}", which has no platform pack.`,
      );
    }
    return { entry, pack, spec: intakeSpec(entry.playbook, pack) };
  }

  /**
   * Features the project switches on: `source-repo` when it has a source repository (templates
   * that read the code need one; their live-site stand-ins run without it), and a yes to a brief
   * question that names one.
   */
  private featuresOf(s: ProjectState): string[] {
    const source = s.intake?.repo ? [SOURCE_REPO] : [];
    if (!s.playbook || !this.deps.catalog.has(s.playbook.id)) return source;
    const questions = this.resolve(s.playbook.id).spec.brief;
    return [
      ...source,
      ...questions
        .filter((q) => q.feature && s.brief.find((b) => b.key === q.key)?.answer === 'yes')
        .map((q) => q.feature!),
    ];
  }

  /** The platform pack a project runs on, from its intake. */
  private packOf(s: ProjectState): PlatformPack | undefined {
    return s.intake ? this.deps.platforms.get(s.intake.platform) : undefined;
  }

  /** Checks one credential before anything is stored. */
  async verify(input: VerifyIntakeCredential): Promise<VerifyIntakeResult> {
    if (input.kind === 'github.repo') return result(await this.checkRepo(input.repo, input.branch));
    const { pack, spec } = this.resolve(input.playbookId);
    if (!spec.steps.some((st) => st.credentials.some((c) => c.credentialId === input.credentialId)))
      throw new CommandError(404, 'unknown_credential', `No credential "${input.credentialId}".`);
    const c = pack.credentials[input.credentialId]!;
    return result(await c.check(input.secret, pack.normalize(input.target as TargetValues)));
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
    const { store, vault } = this.deps;
    const { entry, pack, spec } = this.resolve(intake.playbookId);
    const { playbook } = entry;
    const projectId = `prj-${randomUUID().slice(0, 8)}`;

    // A saved connection fills the tenant's facts and stands in for credentials not given.
    const connection = intake.connectionId ? await this.connection(intake.connectionId) : null;
    if (connection && connection.platform !== pack.id)
      throw new CommandError(
        422,
        'invalid',
        `${connection.name} is a ${connection.platform} connection; ${playbook.manifest.name} runs on ${pack.name}.`,
      );
    const repo = spec.source.repo === 'none' ? null : intake.source.repo;
    const url = spec.source.url === 'none' ? null : intake.source.url;
    if (spec.source.repo === 'required' && !repo)
      throw new CommandError(422, 'invalid', 'The source repository is required.');
    if (spec.source.url === 'required' && !url)
      throw new CommandError(422, 'invalid', 'The live site is required.');
    if (spec.source.repo !== 'none' && spec.source.url !== 'none' && !repo && !url)
      throw new CommandError(
        422,
        'invalid',
        'Give the source repository or the live site: without a repository, agents rebuild from the live site.',
      );
    const brief = briefOf(spec, intake.brief, repo ? [SOURCE_REPO] : []);
    let target: TargetValues;
    try {
      target = pack.normalize(
        validateTarget(spec, { ...intake.target, ...(connection?.target ?? {}) }),
      );
    } catch (err) {
      if (err instanceof IntakeError) throw new CommandError(422, 'invalid', err.message);
      throw err;
    }

    // The credentials this playbook takes: required ones must be given, and every one given
    // is checked server-side, whatever the wizard showed. Nothing is stored on a failure.
    const declared = spec.steps.flatMap((st) => st.credentials);
    const unknown = Object.keys(intake.credentials).filter(
      (id) => !declared.some((c) => c.credentialId === id),
    );
    if (unknown.length)
      throw new CommandError(422, 'invalid', `${playbook.manifest.name} takes no "${unknown[0]}".`);
    const shared = connection?.credentials ?? {};
    const given = await Promise.all(
      declared.map(async (c) => {
        const secret = intake.credentials[c.credentialId];
        const complete = secret && c.fields.every((f) => secret[f.key]?.trim());
        if (complete)
          return [
            { id: c.credentialId, spec: pack.credentials[c.credentialId]!, secret, from: null },
          ];
        const saved = shared[c.credentialId];
        if (saved) {
          const stored = JSON.parse(await vault.open(saved.reference)) as Record<string, string>;
          return [
            {
              id: c.credentialId,
              spec: pack.credentials[c.credentialId]!,
              secret: stored,
              from: saved,
            },
          ];
        }
        if (c.required) throw new CommandError(422, 'invalid', `${c.system} is required.`);
        return [];
      }),
    ).then((x) => x.flat());
    const checks = await Promise.all(
      given.map(async (g) => ({ ...g, r: await g.spec.check(g.secret, target) })),
    );
    const failed = checks.find((c) => !c.r.ok);
    if (failed)
      throw new CommandError(422, 'credential_failed', `${failed.spec.system}: ${failed.r.detail}`);

    const credentialEvents: NewEvent[] = [];
    for (const { id, spec: c, secret, r, from } of checks) {
      // A connection's secret is used by reference, so rotating it there reaches this project.
      const sealed = from
        ? { reference: from.reference }
        : await vault.seal(projectId, id, JSON.stringify(secret));
      credentialEvents.push(
        {
          type: 'credential.registered',
          actor: INTAKE,
          subject: { kind: 'tool', id },
          severity: 'routine',
          data: {
            credentialId: id,
            system: c.system,
            scope: c.scope(target),
            reference: sealed.reference,
            hint: from ? from.hint : tail(secret[c.hintField] ?? ''),
            expiresAt: null,
          },
        },
        {
          type: 'credential.verified',
          actor: INTAKE,
          subject: { kind: 'tool', id },
          severity: 'routine',
          data: { credentialId: id, ok: true, detail: r.detail, expiresAt: null },
        },
      );
    }
    // Repository access comes from the GitHub App. A repo it can't reach yet doesn't stop intake:
    // Settings shows why, and a re-check picks up the installation once the client adds it.
    if (repo)
      credentialEvents.push(...(await this.githubEvents(repo, intake.source.branch, INTAKE)));

    const described = pack.describe(target);
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
          site: { sourceUrl: url },
          brief,
          subtitle: repo ? `${repo} to ${pack.name}` : `${playbook.manifest.name}`,
          timezone: intake.timezone,
          source: { repo, url, framework: null, label: null },
          target: described.target,
          toolLabels: playbook.manifest.defaults.toolLabels,
          mode: 'live',
          intake: {
            platform: pack.id,
            repo,
            branch: repo ? intake.source.branch : null,
            target,
            connectionId: connection?.id ?? null,
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
            {
              label: 'Playbook',
              value: `${playbook.manifest.name} (${playbook.manifest.version})`,
            },
            ...(repo ? [{ label: 'Source', value: `${repo} (${intake.source.branch})` }] : []),
            { label: 'Target', value: described.label },
            ...(connection ? [{ label: 'Connection', value: connection.name }] : []),
            ...checks.map((c) => ({ label: c.spec.system, value: c.r.detail })),
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
    if (!s.buildRepo && s.intake && this.deps.buildOrg && this.deps.github) {
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
      playbookId: s.playbook?.id ?? 'sitecoreai-migration',
      features: this.featuresOf(s),
    });
  }

  /**
   * Creates the project's build repository in our organization from Sitecore's starter, or
   * checks and reuses one of that name. Named after the source repository, or after the project
   * when it has none (the live site is its source), unless told otherwise.
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
    const source = s.intake.repo ?? s.sourceUrl ?? s.name;
    const repoName =
      name ?? `${s.intake.repo ? s.intake.repo.split('/')[1] : slug(s.name)}-sitecoreai`;
    const buildRepo = await github.createBuildRepo(
      buildOrg,
      repoName,
      `${s.name}: SitecoreAI site built by Launchworks from ${source}.`,
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
   * their checks, the source site). Start runs it again from the beginning, on the catalog's
   * current version of its playbook. With `newBuildRepo`, it also lets go of the build repository
   * and the hosting record, so the next run builds in a new repository.
   */
  async reset(s: ProjectState, confirmation: string, newBuildRepo = false): Promise<void> {
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
    // The run starts over on the catalog's current version of the playbook: its phases and team
    // replace the ones pinned at intake.
    const current = s.playbook && this.deps.catalog.get(s.playbook.id)?.playbook;
    const released = newBuildRepo ? s.buildRepo?.repo : undefined;
    const kept = keep.flatMap((e) => {
      if (!newBuildRepo || e.type !== 'project.updated') return [e];
      const { buildRepo: _repo, hosting: _hosting, ...rest } = e.data;
      return Object.keys(rest).length ? [{ ...e, data: rest }] : [];
    });
    const repinned = (e: (typeof keep)[number]) =>
      e.type === 'project.created' && current
        ? {
            ...e.data,
            playbook: { id: current.manifest.id, version: current.manifest.version },
            phases: phaseDefs(current),
            roster: roster(current),
            toolLabels: current.manifest.defaults.toolLabels,
          }
        : e.data;
    await store.reset(s.projectId);
    await this.deps.blobs?.deleteProject(s.projectId);
    await store.append(s.projectId, [
      ...kept.map(
        (e) =>
          ({
            type: e.type,
            actor: e.actor,
            subject: e.subject,
            severity: e.severity,
            data: repinned(e),
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
          body: `The Director reset this project. The run so far, its decisions and its documents were removed; the intake facts, credentials and source site are kept.${current ? ` It now runs playbook v${current.manifest.version}.` : ''}${released ? ` It no longer builds in ${released}, which is left as it is: create a new build repository in Settings.` : ''} Press Start to run it again from the beginning.`,
        },
      },
    ]);
  }

  /**
   * Adds or replaces one of the credentials the project's playbook takes. It is checked against
   * its service first; on success it is sealed and recorded by reference, replacing the old one.
   */
  async setCredential(
    s: ProjectState,
    credentialId: string,
    secret: Record<string, string>,
  ): Promise<void> {
    if (s.mode !== 'live' || !s.intake) {
      throw new CommandError(409, 'not_live', 'Only real projects keep credentials.');
    }
    const declared = s.playbook
      ? this.resolve(s.playbook.id).spec.steps.flatMap((st) => st.credentials)
      : [];
    const spec = declared.find((c) => c.credentialId === credentialId);
    const pack = this.packOf(s);
    const c = pack?.credentials[credentialId];
    if (!spec || !c) {
      throw new CommandError(
        404,
        'unknown_credential',
        `This project's playbook takes no "${credentialId}".`,
      );
    }
    const missing = spec.fields.filter((f) => !secret[f.key]?.trim()).map((f) => f.label);
    if (missing.length)
      throw new CommandError(422, 'invalid', `${missing.join(' and ')} required.`);
    const clean = Object.fromEntries(spec.fields.map((f) => [f.key, secret[f.key]!.trim()]));
    const r = await c.check(clean, s.intake.target);
    if (!r.ok) throw new CommandError(422, 'credential_failed', `${c.system}: ${r.detail}`);
    const sealed = await this.deps.vault.seal(s.projectId, credentialId, JSON.stringify(clean));
    const actor = { kind: 'director', id: 'director' } as const;
    await this.deps.store.append(s.projectId, [
      {
        type: 'credential.registered',
        actor,
        subject: { kind: 'tool', id: credentialId },
        severity: 'notable',
        data: {
          credentialId,
          system: c.system,
          scope: c.scope(s.intake.target),
          reference: sealed.reference,
          hint: tail(clean[c.hintField] ?? ''),
          expiresAt: null,
        },
      },
      {
        type: 'credential.verified',
        actor,
        subject: { kind: 'tool', id: credentialId },
        severity: 'routine',
        data: { credentialId, ok: true, detail: r.detail, expiresAt: null },
      },
    ]);
  }

  /**
   * Answers or revises the brief. Agents read it from their next task; features it switches on
   * (personalization) shape the plan from the next start.
   */
  async setBrief(s: ProjectState, answers: Record<string, string>): Promise<void> {
    if (s.mode !== 'live' || !s.playbook) {
      throw new CommandError(409, 'not_live', 'Only real projects have a brief.');
    }
    const brief = briefOf(
      this.resolve(s.playbook.id).spec,
      answers,
      s.intake?.repo ? [SOURCE_REPO] : [],
    );
    await this.deps.store.append(s.projectId, [
      {
        type: 'project.updated',
        actor: { kind: 'director', id: 'director' },
        subject: { kind: 'project', id: s.projectId },
        severity: 'notable',
        data: { brief },
      },
    ]);
  }

  /**
   * Changes one intake value before Start (a hosting project name that turned out to be taken).
   * Values a credential check depends on stay as checked: change those by replacing the
   * credential's project instead.
   */
  async setTargetValue(s: ProjectState, key: string, value: string | string[]): Promise<void> {
    if (s.mode !== 'live' || !s.playbook || !s.intake) {
      throw new CommandError(409, 'not_live', 'Only real projects have intake values.');
    }
    if (s.status !== 'intake') {
      throw new CommandError(
        409,
        'started',
        'Intake values can only change before Start. Reset the project to change them.',
      );
    }
    const { pack, spec } = this.resolve(s.playbook.id);
    const field = spec.steps.flatMap((st) => st.fields).find((f) => f.key === key);
    if (!field) throw new CommandError(404, 'unknown_field', `This playbook has no "${key}".`);
    const checkedBy = spec.steps.flatMap((st) => st.credentials).find((c) => c.uses.includes(key));
    if (checkedBy) {
      throw new CommandError(
        409,
        'checked_value',
        `${field.label} is what the ${checkedBy.system} check was run against, so it can't change here.`,
      );
    }
    let target: TargetValues;
    try {
      target = pack.normalize(validateTarget(spec, { ...s.intake.target, [key]: value }));
    } catch (err) {
      if (err instanceof IntakeError) throw new CommandError(422, 'invalid', err.message);
      throw err;
    }
    await this.deps.store.append(s.projectId, [
      {
        type: 'project.updated',
        actor: { kind: 'director', id: 'director' },
        subject: { kind: 'project', id: s.projectId },
        severity: 'notable',
        data: { intakeTarget: { [key]: target[key]! }, target: pack.describe(target).target },
      },
    ]);
  }

  // ---- Saved connections ------------------------------------------------------------------

  private store(): IntegrationStore {
    if (!this.deps.connections)
      throw new CommandError(501, 'not_supported', 'Saved connections are not available here.');
    return this.deps.connections;
  }

  private async connection(id: string): Promise<ConnectionRecord> {
    const c = await this.store().get<ConnectionRecord>(CONNECTION + id);
    if (!c) throw new CommandError(404, 'unknown_connection', `No connection "${id}".`);
    return c;
  }

  /** Every saved connection, with the projects that use it. */
  async connections(projects: ProjectState[]): Promise<ConnectionView[]> {
    if (!this.deps.connections) return [];
    const rows = await this.deps.connections.list<ConnectionRecord>(CONNECTION);
    return rows.map(({ config: c }) => ({
      id: c.id,
      name: c.name,
      platform: c.platform,
      target: c.target,
      credentials: Object.entries(c.credentials).map(([credentialId, x]) => ({
        credentialId,
        system: x.system,
        hint: x.hint,
        checkedAt: x.checkedAt,
        ok: x.ok,
        detail: x.detail,
      })),
      createdAt: c.createdAt,
      createdFrom: c.createdFrom,
      projects: projects
        .filter((p) => p.intake?.connectionId === c.id)
        .map((p) => ({ id: p.projectId, name: p.name, status: p.status })),
    }));
  }

  /**
   * Saves a project's tenant as a connection: the target facts its platform shares across sites,
   * and those credentials, opened and sealed again to the connection (never shown to anyone).
   */
  async createConnection(s: ProjectState, name: string): Promise<string> {
    const pack = this.packOf(s);
    if (!pack || !s.intake)
      throw new CommandError(422, 'invalid', `${s.name} has no intake to save a connection from.`);
    if (!pack.connection)
      throw new CommandError(422, 'invalid', `${pack.name} projects don't share a tenant.`);
    const id = `con-${randomUUID().slice(0, 8)}`;
    const target: TargetValues = {};
    for (const f of pack.connection.fields)
      if (s.intake.target[f] !== undefined) target[f] = s.intake.target[f]!;
    const credentials: ConnectionRecord['credentials'] = {};
    for (const cid of pack.connection.credentials) {
      const c = s.credentials[cid];
      if (!c?.reference || c.reference.startsWith('github-app:')) continue;
      const secret = await this.deps.vault.open(c.reference);
      const sealed = await this.deps.vault.seal(CONNECTION + id, cid, secret);
      credentials[cid] = {
        reference: sealed.reference,
        system: c.system,
        hint: c.hint,
        checkedAt: c.verifiedAt ?? null,
        ok: c.ok,
        detail: c.detail ?? null,
      };
    }
    await this.store().put(CONNECTION + id, {
      id,
      name,
      platform: pack.id,
      target,
      credentials,
      createdAt: new Date().toISOString(),
      createdFrom: { projectId: s.projectId, name: s.name },
    } satisfies ConnectionRecord);
    return id;
  }

  /**
   * A new secret for a connection's credential: checked against the live service, sealed to the
   * connection, and given to every project that still uses the old one.
   */
  async rotateConnectionCredential(
    id: string,
    credentialId: string,
    secret: Record<string, string>,
    projects: ProjectState[],
  ): Promise<void> {
    const c = await this.connection(id);
    const pack = this.deps.platforms.get(c.platform);
    const spec = pack?.credentials[credentialId];
    if (!pack || !spec || !pack.connection?.credentials.includes(credentialId))
      throw new CommandError(404, 'unknown_credential', `${c.name} has no "${credentialId}".`);
    const r = await spec.check(secret, c.target);
    if (!r.ok) throw new CommandError(422, 'credential_failed', `${spec.system}: ${r.detail}`);
    const old = c.credentials[credentialId]?.reference ?? null;
    const sealed = await this.deps.vault.seal(
      CONNECTION + id,
      credentialId,
      JSON.stringify(secret),
    );
    const at = new Date().toISOString();
    c.credentials[credentialId] = {
      reference: sealed.reference,
      system: spec.system,
      hint: tail(secret[spec.hintField] ?? ''),
      checkedAt: at,
      ok: true,
      detail: r.detail,
    };
    await this.store().put(CONNECTION + id, c);
    // Projects that override it with their own secret keep theirs.
    const actor = { kind: 'director', id: 'director' } as const;
    for (const p of projects) {
      if (p.intake?.connectionId !== id) continue;
      const mine = p.credentials[credentialId];
      if (mine && mine.reference !== old) continue;
      await this.deps.store.append(p.projectId, [
        {
          type: 'credential.registered',
          actor,
          subject: { kind: 'tool', id: credentialId },
          severity: 'routine',
          data: {
            credentialId,
            system: spec.system,
            scope: spec.scope(p.intake.target),
            reference: sealed.reference,
            hint: c.credentials[credentialId]!.hint,
            expiresAt: null,
          },
        },
        {
          type: 'credential.verified',
          actor,
          subject: { kind: 'tool', id: credentialId },
          severity: 'routine',
          data: { credentialId, ok: true, detail: r.detail, expiresAt: null },
        },
      ]);
    }
  }

  /**
   * A new project's intake, prefilled from an existing one: same playbook, client, budgets, brief
   * and connection (the one it uses, or one saved from it), and the target facts the connection
   * shares. The site and its hosting are left for the Director.
   */
  async remixDraft(s: ProjectState): Promise<RemixDraft> {
    if (!s.playbook || !s.intake)
      throw new CommandError(422, 'invalid', `${s.name} has no intake to remix.`);
    const pack = this.packOf(s);
    let connection: ConnectionRecord | null = null;
    if (s.intake.connectionId) connection = await this.connection(s.intake.connectionId);
    else if (this.deps.connections) {
      const rows = await this.deps.connections.list<ConnectionRecord>(CONNECTION);
      connection =
        rows.find((r) => r.config.createdFrom?.projectId === s.projectId)?.config ?? null;
    }
    const sharedFields = pack?.connection?.fields ?? [];
    const target: TargetValues = {};
    for (const f of sharedFields)
      if (s.intake.target[f] !== undefined) target[f] = s.intake.target[f]!;
    return {
      playbookId: s.playbook.id,
      from: { projectId: s.projectId, name: s.name },
      connectionId: connection?.id ?? null,
      client: s.client,
      timezone: s.timezone,
      budgets: s.budgets,
      brief: Object.fromEntries(s.brief.map((b) => [b.key, b.answer])),
      target: { ...target, ...(connection?.target ?? {}) },
      providedCredentials: connection ? Object.keys(connection.credentials) : [],
    };
  }

  /** Re-checks a stored credential of a live project and records the outcome. */
  async reverify(s: ProjectState, credentialId: string): Promise<void> {
    const c = s.credentials[credentialId];
    if (!c) throw new CommandError(404, 'unknown_credential', `No credential "${credentialId}".`);
    if (credentialId === 'github' && s.intake?.repo) {
      // Re-finds the installation, so a repo the client installed the app on since is picked up.
      await this.deps.store.append(
        s.projectId,
        await this.githubEvents(s.intake.repo, s.intake.branch ?? 'main', {
          kind: 'director',
          id: 'director',
        }),
      );
      return;
    }
    if (!c.reference) {
      throw new CommandError(409, 'not_provided', `${c.system} hasn't been provided yet.`);
    }
    const spec = this.packOf(s)?.credentials[credentialId];
    if (!spec || !s.intake)
      throw new CommandError(501, 'not_supported', `${c.system} can't be checked here yet.`);
    const secret = JSON.parse(await this.deps.vault.open(c.reference)) as Record<string, string>;
    const r = await spec.check(secret, s.intake.target);
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

/** The brief as recorded: the playbook's questions only, required ones answered, choices valid. */
/**
 * The brief from the Director's answers: the questions this project is asked (a question with
 * `when: source-repo` only when it has a repository), checked against their kinds.
 */
function briefOf(
  spec: IntakeSpec,
  answers: Record<string, string>,
  features: string[],
): { key: string; label: string; answer: string }[] {
  const out: { key: string; label: string; answer: string }[] = [];
  for (const q of spec.brief.filter((q) => briefApplies(q, features))) {
    const answer = (answers[q.key] ?? '').trim();
    if (!answer) {
      if (q.required)
        throw new CommandError(422, 'invalid', `The brief needs an answer to "${q.label}".`);
      continue;
    }
    if (q.kind === 'yesno' && answer !== 'yes' && answer !== 'no')
      throw new CommandError(422, 'invalid', `"${q.label}" takes yes or no.`);
    if (q.kind === 'choice' && !q.options.includes(answer))
      throw new CommandError(422, 'invalid', `"${q.label}" takes one of: ${q.options.join(', ')}.`);
    out.push({ key: q.key, label: q.label, answer });
  }
  return out;
}

/** A repository-safe name: "Lambert's Cable" → "lamberts-cable". */
export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'site'
  );
}
