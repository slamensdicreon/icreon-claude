import { randomUUID } from 'node:crypto';
import type {
  IntakeSpec,
  NewEvent,
  PlaybookSummary,
  ProjectIntake,
  VerifyIntakeCredential,
  VerifyIntakeResult,
} from '@lw/contracts';
import { CommandError, type ProjectState } from '@lw/domain';
import type { EventStore, SecretVault } from '@lw/events';
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
}

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

  /** The playbooks a new project can run, as the wizard shows them. */
  playbooks(): PlaybookSummary[] {
    return [...this.deps.catalog.values()].map((e) =>
      playbookSummary(e.playbook, this.resolve(e.playbook.manifest.id).pack),
    );
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

  /** Features the brief switched on: a yes to a question that names one. */
  private featuresOf(s: ProjectState): string[] {
    if (!s.playbook || !this.deps.catalog.has(s.playbook.id)) return [];
    const questions = this.resolve(s.playbook.id).spec.brief;
    return questions
      .filter((q) => q.feature && s.brief.find((b) => b.key === q.key)?.answer === 'yes')
      .map((q) => q.feature!);
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

    const repo = spec.source.repo === 'none' ? null : intake.source.repo;
    const url = spec.source.url === 'none' ? null : intake.source.url;
    if (spec.source.repo === 'required' && !repo)
      throw new CommandError(422, 'invalid', 'The source repository is required.');
    if (spec.source.url === 'required' && !url)
      throw new CommandError(422, 'invalid', 'The live site is required.');
    const brief = briefOf(spec, intake.brief);
    let target: TargetValues;
    try {
      target = pack.normalize(validateTarget(spec, intake.target));
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
    const given = declared.flatMap((c) => {
      const secret = intake.credentials[c.credentialId];
      const complete = secret && c.fields.every((f) => secret[f.key]?.trim());
      if (!complete) {
        if (c.required) throw new CommandError(422, 'invalid', `${c.system} is required.`);
        return [];
      }
      return [{ id: c.credentialId, spec: pack.credentials[c.credentialId]!, secret }];
    });
    const checks = await Promise.all(
      given.map(async (g) => ({ ...g, r: await g.spec.check(g.secret, target) })),
    );
    const failed = checks.find((c) => !c.r.ok);
    if (failed)
      throw new CommandError(422, 'credential_failed', `${failed.spec.system}: ${failed.r.detail}`);

    const credentialEvents: NewEvent[] = [];
    for (const { id, spec: c, secret, r } of checks) {
      const sealed = await vault.seal(projectId, id, JSON.stringify(secret));
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
            hint: tail(secret[c.hintField] ?? ''),
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
    if (!s.buildRepo && s.intake?.repo && this.deps.buildOrg && this.deps.github) {
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
   * checks and reuses one of that name. Named after the source repository unless told otherwise.
   */
  async createBuildRepo(s: ProjectState, name?: string): Promise<void> {
    if (s.mode !== 'live' || !s.intake?.repo) {
      throw new CommandError(
        409,
        'not_live',
        'Only real projects with a source repository have a build repository.',
      );
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
    const brief = briefOf(this.resolve(s.playbook.id).spec, answers);
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
function briefOf(
  spec: IntakeSpec,
  answers: Record<string, string>,
): { key: string; label: string; answer: string }[] {
  const out: { key: string; label: string; answer: string }[] = [];
  for (const q of spec.brief) {
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
