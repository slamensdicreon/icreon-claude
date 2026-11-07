import cors from '@fastify/cors';
import {
  ApproveGate,
  ArchiveProject,
  ChangeSetting,
  ChangeBrief,
  ChangeBudgets,
  ChangeTargetValue,
  ChangeSourceSite,
  CreateBuildRepo,
  SetCredential,
  ResetProject,
  Control,
  ProjectIntake,
  VerifyIntakeCredential,
  DeferEscalation,
  PostMessage,
  RerunTask,
  CloseCapabilityGap,
  CompleteTasks,
  CreateConnection,
  AskCypher,
  AutonomySetting,
  CreateRule,
  EditRule,
  CreateKnowledge,
  EditKnowledge,
  RunRetrospective,
  DECISION_CATEGORY_LABEL,
  RotateConnectionCredential,
  ResolveEscalation,
  RollbackPhase,
  SendBackGate,
  SettingKey,
  type PolicyRow,
  type ActivityItem,
  type ActivityPage,
  type ApiError,
  type ArtifactView,
  type PlainVersion,
  type AutonomyLevel,
  type DecisionCategory,
  type CommandResult,
  type PortfolioDiagnostics,
  type PlaybookScorecard,
  type RuleDraftView,
  type KnowledgeEntry,
  type ServiceHealth,
  PortfolioActivityQuery,
  MePreferences,
} from '@lw/contracts';
import {
  agentDetail,
  conversation,
  decisions,
  factsSnapshot,
  knowledgeEffects,
  missionControl,
  plan,
  projectListItem,
  cardGroups,
  portfolioItem,
  scorecard,
  LOCKED_CATEGORIES,
  cardCategory,
  chosenOptionId,
  problemOf,
  preview,
  taskNames,
  scheduleSnapshot,
  settingsView,
  readMinutes,
  sinceSummary,
  team,
  toActivity,
  workbench,
  type ProjectState,
} from '@lw/domain';
import { Blueprint, blueprintSnapshot } from '@lw/plan';
import type {
  EventStore,
  IntegrationStore,
  KnowledgeStore,
  Projections,
  RuleStore,
} from '@lw/events';
import { CommandError } from '@lw/domain';
import { harvestRules, type OperatorNotice } from '@lw/stack';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ProjectCommands } from './commands';
import { registerGithubAuth, registerOriginCheck, type GithubAuthOptions } from './auth';
import type { GithubApp } from '@lw/connectors';
import type { IntakeService } from './intake';
import { PortfolioCypher } from './cypher';
import { projectHistory } from './history';
import type { ModelClient, RuleDraftInput } from '@lw/agent-runtime';
import { streamProject, type StreamOptions } from './sse';
import { activityCsv } from './activity-csv';
import { escalationsCsv } from './escalations-csv';
import { enrichEscalation, withDocumentVoice, withVoice } from './enrich';
import { withDocumentFacts, workbenchStory } from './story';
import { explainDocument, explainedWithoutModel } from './plain';
import { portfolioOverview, type LogCache } from './overview';
import {
  portfolioActivity,
  portfolioScorecard,
  portfolioTeam,
  portfolioWorkbench,
} from './portfolio';

export interface AppDeps {
  store: EventStore;
  projections: Projections;
  /** Command handlers for a project, or undefined if no such project runs here. */
  commands: (projectId: string) => ProjectCommands | undefined;
  /** The New Project wizard: credential checks, intake, start. Absent where intake isn't wired. */
  intake?: IntakeService;
  /** The Launchworks GitHub App (one for all projects). Absent where nothing can store its keys. */
  github?: GithubApp;
  /** Stored content of an artifact version, or null if none is stored. */
  artifactContent?: (projectId: string, ref: string) => Promise<Uint8Array | null>;
  /** The playbook's escalation policy table, for Settings. */
  policyDefaults?: (projectId: string) => PolicyRow[];
  /** The playbook's autonomy defaults for a project, for Settings and triage. */
  autonomyDefaults?: (projectId: string) => Partial<Record<DecisionCategory, AutonomyLevel>>;
  /** Server clock; tests pin it. */
  now?: () => number;
  /** Origin allowed to call the API from a browser (the Control Center or the prototype). */
  corsOrigin?: string | null;
  /** GitHub sign-in. Without it the API is open, which main.ts only allows on localhost. */
  auth?: GithubAuthOptions;
  /** More origins allowed to send commands besides the app's (a deployment's own URLs). */
  extraOrigins?: string[];
  /** Event stream timing; see StreamOptions. Defaults suit a long-running server. */
  stream?: Partial<Pick<StreamOptions, 'pollMs' | 'maxMs'>>;
  logger?: boolean;
  /**
   * Replays a project's answered cards through today's Lead, with only what was known when each
   * was raised, and keeps the results; null when no model is set up.
   */
  triageReplay?: {
    run(
      projectId: string,
      opts: { limit: number; fresh?: boolean },
    ): Promise<{ replayed: unknown[]; remaining: number; summary: unknown } | null>;
    results(projectId: string): Promise<{ cases: unknown[]; summary: unknown }>;
  } | null;
  /** Sends an Operator email as a test (Resend, to the configured recipients); null: not set up. */
  operatorTestEmail?: ((n: OperatorNotice, opts: { test: true }) => Promise<{ id: string }>) | null;
  /**
   * The watchdog over the worker (Vercel Cron calls it every few minutes): tells the Director once
   * when the worker has gone silent while a project runs, and once when it is back.
   */
  watchdog?: {
    run(opts: { scheduled: boolean }): Promise<unknown>;
    status(): Promise<{ scheduledAt: string | null; downAt: string | null }>;
  } | null;
  /** The worker's last heartbeat (it writes one every 30 s), for the Dashboard's diagnostics. */
  heartbeat?: () => Promise<WorkerHeartbeat | null>;
  /** Rules from the Director's answers, applied by Lead triage. Absent where nothing stores them. */
  rules?: RuleStore;
  /** Drafts a rule from an answered card (Claude); without it, the draft copies the card. */
  ruleDrafter?: ((input: RuleDraftInput) => Promise<{ when: string; then: string }>) | null;
  /** The team's knowledge across projects: lessons, procedures and gaps. */
  knowledge?: KnowledgeStore;
  /**
   * Runs a finished phase's retrospective (Cypher proposes entries with evidence); absent where
   * no model is configured.
   */
  retrospective?:
    | ((
        projectId: string,
        phase: number,
      ) => Promise<{ phase: number; summary: string; proposed: KnowledgeEntry[] }>)
    | null;
  /**
   * The head's hosting, set up from the Director's side the way a playbook's deployment steps do
   * it (Vercel project, environment from the vault, editing host, production, rendering host).
   * Absent where the server has no Vercel token or credential vault.
   */
  hosting?: {
    setup(projectId: string): Promise<unknown>;
    status(
      projectId: string,
      deploymentId: string,
    ): Promise<{ code: number; body: unknown; summary?: string }>;
  };
  /** Cypher on the Dashboard: the model (null where none is configured) and where it keeps the conversation. */
  cypher?: { model: ModelClient | null; store: IntegrationStore };
  /**
   * Where each operator's preferences are kept (`prefs:<login>` in the integrations table); without
   * it they live in this process's memory, which is enough for a local run.
   */
  preferences?: IntegrationStore | null;
}

/** What the worker reports about itself. */
export interface WorkerHeartbeat {
  at: string;
  version: string | null;
  /** Tool servers it connected, by name. */
  servers: string[];
  /** Roles that run on Claude here. */
  liveRoles: string[];
  temporal: boolean;
  /** Where the operator's notices go beyond the app: email recipients and sender, a webhook. */
  operator?: { emailTo: number; emailFrom: string | null; webhook: boolean };
}

type P = { Params: { id: string } };

const INSTALLED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Launchworks installed</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;
background:#f6f5f2;color:#1d1c1a}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem}
@media (prefers-color-scheme:dark){body{background:#161614;color:#ecebe7}}</style></head>
<body><main><h1>The Launchworks app is installed</h1><p>Thank you. The team can now reach the
repositories you selected. You can close this page; nothing else is needed from you.</p></main></body></html>`;

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return reply.status(status).send(body);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { store, projections } = deps;
  // With sign-in, browsers send the session cookie: CORS must name the Control Center exactly.
  const corsOrigin = deps.auth ? new URL(deps.auth.appUrl).origin : (deps.corsOrigin ?? null);
  // Capability gap keys are the capability in words, often well past Fastify's 100-character
  // default for a path parameter.
  const app = Fastify({ logger: deps.logger ?? false, maxParamLength: 1000 });
  await app.register(cors, { origin: corsOrigin ?? false, credentials: Boolean(deps.auth) });
  if (deps.auth) {
    registerGithubAuth(app, deps.auth);
    registerOriginCheck(app, [deps.auth.appUrl, deps.auth.publicUrl, ...(deps.extraOrigins ?? [])]);
  } else {
    // Local development: no sign-in, one operator on this machine.
    app.get('/auth/me', async () => ({ login: 'local', name: 'Director', avatarUrl: null }));
  }

  // The operator's preferences: the mode each screen was left in, so the Dial follows them to
  // another device. Keyed by login; a local run has one operator.
  const memoryPrefs = new Map<string, MePreferences>();
  const prefsKey = (req: { operator?: { login: string } }) =>
    `prefs:${req.operator?.login ?? 'local'}`;
  const readPrefs = async (key: string): Promise<MePreferences> => {
    const raw = deps.preferences ? await deps.preferences.get(key) : memoryPrefs.get(key);
    const parsed = MePreferences.safeParse(raw ?? {});
    return parsed.success ? parsed.data : { mode: {} };
  };
  app.get('/me/preferences', async (req): Promise<MePreferences> => readPrefs(prefsKey(req)));
  app.put('/me/preferences', async (req): Promise<MePreferences> => {
    const next = MePreferences.parse(req.body ?? {});
    if (Object.keys(next.mode).length > 60)
      throw new CommandError(400, 'too_many_screens', 'At most 60 screens are remembered.');
    const key = prefsKey(req);
    if (deps.preferences) await deps.preferences.put(key, next);
    else memoryPrefs.set(key, next);
    return next;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof CommandError) return fail(reply, err.status, err.code, err.message);
    if (err instanceof z.ZodError) {
      return fail(
        reply,
        400,
        'invalid_body',
        err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    // Fastify's own client errors (an empty or malformed JSON body, a body too large, an
    // unsupported content type) are the caller's to fix, not the server's.
    const { statusCode: status, code } = err as { statusCode?: unknown; code?: unknown };
    if (
      typeof code === 'string' &&
      code.startsWith('FST_') &&
      typeof status === 'number' &&
      status >= 400 &&
      status < 500
    ) {
      const message = err instanceof Error ? err.message : 'Bad request.';
      return fail(reply, status, 'bad_request', message);
    }
    app.log.error(err);
    return fail(
      reply,
      500,
      'internal',
      'The Control API hit an unexpected error. Check the server log.',
    );
  });

  // Every answer: never framed, never sniffed into something it is not, no referrer, and JSON that
  // could never run as a page. A route that sets its own policy (stored blobs) keeps it.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    if (!reply.hasHeader('content-security-policy'))
      reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });

  // Every project route answers from the head of the log: on a paused or fresh instance the read
  // model may be behind, or not folded yet.
  app.addHook('preHandler', async (req) => {
    const id = (req.params as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string' && req.url.startsWith('/projects/')) await projections.catchUp(id);
  });

  const project = (id: string): ProjectState | null => projections.get(id) ?? null;
  const orchestrator = (id: string): ProjectCommands => {
    const s = project(id);
    if (s?.mode === 'live' && s.status === 'intake') {
      throw new CommandError(
        409,
        'not_started',
        `${s.name} hasn't started yet. Start it from Mission Control first.`,
      );
    }
    const o = deps.commands(id);
    if (!o) throw new CommandError(404, 'unknown_project', `No project "${id}".`);
    return o;
  };
  /** The log position a project reached, once its read model has caught up to it. */
  const settled = async (projectId: string): Promise<CommandResult> => {
    const seq = await store.head(projectId);
    await projections.waitFor(projectId, seq);
    return { accepted: true, seq };
  };
  /** Runs a command, then answers with the log position it reached, so the UI can reconcile. */
  const command = async (projectId: string, fn: (o: ProjectCommands) => Promise<unknown>) => {
    await fn(orchestrator(projectId));
    return settled(projectId);
  };
  /** Project intake, or null after answering that this mode has none. */
  const intake = (reply: FastifyReply) => {
    if (!deps.intake) {
      fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
      return null;
    }
    return deps.intake;
  };

  app.get('/health', async () => ({ ok: true }));

  const github = (reply: FastifyReply) => {
    if (!deps.github) {
      fail(
        reply,
        501,
        'github_unavailable',
        'The GitHub App needs the credential vault (CREDENTIALS_KEY).',
      );
      return null;
    }
    return deps.github;
  };
  app.get('/integrations/github', async (_req, reply) => {
    const gh = github(reply);
    return gh ? gh.status() : reply;
  });
  app.post('/integrations/github/manifest', async (req, reply) => {
    const gh = github(reply);
    if (!gh) return reply;
    const { name } = z.object({ name: z.string().max(34).default('') }).parse(req.body ?? {});
    return gh.manifest(name);
  });
  // GitHub sends the operator back here after they confirm the app (signed in, so it's them).
  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/integrations/github/callback',
    async (req, reply) => {
      const gh = github(reply);
      if (!gh) return reply;
      // Back to the Control Center, which reads the outcome from the query and opens Settings.
      const back = new URL(gh.appUrl);
      try {
        if (!req.query.code || !req.query.state) {
          throw new CommandError(400, 'bad_request', 'GitHub did not send a code back.');
        }
        await gh.complete(req.query.code, req.query.state);
        back.searchParams.set('github', 'connected');
      } catch (err) {
        if (!(err instanceof CommandError)) app.log.error(err);
        back.searchParams.set('github', 'failed');
        back.searchParams.set(
          'reason',
          err instanceof CommandError
            ? err.message
            : 'Launchworks could not reach GitHub to finish. Start again from Settings.',
        );
      }
      return reply.redirect(back.toString());
    },
  );
  app.get('/integrations/github/installed', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(INSTALLED_PAGE),
  );

  app.get('/projects', async () => {
    await projections.catchUpAll();
    // Oldest first, however the read models were folded (on demand, they come in any order).
    return projections
      .all()
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
      .map((s) => ({ ...projectListItem(s), platform: deps.intake?.platformOf(s) }));
  });

  const now = deps.now ?? Date.now;

  // ---- Portfolio: the Dashboard above every project ---------------------------------------

  app.get('/portfolio', async () => {
    await projections.catchUpAll();
    return projections
      .all()
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .map(portfolioItem);
  });

  /** The Dashboard in both modes: Cypher's line, what's yours, every project, and the week. */
  const overviewLogs: LogCache = new Map();
  app.get('/portfolio/overview', async () => {
    await projections.catchUpAll();
    return portfolioOverview(
      projections.all(),
      (id, before, limit) => store.read(id, { before, limit, order: 'desc' }),
      now(),
      overviewLogs,
    );
  });

  /** The portfolio's Team, Workbench, Activity and Scorecard: each project page, across projects. */
  app.get('/portfolio/team', async () => {
    await projections.catchUpAll();
    return portfolioTeam(projections.all(), now());
  });
  app.get('/portfolio/workbench', async () => {
    await projections.catchUpAll();
    return portfolioWorkbench(projections.all(), now());
  });
  app.get('/portfolio/scorecard', async () => {
    await projections.catchUpAll();
    return portfolioScorecard(projections.all(), now());
  });
  app.get('/portfolio/activity', async (req) => {
    await projections.catchUpAll();
    const q = PortfolioActivityQuery.parse(req.query);
    return portfolioActivity(
      projections.all(),
      (id, before, limit) => store.read(id, { before, limit, order: 'desc' }),
      now(),
      q,
    );
  });

  app.get('/portfolio/diagnostics', async (): Promise<PortfolioDiagnostics> => {
    const at = new Date(now()).toISOString();
    const services: ServiceHealth[] = [
      { key: 'api', label: 'Control API', status: 'ok', detail: 'Answering', checkedAt: at },
    ];
    try {
      await projections.catchUpAll();
      services.push({
        key: 'database',
        label: 'Event log (Postgres)',
        status: 'ok',
        detail: `${projections.all().length} projects read`,
        checkedAt: at,
      });
    } catch (err) {
      services.push({
        key: 'database',
        label: 'Event log (Postgres)',
        status: 'down',
        detail: (err as Error).message.slice(0, 200),
        checkedAt: at,
      });
    }
    const beat = deps.heartbeat ? await deps.heartbeat().catch(() => null) : null;
    const age = beat ? (now() - Date.parse(beat.at)) / 1000 : null;
    services.push({
      key: 'worker',
      label: 'Agent worker',
      status: age === null ? 'unknown' : age < 120 ? 'ok' : age < 600 ? 'degraded' : 'down',
      detail: beat
        ? `Last seen ${Math.round(age!)} s ago${beat.version ? ` on ${beat.version.slice(0, 7)}` : ''}: ${beat.servers.length} tool servers, ${beat.liveRoles.length} roles on Claude`
        : deps.heartbeat
          ? 'No heartbeat yet'
          : 'Not reported in this mode',
      checkedAt: beat?.at ?? null,
    });
    if (beat?.operator) {
      const o = beat.operator;
      const ways = [
        o.emailTo
          ? `email to ${o.emailTo} recipient${o.emailTo === 1 ? '' : 's'} from ${o.emailFrom}`
          : '',
        o.webhook ? 'the webhook' : '',
      ].filter(Boolean);
      services.push({
        key: 'operator',
        label: 'Operator notices',
        status: ways.length ? 'ok' : 'degraded',
        detail: ways.length
          ? `In the project's conversation, and by ${ways.join(' and ')}`
          : "In the project's conversation only: set RESEND and OPERATOR_EMAIL_TO to email them",
        checkedAt: beat.at,
      });
    }
    if (deps.watchdog) {
      const w = await deps.watchdog.status().catch(() => null);
      const age = w?.scheduledAt ? (now() - Date.parse(w.scheduledAt)) / 60_000 : null;
      services.push({
        key: 'watchdog',
        label: 'Worker watchdog',
        status: age === null ? 'degraded' : age < 15 ? 'ok' : 'down',
        detail:
          age === null
            ? "Its scheduled check hasn't run yet: Vercel Cron calls it every 5 minutes with CRON_SECRET"
            : `Scheduled check ran ${Math.round(age)} min ago${w?.downAt ? `; the worker went silent at ${w.downAt.slice(11, 16)} UTC` : ''}${age >= 15 ? ': the cron has stopped calling it' : ''}`,
        checkedAt: w?.scheduledAt ?? null,
      });
    }
    services.push({
      key: 'temporal',
      label: 'Orchestration (Temporal)',
      status: beat ? (beat.temporal ? 'ok' : 'down') : 'unknown',
      detail: beat
        ? beat.temporal
          ? 'The worker is connected'
          : 'The worker is not connected'
        : 'Unknown without a worker heartbeat',
      checkedAt: beat?.at ?? null,
    });
    if (deps.github) {
      const gh = await deps.github.status().catch(() => null);
      services.push({
        key: 'github',
        label: 'GitHub App',
        status: !gh ? 'down' : gh.connected ? 'ok' : 'degraded',
        detail: !gh
          ? 'Could not be read'
          : gh.connected
            ? `${gh.app?.name ?? 'Connected'}, ${gh.installations.length} installation${gh.installations.length === 1 ? '' : 's'}`
            : 'Not set up: Settings, GitHub App',
        checkedAt: at,
      });
    }

    const day = 24 * 3_600_000;
    const projects = await Promise.all(
      projections
        .all()
        .filter((s) => s.mode === 'live')
        .map(async (s) => {
          const attention: string[] = [];
          const open = Object.values(s.escalations).filter((x) => x.status === 'open');
          const old = open.filter((x) => now() - Date.parse(x.raisedAt) > day);
          if (old.length)
            attention.push(`${old.length} card${old.length === 1 ? '' : 's'} waiting over a day`);
          const gaps = Object.values(s.capabilityGaps).filter((g) => !g.closedAt);
          if (gaps.length)
            attention.push(
              `${gaps.length} capability gap${gaps.length === 1 ? '' : 's'}: ${gaps
                .map((g) => g.capability)
                .slice(0, 2)
                .join('; ')}`,
            );
          const orchestrator = await orchestratorHealth(s.projectId, s.status);
          if (orchestrator.status === 'stalled') attention.unshift(orchestrator.detail);
          return {
            projectId: s.projectId,
            name: s.name,
            status: s.status,
            orchestrator,
            attention,
          };
        }),
    );
    return { services, projects };
  });

  /** The project workflow's state, from its history: running, stalled on a failed step, or ended. */
  async function orchestratorHealth(
    projectId: string,
    status: ProjectState['status'],
  ): Promise<PortfolioDiagnostics['projects'][number]['orchestrator']> {
    if (status === 'intake') return { status: 'ok', detail: 'Not started' };
    const o = deps.commands(projectId);
    if (!o?.diagnose) return { status: 'unknown', detail: 'Not available in this mode' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const d = (await Promise.race([
        o.diagnose(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out')), 8000);
        }),
      ])) as { status?: string; historyLength?: number; recent?: { type: string }[] };
      if (d.status && d.status !== 'RUNNING')
        return { status: 'ended', detail: `Workflow ${d.status.toLowerCase()}` };
      const last = d.recent?.[0]?.type ?? '';
      if (/TimedOut|Failed/.test(last))
        return {
          status: 'stalled',
          detail: `Orchestrator stuck: its last step ${last.replace(/^workflowTask/, '').toLowerCase()}`,
        };
      return { status: 'ok', detail: `Running (${d.historyLength ?? '?'} history events)` };
    } catch (err) {
      return { status: 'unknown', detail: `Could not be read: ${(err as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Saved connections and remix ---------------------------------------------------------

  app.get('/connections', async () => {
    await projections.catchUpAll();
    return deps.intake ? deps.intake.connections(projections.all()) : [];
  });

  app.post('/connections', async (req, reply) => {
    const service = intake(reply);
    if (!service) return;
    const { name, fromProject } = CreateConnection.parse(req.body);
    await projections.catchUp(fromProject);
    const s = project(fromProject);
    if (!s) return fail(reply, 404, 'unknown_project', `No project "${fromProject}".`);
    const id = await service.createConnection(s, name);
    return reply.status(201).send({ connectionId: id });
  });

  app.put<{ Params: { id: string; credentialId: string } }>(
    '/connections/:id/credentials/:credentialId',
    async (req, reply) => {
      const service = intake(reply);
      if (!service) return;
      const { secret } = RotateConnectionCredential.parse(req.body);
      await projections.catchUpAll();
      await service.rotateConnectionCredential(
        req.params.id,
        req.params.credentialId,
        secret,
        projections.all(),
      );
      return { ok: true };
    },
  );

  // ?playbook=<id> remixes the site onto another playbook on the same entity (a homepage demo).
  app.get<P & { Querystring: { playbook?: string } }>('/projects/:id/remix', async (req, reply) => {
    const service = intake(reply);
    if (!service) return;
    const s = project(req.params.id);
    if (!s) return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
    return service.remixDraft(s, req.query.playbook ?? null);
  });

  /** Tells rules how they did: the Director agreed with the answer they gave, or overrode it. */
  const ruleOutcome = async (
    ruleIds: string[],
    projectId: string,
    escalationId: string,
    agreed: boolean,
  ) => {
    for (const id of ruleIds) {
      const use = { projectId, escalationId };
      await (agreed ? deps.rules?.applied(id, use) : deps.rules?.overridden(id, use))?.catch(
        () => undefined,
      );
    }
  };

  // Rules: when this happens, do that. Lead triage applies the active ones in their scope.
  const rules = (reply: FastifyReply) => {
    if (!deps.rules) {
      fail(reply, 501, 'rules_unavailable', 'Rules need the database; this server has none.');
      return null;
    }
    return deps.rules;
  };
  const rule = async (reply: FastifyReply, id: string) => {
    const store = rules(reply);
    if (!store) return null;
    const r = await store.get(id);
    if (!r) {
      fail(reply, 404, 'unknown_rule', `No rule "${id}".`);
      return null;
    }
    return { store, r };
  };

  // Make this a rule: from a card the Director answered, a draft to edit and save.
  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/escalations/:escalationId/rule-draft',
    async (req, reply): Promise<RuleDraftView | undefined> => {
      const s = known(req.params.id);
      const x = s.escalations[req.params.escalationId];
      if (!x)
        return fail(
          reply,
          404,
          'unknown_escalation',
          `No escalation "${req.params.escalationId}".`,
        );
      const chosen = chosenOptionId(x);
      const answer = x.options.find((o) => o.id === chosen)?.label;
      if (!answer || x.gate)
        return fail(
          reply,
          409,
          'not_answered',
          x.gate
            ? 'Gates are always yours: they make no rules.'
            : 'Answer the card first: a rule says what you chose.',
        );
      const category = cardCategory(x);
      if (LOCKED_CATEGORIES.includes(category))
        return fail(
          reply,
          409,
          'locked',
          `${DECISION_CATEGORY_LABEL[category]} always come to you: a rule can't settle them.`,
        );
      const t = x.sourceTaskId ? s.tasks[x.sourceTaskId] : undefined;
      const names = (y: typeof x) =>
        taskNames(y.sourceTaskId ? s.tasks[y.sourceTaskId] : undefined);
      const problem = problemOf(x.title, names(x));
      // The same cause, answered the same way: evidence the rule holds.
      const similar = Object.values(s.escalations).filter((y) => {
        if (y.escalationId === x.escalationId || cardCategory(y) !== category) return false;
        const yChosen = chosenOptionId(y);
        const yAnswer = y.options.find((o) => o.id === yChosen)?.label;
        return yAnswer === answer && problemOf(y.title, names(y)) === problem;
      });
      const source = (y: typeof x) => ({
        projectId: s.projectId,
        escalationId: y.escalationId,
        title: y.title,
        answer,
      });
      const fallback = { when: x.title.replace(/[?.]$/, '').toLowerCase(), then: answer };
      let drafted: { when: string; then: string } = fallback;
      let draftedBy: RuleDraftView['draftedBy'] = 'copy';
      if (deps.ruleDrafter) {
        try {
          drafted = await deps.ruleDrafter({
            card: { title: x.title, context: x.context, options: x.options.map((o) => o.label) },
            answer,
            notes: x.resolution?.notes ?? null,
            role: t ? t.role : null,
            task: t?.title ?? null,
            similar: similar.slice(0, 8).map((y) => ({ title: y.title, answer })),
          });
          draftedBy = 'cypher';
        } catch {
          drafted = fallback;
        }
      }
      const playbook = s.playbook?.id;
      const platform = s.intake?.platform;
      return {
        ...drafted,
        category,
        roles: t ? [t.role] : [],
        scopes: [
          { kind: 'project', id: s.projectId, label: `This project (${s.name})` },
          ...(playbook
            ? [{ kind: 'playbook' as const, id: playbook, label: 'Every project on this playbook' }]
            : []),
          ...(platform
            ? [{ kind: 'platform' as const, id: platform, label: 'Every project on this platform' }]
            : []),
        ],
        sources: [x, ...similar.slice(0, 20)].map(source),
        draftedBy,
      };
    },
  );

  /**
   * Harvest: a project's answered cards grouped by cause and answer, each group seen at least
   * twice drafted into a proposed rule with its cards as evidence. Nothing applies until the
   * Director approves it (Rules, in the menu). Groups already behind a rule are skipped.
   */
  app.post<P>('/projects/:id/rules/harvest', async (req, reply) => {
    const store = rules(reply);
    if (!store) return;
    return harvestRules({ rules: store, drafter: deps.ruleDrafter }, known(req.params.id));
  });

  app.get<{ Querystring: { status?: string } }>('/rules', async (req, reply) => {
    const store = rules(reply);
    if (!store) return;
    const status = ['proposed', 'active', 'retired'].includes(req.query.status ?? '')
      ? (req.query.status as 'proposed' | 'active' | 'retired')
      : undefined;
    return store.list({ status });
  });

  app.post('/rules', async (req, reply) => {
    const store = rules(reply);
    if (!store) return;
    const input = CreateRule.parse(req.body);
    return reply.status(201).send(await store.create({ ...input, author: 'director' }));
  });

  app.put<{ Params: { id: string } }>('/rules/:id', async (req, reply) => {
    const found = await rule(reply, req.params.id);
    if (!found) return;
    return found.store.edit(found.r.id, EditRule.parse(req.body));
  });

  app.post<{ Params: { id: string; action: string } }>('/rules/:id/:action', async (req, reply) => {
    const status = { activate: 'active', retire: 'retired' }[req.params.action] as
      'active' | 'retired' | undefined;
    if (!status) return fail(reply, 404, 'unknown_action', `Rules can be activated or retired.`);
    const found = await rule(reply, req.params.id);
    if (!found) return;
    return found.store.setStatus(found.r.id, status);
  });

  app.get<{ Params: { id: string } }>('/rules/:id/history', async (req, reply) => {
    const found = await rule(reply, req.params.id);
    if (!found) return;
    return found.store.history(found.r.id);
  });

  // ---- Knowledge: what the team knows across projects ----------------------------------------

  const knowledge = (reply: FastifyReply) => {
    if (!deps.knowledge) {
      fail(
        reply,
        501,
        'knowledge_unavailable',
        'Knowledge needs the database; this server has none.',
      );
      return null;
    }
    return deps.knowledge;
  };
  const entry = async (reply: FastifyReply, id: string) => {
    const store = knowledge(reply);
    if (!store) return null;
    const e = await store.get(id);
    if (!e) {
      fail(reply, 404, 'unknown_entry', `No knowledge entry "${id}".`);
      return null;
    }
    return { store, e };
  };
  const pick = <T extends string>(v: string | undefined, allowed: readonly T[]) =>
    allowed.includes(v as T) ? (v as T) : undefined;

  app.get<{ Querystring: { status?: string; kind?: string; q?: string } }>(
    '/knowledge',
    async (req, reply) => {
      const store = knowledge(reply);
      if (!store) return;
      await projections.catchUpAll();
      return {
        entries: await store.list({
          status: pick(req.query.status, ['proposed', 'active', 'retired'] as const),
          kind: pick(req.query.kind, ['lesson', 'procedure', 'gap'] as const),
          q: req.query.q?.slice(0, 200),
        }),
        effects: knowledgeEffects(projections.all()),
      };
    },
  );

  /** The active lessons of a platform as a Markdown table, like the pitfalls file they replace. */
  app.get<{ Querystring: { platform?: string } }>('/knowledge/export', async (req, reply) => {
    const store = knowledge(reply);
    if (!store) return;
    const platform = req.query.platform ?? null;
    const rows = (await store.list({ status: 'active' })).filter(
      (e) =>
        e.kind !== 'gap' &&
        (!platform ||
          e.scope.kind === 'global' ||
          (e.scope.kind === 'platform' && e.scope.id === platform)),
    );
    const cell = (t: string) => t.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
    const md = [
      `## Known ${platform ?? ''} lessons`.replace(/\s+/g, ' '),
      '',
      '| Ref | Lesson | What to know | Applies to |',
      '| --- | --- | --- | --- |',
      ...rows.map(
        (e) =>
          `| ${e.ref} | ${cell(e.title)} | ${cell(e.text)} | ${cell(
            [
              e.scope.kind === 'global' ? 'everywhere' : `${e.scope.kind} ${e.scope.id}`,
              ...e.roles,
            ].join(', '),
          )} |`,
      ),
      '',
    ].join('\n');
    return reply.type('text/markdown; charset=utf-8').send(md);
  });

  app.post('/knowledge', async (req, reply) => {
    const store = knowledge(reply);
    if (!store) return;
    const input = CreateKnowledge.parse(req.body);
    return reply.status(201).send(await store.create({ ...input, author: 'director' }));
  });

  app.put<{ Params: { id: string } }>('/knowledge/:id', async (req, reply) => {
    const found = await entry(reply, req.params.id);
    if (!found) return;
    return found.store.edit(found.e.id, EditKnowledge.parse(req.body));
  });

  app.post<{ Params: { id: string; action: string } }>(
    '/knowledge/:id/:action',
    async (req, reply) => {
      const status = {
        approve: 'active',
        activate: 'active',
        retire: 'retired',
        reject: 'retired',
      }[req.params.action] as 'active' | 'retired' | undefined;
      if (!status)
        return fail(
          reply,
          404,
          'unknown_action',
          'Entries can be approved, activated, rejected or retired.',
        );
      const found = await entry(reply, req.params.id);
      if (!found) return;
      return found.store.setStatus(found.e.id, status);
    },
  );

  app.get<{ Params: { id: string } }>('/knowledge/:id/history', async (req, reply) => {
    const found = await entry(reply, req.params.id);
    if (!found) return;
    return found.store.history(found.e.id);
  });

  /** A project's retrospectives: its phases, which can run, and what each proposed. */
  app.get<P>('/projects/:id/lessons', async (req, reply) => {
    const store = knowledge(reply);
    if (!store) return;
    const s = known(req.params.id);
    const entries = await store.list({ projectId: s.projectId });
    return {
      phases: Object.values(s.phases)
        .sort((a, b) => a.number - b.number)
        .map((p) => ({
          phase: p.number,
          name: p.name,
          exited: p.status === 'done',
          proposed: entries.filter((e) => e.source?.phase === p.number).length,
        })),
      entries,
      available: !!deps.retrospective,
    };
  });

  app.post<P>('/projects/:id/retrospectives', async (req, reply) => {
    if (!knowledge(reply)) return;
    const s = known(req.params.id);
    if (!deps.retrospective)
      return fail(reply, 501, 'no_model', 'Retrospectives need Claude, and none is configured.');
    const { phase } = RunRetrospective.parse(req.body);
    if (!s.phases[phase]) return fail(reply, 404, 'unknown_phase', `No phase ${phase}.`);
    return deps.retrospective(s.projectId, phase);
  });

  // Cypher on the Dashboard: a conversation about the portfolio that can draft projects, never
  // create or change them.
  const cypher =
    deps.cypher && deps.intake
      ? new PortfolioCypher({
          ...deps.cypher,
          now,
          portfolio: async () => {
            await projections.catchUpAll();
            return projections.all().map(portfolioItem);
          },
          playbooks: () => deps.intake!.playbooks(),
          connections: async () => {
            await projections.catchUpAll();
            return deps.intake!.connections(projections.all());
          },
          detail: async (id) => {
            const s = project(id);
            if (!s) return null;
            const mc = missionControl(s);
            return { status: mc.subtitle, waitingOnYou: mc.waitingOnYou.map((w) => w.title) };
          },
          // Every card waiting on the Director in one project, with Cypher's words and pick.
          cards: async (id) => {
            await projections.catchUp(id);
            const s = project(id);
            if (!s) return null;
            return missionControl(s)
              .waitingOnYou.filter((x) => x.status === 'open')
              .map((x) => enrichEscalation(s, x))
              .map((x) => ({
                escalationId: x.escalationId,
                type: x.type,
                title: x.title,
                gist: x.gist ?? null,
                options: x.options.map((o) => ({
                  id: o.id,
                  label: o.label,
                  recommended: Boolean(o.recommended),
                })),
                defaultOptionId: x.defaultOptionId,
                recommendation: x.recommendation ?? null,
                alike: x.group ? x.group.escalationIds.length : 1,
                finalGate: Boolean(x.gate?.requiresConfirmation),
                locked: LOCKED_CATEGORIES.includes(cardCategory(x)),
              }));
          },
          // Answers one card as the Director, through the same path as their own click.
          answer: async (id, escalationId, optionId, notes) => {
            const { answered } = await resolveCard(id, escalationId, optionId, notes, true);
            return { answered };
          },
          remixDraft: async (id, playbookId) => {
            await projections.catchUp(id);
            const s = project(id);
            if (!s) throw new Error(`No project "${id}". Use list_projects for ids.`);
            return deps.intake!.remixDraft(s, playbookId);
          },
          history: async (id, search) => {
            await projections.catchUp(id);
            const s = project(id);
            if (!s) return null;
            return projectHistory(
              s,
              (before, limit) => deps.store.read(id, { before, limit, order: 'desc' }),
              search,
              {
                lessons: deps.knowledge
                  ? (await deps.knowledge.list({ projectId: id })).map((e) => ({
                      ref: e.ref,
                      status: e.status,
                      title: e.title,
                    }))
                  : [],
                now: now(),
              },
            );
          },
          rules: deps.rules,
          knowledge: deps.knowledge,
        })
      : null;

  // Saved conversations, newest first; a fresh one starts with the first message that names none.
  app.get('/cypher', async () =>
    cypher ? cypher.conversations() : { available: false, conversations: [] },
  );

  app.post('/cypher', async (req, reply) => {
    if (!cypher) return fail(reply, 501, 'cypher_unavailable', 'Cypher is not wired in this mode.');
    const { body, conversationId } = AskCypher.parse(req.body);
    return cypher.ask(body, conversationId);
  });

  app.get<{ Params: { id: string } }>('/cypher/:id', async (req, reply) => {
    const c = cypher ? await cypher.conversation(req.params.id) : null;
    return c ?? fail(reply, 404, 'unknown_conversation', 'No such conversation.');
  });

  app.delete<{ Params: { id: string } }>('/cypher/:id', async (req, reply) => {
    if (!cypher) return fail(reply, 501, 'cypher_unavailable', 'Cypher is not wired in this mode.');
    await cypher.remove(req.params.id);
    return { ok: true };
  });

  // The playbooks a new project can run: what each team delivers and what its intake collects.
  app.get('/playbooks', async (_req, reply) => {
    const service = intake(reply);
    if (!service) return;
    return service.playbooks();
  });

  app.post('/intake/verify', async (req, reply) => {
    const service = intake(reply);
    if (!service) return;
    return service.verify(VerifyIntakeCredential.parse(req.body));
  });

  app.post('/projects', async (req, reply) => {
    const service = intake(reply);
    if (!service) return;
    const projectId = await service.create(ProjectIntake.parse(req.body));
    await projections.catchUp(projectId);
    return reply.status(201).send({ projectId, canStart: service.canStart });
  });

  app.post<P>('/projects/:id/start', async (req, reply) => {
    const s = known(req.params.id);
    const service = intake(reply);
    if (!service) return;
    await service.start(s);
    const seq = await store.head(s.projectId);
    const r: CommandResult = { accepted: true, seq };
    return r;
  });

  // ---- Snapshots --------------------------------------------------------------------------

  /** Read-only: why a project's orchestrator is stuck, if it is (its last failed steps). */
  app.get<P>('/projects/:id/diagnostics', async (req, reply) => {
    if (!project(req.params.id))
      return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
    return supported(orchestrator(req.params.id), 'diagnose')();
  });

  // How the project's work went: cards by category and who settled them, reviews, waits.
  app.get<P>('/projects/:id/scorecard', async (req, reply) => {
    const s = project(req.params.id);
    return s
      ? scorecard(s, now())
      : fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
  });

  // Every project on a playbook side by side, newest first, so the next site compares with the last.
  app.get<P>('/playbooks/:id/scorecard', async (req): Promise<PlaybookScorecard> => {
    await projections.catchUpAll();
    return {
      playbookId: req.params.id,
      projects: projections
        .all()
        .filter((s) => s.playbook?.id === req.params.id && s.mode === 'live')
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
        .map((s) => ({
          projectId: s.projectId,
          name: s.name,
          status: s.status,
          version: s.playbook?.version ?? null,
          totals: scorecard(s, now()).totals,
        })),
    };
  });

  app.get<P>('/projects/:id/mission-control', async (req, reply) => {
    const s = project(req.params.id);
    if (!s) return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
    const mc = withVoice(missionControl(s), s, now());
    return { ...mc, project: { ...mc.project, platform: deps.intake?.platformOf(s) } };
  });

  app.get<P>('/projects/:id/team', async (req, reply) => {
    const s = project(req.params.id);
    return s ? team(s) : fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
  });

  app.get<{ Params: { id: string; agentId: string } }>(
    '/projects/:id/agents/:agentId',
    async (req, reply) => {
      const s = project(req.params.id);
      const a = s && agentDetail(s, req.params.agentId);
      return (
        a ?? fail(reply, 404, 'unknown_agent', `No agent "${req.params.agentId}" in this project.`)
      );
    },
  );

  app.get<P>('/projects/:id/plan', async (req, reply) => {
    const s = project(req.params.id);
    return s ? plan(s) : fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
  });

  app.get<{ Params: { id: string; taskId: string } }>(
    '/projects/:id/tasks/:taskId',
    async (req, reply) => {
      const t = project(req.params.id)?.tasks[req.params.taskId];
      return (
        t ?? fail(reply, 404, 'unknown_task', `No task "${req.params.taskId}" in this project.`)
      );
    },
  );

  app.get<P>('/projects/:id/conversation', async (req, reply) => {
    const s = project(req.params.id);
    return s
      ? conversation(s)
      : fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
  });

  app.get<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/escalations/:escalationId',
    async (req, reply) => {
      const x = project(req.params.id)?.escalations[req.params.escalationId];
      return (
        x ?? fail(reply, 404, 'unknown_escalation', `No escalation "${req.params.escalationId}".`)
      );
    },
  );

  app.get<P>('/projects/:id/decisions', async (req, reply) => {
    const s = project(req.params.id);
    return s ? decisions(s) : fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
  });

  // What the project's tasks made (IDs, paths), and changes that may have left finished work behind.
  app.get<P>('/projects/:id/facts', async (req, reply) => {
    const s = project(req.params.id);
    return s
      ? factsSnapshot(s)
      : fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
  });

  // Minutes to read a stored version, by its reference (a version never changes once saved).
  const readCache = new Map<string, number | null>();
  const minutesOf = async (projectId: string, a: ArtifactView): Promise<number | null> => {
    const v = a.versions.find((x) => x.version === a.latest) ?? a.versions[0];
    if (!v?.ref || !deps.artifactContent) return null;
    if (a.kind === 'pull_request' || a.kind === 'screenshot' || a.kind === 'video') return null;
    if (v.format !== 'markdown' && v.format !== 'json') return null;
    if (readCache.has(v.ref)) return readCache.get(v.ref)!;
    let minutes: number | null = null;
    try {
      const bytes = await deps.artifactContent(projectId, v.ref);
      if (bytes) {
        const text = new TextDecoder().decode(bytes);
        // A JSON document reads by its words, not its punctuation.
        minutes = readMinutes(v.format === 'json' ? text.replace(/[{}[\]",:]/g, ' ') : text);
      }
    } catch {
      minutes = null;
    }
    if (readCache.size > 2000) readCache.clear();
    readCache.set(v.ref, minutes);
    return minutes;
  };

  app.get<P>('/projects/:id/workbench', async (req, reply) => {
    const s = project(req.params.id);
    if (!s) return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
    const wb = withDocumentFacts(withDocumentVoice(workbench(s), s), s);
    const artifacts = await Promise.all(
      wb.artifacts.map(async (a) => ({ ...a, readMinutes: await minutesOf(req.params.id, a) })),
    );
    const told = { ...wb, artifacts };
    // Documents for the Director get their plain version written ahead of being opened.
    for (const x of artifacts)
      if (x.audience === 'director') writePlain(req.params.id, x, x.latest);
    return { ...told, story: workbenchStory(told, s) };
  });

  const artifact = (projectId: string, artifactId: string): ArtifactView => {
    const s = project(projectId);
    if (!s) throw new CommandError(404, 'unknown_project', `No project "${projectId}".`);
    const a = s.artifacts[artifactId];
    if (!a) throw new CommandError(404, 'unknown_artifact', `No artifact "${artifactId}".`);
    return a;
  };

  app.get<{ Params: { id: string; artifactId: string } }>(
    '/projects/:id/artifacts/:artifactId',
    async (req) => artifact(req.params.id, req.params.artifactId),
  );

  const CONTENT_TYPES = {
    markdown: 'text/markdown; charset=utf-8',
    json: 'application/json; charset=utf-8',
    png: 'image/png',
    binary: 'application/octet-stream',
  } as const;

  /** A version's stored content: `latest` or a version number. */
  app.get<{ Params: { id: string; artifactId: string; version: string } }>(
    '/projects/:id/artifacts/:artifactId/versions/:version/content',
    async (req, reply) => {
      const a = artifact(req.params.id, req.params.artifactId);
      const n = req.params.version === 'latest' ? a.latest : Number(req.params.version);
      const v = a.versions.find((x) => x.version === n);
      if (!v) return fail(reply, 404, 'unknown_version', `No version ${req.params.version}.`);
      const bytes =
        v.ref && deps.artifactContent ? await deps.artifactContent(req.params.id, v.ref) : null;
      if (!bytes) {
        return fail(
          reply,
          404,
          'no_content',
          `Version ${n} has no stored content (scripted projects record versions only).`,
        );
      }
      return reply
        .header('content-type', CONTENT_TYPES[v.format ?? 'binary'])
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(Buffer.from(bytes));
    },
  );

  // Cypher's plain version of a document version: written once per version by the model, kept as
  // an event so it survives restarts and replays, and served from the read model after that.
  const writingPlain = new Map<string, Promise<void>>();
  const enrichedDoc = (s: ProjectState, artifactId: string): ArtifactView | undefined =>
    withDocumentFacts(withDocumentVoice(workbench(s), s), s).artifacts.find(
      (x) => x.artifactId === artifactId,
    );
  const plainKey = (projectId: string, artifactId: string, version: number) =>
    `${projectId}:${artifactId}:${version}`;
  const writePlain = (
    projectId: string,
    a: ArtifactView,
    version: number,
    opts: { rewrite?: boolean; feedback?: string | null } = {},
  ): boolean => {
    const model = deps.cypher?.model;
    const v = a.versions.find((x) => x.version === version);
    if (!model || !deps.artifactContent || !v?.ref) return false;
    // Written once; again only when the Director asks.
    if (v.explained && !opts.rewrite) return false;
    const key = plainKey(projectId, a.artifactId, version);
    if (writingPlain.has(key)) return true;
    // A few at a time across the API; the rest wait for the next look. A rewrite the Director
    // asked for gets a little more room.
    if (writingPlain.size >= (opts.rewrite ? 6 : 4)) return false;
    const job = (async () => {
      const bytes = await deps.artifactContent!(projectId, v.ref!);
      if (!bytes) return;
      const out = await explainDocument(model, {
        kind: a.kind,
        title: a.title,
        audience: a.audience ?? 'team',
        format: v.format,
        content: new TextDecoder().decode(bytes),
        summary: v.summary ?? (version === a.latest ? a.summary : null),
        awaiting: version === a.latest && !!a.awaitingApproval,
        changedSinceApproval: version === a.latest && !!a.changedSinceApproval,
        feedback: opts.feedback ?? null,
      });
      if (!out) return;
      await store.append(projectId, [
        {
          type: 'artifact.explained',
          actor: { kind: 'chief_of_staff', id: 'chief-of-staff' },
          subject: { kind: 'artifact', id: a.artifactId },
          severity: 'routine',
          data: { artifactId: a.artifactId, version, ...out },
        },
      ]);
    })()
      .catch((err: unknown) => app.log.warn({ err, key }, 'plain version not written'))
      .finally(() => writingPlain.delete(key));
    writingPlain.set(key, job);
    return true;
  };

  app.get<{ Params: { id: string; artifactId: string; version: string } }>(
    '/projects/:id/artifacts/:artifactId/versions/:version/plain',
    async (req, reply): Promise<PlainVersion | void> => {
      const s = known(req.params.id);
      await projections.catchUp(req.params.id);
      const a = enrichedDoc(s, req.params.artifactId);
      if (!a)
        return fail(reply, 404, 'unknown_artifact', `No artifact "${req.params.artifactId}".`);
      const n = req.params.version === 'latest' ? a.latest : Number(req.params.version);
      const v = a.versions.find((x) => x.version === n);
      if (!v) return fail(reply, 404, 'unknown_version', `No version ${req.params.version}.`);
      const rewriting = writingPlain.has(plainKey(req.params.id, a.artifactId, n));
      if (v.explained)
        return {
          // A rewrite under way still shows the last plain version until the new one lands.
          status: rewriting ? 'writing' : 'ready',
          version: n,
          inShort: v.explained.inShort,
          means: v.explained.means,
          toDo: v.explained.toDo,
          plain: v.explained.plain,
          glossary: v.explained.glossary,
        };
      const writing = writePlain(req.params.id, a, n);
      const known_ = explainedWithoutModel({
        summary: v.summary ?? (n === a.latest ? a.summary : null),
        awaiting: n === a.latest && !!a.awaitingApproval,
        changedSinceApproval: n === a.latest && !!a.changedSinceApproval,
      });
      return {
        status: writing ? 'writing' : 'none',
        version: n,
        inShort: known_.inShort || null,
        means: [],
        toDo: known_.toDo,
        plain: null,
        glossary: [],
      };
    },
  );

  const RewriteBody = z.object({ note: z.string().trim().max(500).optional() }).default({});
  /** The Director asks for a new plain version, optionally saying what was wrong with the last. */
  app.post<{ Params: { id: string; artifactId: string; version: string } }>(
    '/projects/:id/artifacts/:artifactId/versions/:version/plain/rewrite',
    async (req, reply) => {
      const s = known(req.params.id);
      const body = RewriteBody.parse(req.body ?? {});
      if (!deps.cypher?.model)
        return fail(reply, 501, 'no_model', 'Plain versions need Claude, and none is configured.');
      const a = enrichedDoc(s, req.params.artifactId);
      if (!a)
        return fail(reply, 404, 'unknown_artifact', `No artifact "${req.params.artifactId}".`);
      const n = req.params.version === 'latest' ? a.latest : Number(req.params.version);
      if (!a.versions.some((x) => x.version === n))
        return fail(reply, 404, 'unknown_version', `No version ${req.params.version}.`);
      if (!writePlain(req.params.id, a, n, { rewrite: true, feedback: body.note || null }))
        return fail(
          reply,
          503,
          'busy',
          'Cypher is writing other plain versions. Try again in a minute.',
        );
      return reply.code(202).send({ status: 'writing', version: n });
    },
  );

  const known = (id: string): ProjectState => {
    const s = project(id);
    if (!s) throw new CommandError(404, 'unknown_project', `No project "${id}".`);
    return s;
  };

  /**
   * Proof before a project runs unattended: today's Lead answers the cards the Director answered,
   * knowing only what was known then, and agreement is kept by category. A batch per request
   * (`limit`, default 8); `remaining` says how many are left. `fresh` starts over.
   */
  app.post<P & { Body: { limit?: number; fresh?: boolean } | undefined }>(
    '/projects/:id/triage/replay',
    async (req, reply) => {
      known(req.params.id);
      if (!deps.triageReplay)
        return reply.status(409).send({
          error: 'replay_unavailable',
          message: 'Replaying needs a model (ANTHROPIC_API_KEY) and the integrations store.',
        });
      const limit = Math.min(25, Math.max(1, Math.floor(Number(req.body?.limit ?? 8)) || 8));
      return deps.triageReplay.run(req.params.id, { limit, fresh: req.body?.fresh === true });
    },
  );

  app.get('/portfolio/watchdog', async (req, reply) => {
    if (!deps.watchdog)
      return reply.status(409).send({ error: 'watchdog_unavailable', message: 'Not set up here.' });
    return deps.watchdog.run({ scheduled: req.operator?.login === 'vercel-cron' });
  });

  app.get<P>('/projects/:id/triage/replay', async (req, reply) => {
    known(req.params.id);
    if (!deps.triageReplay)
      return reply.status(409).send({ error: 'replay_unavailable', message: 'Not set up here.' });
    return deps.triageReplay.results(req.params.id);
  });

  /**
   * A test of the Operator's email: what it sends, to whom it sends it, with the project's open
   * cards as the example. Resend's reason comes back when it refuses (an unverified sender domain).
   */
  app.post<P>('/projects/:id/operator/test-email', async (req, reply) => {
    const s = known(req.params.id);
    if (!deps.operatorTestEmail)
      return fail(
        reply,
        409,
        'email_not_configured',
        "Set RESEND and OPERATOR_EMAIL_TO on the deployment to email the Operator's notices.",
      );
    const open = Object.values(s.escalations)
      .filter((e) => e.status === 'open')
      .slice(0, 5);
    const notice: OperatorNotice = {
      projectId: s.projectId,
      project: s.name,
      kind: 'attention',
      title: 'The Operator can reach you',
      body: `${s.name}: when a card no Lead can settle waits on you, nothing has moved for 30 minutes, or the team proposes what to learn, the Operator emails you once, like this.${open.length ? " Below are the project's open cards now." : ''}`,
      needs: open.map((e) => ({ escalationId: e.escalationId, type: e.type, title: e.title })),
    };
    try {
      return { sent: true, ...(await deps.operatorTestEmail(notice, { test: true })) };
    } catch (err) {
      return fail(reply, 502, 'email_failed', (err as Error).message);
    }
  });

  app.get<P>('/projects/:id/schedule', async (req) =>
    scheduleSnapshot(known(req.params.id), now()),
  );

  app.get<P>('/projects/:id/preview', async (req) => preview(known(req.params.id)));

  app.get<P>('/projects/:id/settings', async (req) => {
    const s = known(req.params.id);
    const chosen = Array.isArray(s.settings.standingApprovals)
      ? (s.settings.standingApprovals as string[])
      : [];
    return {
      ...settingsView(
        s,
        deps.policyDefaults?.(req.params.id) ?? [],
        deps.autonomyDefaults?.(req.params.id) ?? {},
      ),
      standingApprovals: (deps.intake?.releaseSteps(s) ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        byPlaybook: r.standing,
        approved: r.standing || chosen.includes(r.id),
      })),
    };
  });

  const readJson = async (projectId: string, ref: string | null) => {
    if (!ref || !deps.artifactContent) return null;
    const bytes = await deps.artifactContent(projectId, ref);
    return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as unknown) : null;
  };

  app.get<P>('/projects/:id/blueprint', async (req, reply) => {
    const s = known(req.params.id);
    const a = s.artifacts.blueprint;
    const latest = a?.versions.find((v) => v.ref);
    const current = latest ? Blueprint.safeParse(await readJson(s.projectId, latest.ref)) : null;
    if (!a || !latest || !current?.success) {
      return fail(reply, 404, 'no_blueprint', 'No Blueprint content has been written yet.');
    }
    const ok = a.approved[0];
    const approvedRef = ok ? a.versions.find((v) => v.version === ok.version)?.ref : null;
    const approved = approvedRef
      ? Blueprint.safeParse(await readJson(s.projectId, approvedRef))
      : null;
    return blueprintSnapshot({
      seq: s.seq,
      current: { version: latest.version, blueprint: current.data },
      approved:
        ok && approved?.success
          ? { version: ok.version, at: ok.at, blueprint: approved.data }
          : null,
      tasks: Object.values(s.tasks),
      decisions: s.decisions,
    });
  });

  app.get<P & { Querystring: { seq?: string } }>('/projects/:id/since', async (req) => {
    const s = known(req.params.id);
    const from = z.coerce
      .number()
      .int()
      .min(0)
      .parse(req.query.seq ?? s.seq);
    const events = await store.read(s.projectId, { after: Math.max(0, from - 2000) });
    return sinceSummary(s, events, from, now());
  });

  /** Screenshots and images a project's documents refer to (`blob://<project>/<key>`). */
  app.get<{ Params: { id: string; '*': string } }>('/projects/:id/blobs/*', async (req, reply) => {
    known(req.params.id);
    // A key never climbs out of its project's folder.
    if (req.params['*'].split('/').some((p) => p === '..' || p === '.' || p === ''))
      return fail(reply, 400, 'bad_ref', 'That is not a stored reference.');
    const ref = `blob://${req.params.id}/${req.params['*']}`;
    const bytes = deps.artifactContent ? await deps.artifactContent(req.params.id, ref) : null;
    if (!bytes) return fail(reply, 404, 'no_blob', 'Nothing is stored at that reference.');
    const ext = /\.([a-z0-9]+)$/i.exec(ref)?.[1]?.toLowerCase();
    const type =
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        json: 'application/json',
        md: 'text/markdown; charset=utf-8',
      }[ext ?? ''] ?? 'application/octet-stream';
    // What a client site served is untrusted: nothing stored here may run as the app. Raster images
    // show inline; anything else (an SVG can carry script) downloads, and none may script or frame.
    const raster = ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp';
    return reply
      .header('content-type', type)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-security-policy',
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      )
      .header('content-disposition', raster ? 'inline' : 'attachment')
      .send(Buffer.from(bytes));
  });

  const ActivityQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(2000).default(100),
    /** Rows at or after this instant only; paging stops there (the floor's replay window). */
    since: z.iso.datetime().optional(),
    severity: z.string().optional(), // comma-separated
    agent: z.string().optional(),
    type: z.string().optional(), // comma-separated
    phase: z.coerce.number().int().optional(),
    /** `log`: only the rows the Activity surface lists (tool calls, reviews, controls…). */
    view: z.enum(['all', 'log']).default('all'),
  });

  app.get<P & { Querystring: Record<string, string> }>(
    '/projects/:id/activity',
    async (req, reply) => {
      const s = project(req.params.id);
      if (!s) return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
      const q = ActivityQuery.parse(req.query);
      const severities = q.severity?.split(',');
      const types = q.type?.split(',');
      const keep = (i: ActivityItem) =>
        (q.view === 'all' || i.toolLabel !== null) &&
        (!severities || severities.includes(i.severity)) &&
        (!types || types.includes(i.type)) &&
        (!q.agent || i.agentId === q.agent) &&
        (q.phase === undefined || i.phase === q.phase);

      // Newest first, keyset-paginated on seq; read in chunks until the page is full or the
      // window's start is reached.
      const sinceMs = q.since ? Date.parse(q.since) : null;
      const items: ActivityItem[] = [];
      let before = q.before ?? s.seq + 1;
      let reachedSince = false;
      while (items.length < q.limit && before > 1 && !reachedSince) {
        const chunk = await store.read(s.projectId, { before, limit: 500, order: 'desc' });
        if (!chunk.length) break;
        for (const e of chunk) {
          if (sinceMs !== null && Date.parse(e.ts) < sinceMs) {
            reachedSince = true;
            break;
          }
          const item = toActivity(s, e);
          if (keep(item)) items.push(item);
          if (items.length === q.limit) break;
        }
        before = reachedSince
          ? 0
          : items.length === q.limit
            ? items.at(-1)!.seq
            : chunk.at(-1)!.seq;
      }
      const page: ActivityPage = { items, nextBefore: before > 1 ? before : null };
      return page;
    },
  );

  /**
   * What waits on the Director as a CSV download: open and deferred cards by default, `status=all`
   * for every card the project raised. Full context and options, oldest first.
   */
  app.get<P & { Querystring: { status?: string } }>(
    '/projects/:id/escalations.csv',
    async (req, reply) => {
      const s = project(req.params.id);
      if (!s) return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
      const want =
        req.query.status === 'all' ? null : (req.query.status ?? 'open,deferred').split(',');
      const cards = Object.values(s.escalations).filter((e) => !want || want.includes(e.status));
      const day = new Date().toISOString().slice(0, 10);
      const name = `${(s.name ?? s.projectId).replace(/[^A-Za-z0-9-]+/g, '-')}-needs-you-${day}.csv`;
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}"`)
        .header('cache-control', 'no-store')
        .send(
          `\uFEFF${escalationsCsv(
            cards,
            (id) => {
              const t = s.tasks[id];
              return t ? { title: t.title, phase: t.phase, agentId: t.agentId } : undefined;
            },
            (id) => s.agents[id],
          )}`,
        );
    },
  );

  /**
   * The activity log as a CSV download, oldest first, with full text: an audit trail to hand on.
   * Takes the Activity page's filters (view, severity, agent, phase) and an optional ISO `since`.
   */
  app.get<P & { Querystring: Record<string, string> }>(
    '/projects/:id/activity.csv',
    async (req, reply) => {
      const s = project(req.params.id);
      if (!s) return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
      const q = ActivityQuery.extend({
        view: z.enum(['all', 'log']).default('log'),
        since: z.iso.datetime({ offset: true }).optional(),
      }).parse({ ...req.query, limit: undefined });
      const severities = q.severity?.split(',');
      const types = q.type?.split(',');
      const since = q.since ? Date.parse(q.since) : null;
      const items: ActivityItem[] = [];
      let after = 0;
      const MAX = 200_000;
      while (items.length < MAX) {
        const chunk = await store.read(s.projectId, { after, limit: 1000 });
        if (!chunk.length) break;
        for (const e of chunk) {
          const i = toActivity(s, e);
          if (
            (q.view === 'all' || i.toolLabel !== null) &&
            (!severities || severities.includes(i.severity)) &&
            (!types || types.includes(i.type)) &&
            (!q.agent || i.agentId === q.agent) &&
            (q.phase === undefined || i.phase === q.phase) &&
            (since === null || Date.parse(i.ts) >= since)
          )
            items.push(i);
        }
        after = chunk.at(-1)!.seq;
      }
      const day = new Date().toISOString().slice(0, 10);
      const name = `${(s.name ?? s.projectId).replace(/[^A-Za-z0-9-]+/g, '-')}-activity-${day}.csv`;
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${name}"`)
        .header('cache-control', 'no-store')
        .send(`\uFEFF${activityCsv(items, (id) => s.agents[id])}`);
    },
  );

  app.get<P & { Querystring: { after?: string } }>('/projects/:id/stream', async (req, reply) => {
    if (!project(req.params.id))
      return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
    await streamProject(store, req.params.id, req, reply, {
      corsOrigin,
      withCredentials: Boolean(deps.auth),
      pollMs: deps.stream?.pollMs ?? 2_000,
      maxMs: deps.stream?.maxMs ?? null,
    });
  });

  // ---- Commands ---------------------------------------------------------------------------

  app.post<P>('/projects/:id/messages', async (req) => {
    const { body, about } = PostMessage.parse(req.body);
    return command(req.params.id, (o) => o.postMessage(body, about));
  });

  /** Commands only some runners support answer 501 elsewhere. */
  const supported = <K extends keyof ProjectCommands>(o: ProjectCommands, k: K) => {
    const fn = o[k];
    if (typeof fn !== 'function')
      throw new CommandError(
        501,
        'not_supported',
        `This project's runner does not support ${String(k)}.`,
      );
    return (fn as (...args: unknown[]) => Promise<unknown>).bind(o);
  };

  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/escalations/:escalationId/resume',
    async (req) => command(req.params.id, (o) => supported(o, 'resume')(req.params.escalationId)),
  );

  app.post<{ Params: { id: string; taskId: string } }>(
    '/projects/:id/tasks/:taskId/rerun',
    async (req) => {
      const { instructions, overriding } = RerunTask.parse(req.body);
      const card = overriding ? project(req.params.id)?.escalations[overriding] : undefined;
      const result = await command(req.params.id, (o) =>
        supported(o, 'rerunTask')(req.params.taskId, instructions),
      );
      // Overriding what a Lead settled by a rule counts against the rule.
      if (card?.triage?.mode === 'decided' && card.triage.ruleIds.length)
        await ruleOutcome(card.triage.ruleIds, req.params.id, card.escalationId, false);
      return result;
    },
  );

  app.post<{ Params: { id: string; key: string } }>(
    '/projects/:id/capability-gaps/:key/close',
    async (req) => {
      const { note } = CloseCapabilityGap.parse(req.body ?? {});
      const gap = project(req.params.id)?.capabilityGaps[req.params.key];
      if (!gap) throw new CommandError(404, 'not_found', 'No such capability gap.');
      const waiting = Object.keys(gap.tasks);
      if (!waiting.length)
        throw new CommandError(409, 'conflict', 'No task waits on this capability now.');
      const instructions = [
        `The capability you lacked is now available: ${gap.capability}. Carry on from where you stopped.`,
        note,
      ]
        .filter(Boolean)
        .join(' ');
      let last: CommandResult | null = null;
      for (const taskId of waiting)
        last = await command(req.params.id, (o) => supported(o, 'rerunTask')(taskId, instructions));
      return last!;
    },
  );

  app.post<{ Params: { id: string } }>('/projects/:id/tasks/complete', async (req) => {
    const { taskIds, note } = CompleteTasks.parse(req.body);
    return command(req.params.id, (o) => supported(o, 'completeTasks')(taskIds, note));
  });

  app.post<{ Params: { id: string; taskId: string } }>(
    '/projects/:id/tasks/:taskId/rollback',
    async (req) => command(req.params.id, (o) => supported(o, 'rollbackTask')(req.params.taskId)),
  );

  app.post<{ Params: { id: string; phase: string } }>(
    '/projects/:id/phases/:phase/rollback',
    async (req) => {
      RollbackPhase.parse(req.body);
      const phase = z.coerce.number().int().parse(req.params.phase);
      return command(req.params.id, (o) => supported(o, 'rollbackPhase')(phase));
    },
  );

  app.post<P>('/projects/:id/archive', async (req) => {
    const { confirmation } = ArchiveProject.parse(req.body);
    if (confirmation !== known(req.params.id).name)
      throw new CommandError(
        422,
        'confirmation_mismatch',
        'Type the project name exactly to archive it.',
      );
    return command(req.params.id, (o) => supported(o, 'archive')());
  });

  app.put<P>('/projects/:id/budgets', async (req) => {
    const budgets = ChangeBudgets.parse(req.body);
    return command(req.params.id, (o) => supported(o, 'changeBudgets')(budgets));
  });

  app.put<{ Params: { id: string; key: string } }>('/projects/:id/settings/:key', async (req) => {
    const key = SettingKey.parse(req.params.key);
    const { value } = ChangeSetting.parse(req.body);
    if (key === 'standingApprovals') {
      // Release steps of this project's playbook, approved once: their cards stop coming.
      const s = known(req.params.id);
      const ids = z.array(z.string().min(1)).max(20).parse(value);
      const releases = new Set((deps.intake?.releaseSteps(s) ?? []).map((r) => r.id));
      const unknown = ids.filter((id) => !releases.has(id));
      if (unknown.length)
        throw new CommandError(
          422,
          'invalid',
          `Not a release step of this project's playbook: ${unknown.join(', ')}. Release steps: ${[...releases].join(', ') || 'none'}.`,
        );
      await store.append(s.projectId, [
        {
          type: 'settings.changed',
          actor: { kind: 'director', id: 'director' },
          subject: { kind: 'project', id: s.projectId },
          severity: 'notable',
          data: { key, value: [...new Set(ids)] },
        },
      ]);
      return settled(s.projectId);
    }
    if (key === 'finishPastLimit') {
      // Read by the run when a task reaches its send-back limit: recorded, not sent to the run.
      const s = known(req.params.id);
      await store.append(s.projectId, [
        {
          type: 'settings.changed',
          actor: { kind: 'director', id: 'director' },
          subject: { kind: 'project', id: s.projectId },
          severity: 'notable',
          data: { key, value: z.boolean().parse(value) },
        },
      ]);
      return settled(s.projectId);
    }
    if (key === 'autonomy') {
      const levels = AutonomySetting.parse(value);
      const locked = LOCKED_CATEGORIES.find((c) => levels[c] && levels[c] !== 'ask');
      if (locked)
        throw new CommandError(
          422,
          'locked',
          `${DECISION_CATEGORY_LABEL[locked]} always come to you: they can't be handed to agents or Leads.`,
        );
      // Recorded in the log, not sent to the run: triage reads the level when a card comes up,
      // so the change applies to the next card on any project, live or simulated.
      const s = known(req.params.id);
      await store.append(s.projectId, [
        {
          type: 'settings.changed',
          actor: { kind: 'director', id: 'director' },
          subject: { kind: 'project', id: s.projectId },
          severity: 'notable',
          data: { key, value: levels },
        },
      ]);
      return settled(s.projectId);
    }
    return command(req.params.id, (o) => supported(o, 'changeSetting')(key, value));
  });

  app.post<P>('/projects/:id/reset', async (req, reply) => {
    const s = known(req.params.id);
    const service = intake(reply);
    if (!service) return;
    const { confirmation, newBuildRepo } = ResetProject.parse(req.body);
    await service.reset(s, confirmation, newBuildRepo);
    const seq = await store.head(s.projectId);
    await projections.catchUp(s.projectId);
    const r: CommandResult = { accepted: true, seq };
    return r;
  });

  // The head's hosting without a playbook run (a demo built by hand, or a host to rebuild): the
  // same tools and vault the agents use, so no secret passes through the Director.
  const hostable = (id: string) => {
    const s = known(id);
    if (s.mode !== 'live') {
      throw new CommandError(409, 'demo_project', 'A demo project has no hosting to set up.');
    }
    if (!deps.hosting) {
      throw new CommandError(
        503,
        'hosting_unconfigured',
        'Hosting needs the Vercel token and the credential vault on this server.',
      );
    }
    return { s, hosting: deps.hosting };
  };
  app.post<P>('/projects/:id/hosting/setup', async (req) => {
    const { s, hosting } = hostable(req.params.id);
    await projections.catchUp(s.projectId);
    return hosting.setup(s.projectId);
  });
  // A deployment's state; reading a ready integration build makes it the editing host.
  app.get<{ Params: { id: string; deploymentId: string } }>(
    '/projects/:id/hosting/deployments/:deploymentId',
    async (req, reply) => {
      const { s, hosting } = hostable(req.params.id);
      const r = await hosting.status(s.projectId, req.params.deploymentId);
      return reply.code(r.code).send({ ...(r.body as object), summary: r.summary ?? null });
    },
  );

  // The repository the new site is built in, for a project started before it was created
  // automatically, or after fixing the GitHub App's access to the organization.
  app.post<P>('/projects/:id/build-repo', async (req, reply) => {
    const s = known(req.params.id);
    const service = intake(reply);
    if (!service) return;
    await service.createBuildRepo(s, CreateBuildRepo.parse(req.body ?? {}).name);
    return settled(s.projectId);
  });

  app.put<P>('/projects/:id/brief', async (req, reply) => {
    const s = known(req.params.id);
    const service = intake(reply);
    if (!service) return;
    await service.setBrief(s, ChangeBrief.parse(req.body).answers);
    return settled(s.projectId);
  });

  // One intake value, changed before Start.
  app.put<{ Params: { id: string; key: string } }>(
    '/projects/:id/target/:key',
    async (req, reply) => {
      const s = known(req.params.id);
      const service = intake(reply);
      if (!service) return;
      await service.setTargetValue(s, req.params.key, ChangeTargetValue.parse(req.body).value);
      return settled(s.projectId);
    },
  );

  // The source site, set or corrected after intake. A live project's API records it itself: the
  // worker's tools and the agents' context read it from the log.
  app.put<P>('/projects/:id/source', async (req) => {
    const s = known(req.params.id);
    const { url } = ChangeSourceSite.parse(req.body);
    if (s.mode !== 'live') {
      throw new CommandError(409, 'demo_project', 'A demo project’s source site is scripted.');
    }
    await store.append(s.projectId, [
      {
        type: 'project.updated',
        actor: { kind: 'director', id: 'director' },
        subject: { kind: 'project', id: s.projectId },
        severity: 'notable',
        data: { sourceUrl: url },
      },
    ]);
    return settled(s.projectId);
  });

  app.put<{ Params: { id: string; credentialId: string } }>(
    '/projects/:id/credentials/:credentialId',
    async (req, reply) => {
      const s = known(req.params.id);
      const service = intake(reply);
      if (!service) return;
      await service.setCredential(s, req.params.credentialId, SetCredential.parse(req.body).secret);
      return settled(s.projectId);
    },
  );

  app.post<{ Params: { id: string; credentialId: string } }>(
    '/projects/:id/credentials/:credentialId/verify',
    async (req) => {
      const s = known(req.params.id);
      // A live project's credentials are in the vault: the API checks them itself.
      if (s.mode === 'live' && deps.intake) {
        await deps.intake.reverify(s, req.params.credentialId);
        return settled(s.projectId);
      }
      return command(req.params.id, (o) =>
        supported(o, 'verifyCredential')(req.params.credentialId),
      );
    },
  );

  app.get<P>('/projects/:id/scenarios', async (req) => {
    known(req.params.id);
    return deps.commands(req.params.id)?.scenarios?.() ?? [];
  });

  app.post<{ Params: { id: string; key: string } }>('/projects/:id/scenarios/:key', async (req) =>
    command(req.params.id, (o) => supported(o, 'runScenario')(req.params.key)),
  );

  /**
   * Answers a card as the Director: the same path whether the Director clicked or asked Cypher to.
   * A gate is refused (approve or send it back instead); with `all`, the rest of its group with the
   * same cause is answered the same way. A shadowed card tells its rule how it did.
   */
  const resolveCard = async (
    projectId: string,
    escalationId: string,
    optionId: string,
    notes: string | null,
    all: boolean,
  ) => {
    const s = project(projectId);
    const x = s?.escalations[escalationId];
    if (x?.type === 'gate')
      throw new CommandError(422, 'use_gate_endpoint', 'This is a gate: use approve or send-back.');
    // Read the group before answering: an answered card leaves it.
    const group =
      all && s ? cardGroups(Object.values(s.escalations), s.tasks).get(escalationId) : undefined;
    const result = await command(projectId, (o) => o.resolve(escalationId, optionId, notes));
    if (x?.triage?.mode === 'shadow' && x.triage.ruleIds.length)
      await ruleOutcome(
        x.triage.ruleIds,
        projectId,
        x.escalationId,
        optionId === x.triage.optionId,
      );
    // The rest of its group, the same way; a card answered meanwhile is left as it is.
    for (const id of group?.escalationIds ?? []) {
      if (id === escalationId) continue;
      await command(projectId, (o) => o.resolve(id, optionId, notes)).catch((e) => {
        if (!(e instanceof CommandError && e.status === 409)) throw e;
      });
    }
    return {
      result,
      answered: 1 + (group?.escalationIds.filter((id) => id !== escalationId).length ?? 0),
    };
  };

  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/escalations/:escalationId/resolve',
    async (req) => {
      const { optionId, notes, all } = ResolveEscalation.parse(req.body);
      return (
        await resolveCard(
          req.params.id,
          req.params.escalationId,
          optionId,
          notes || null,
          Boolean(all),
        )
      ).result;
    },
  );

  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/escalations/:escalationId/defer',
    async (req) => {
      const { until } = DeferEscalation.parse(req.body);
      return command(req.params.id, (o) => o.defer(req.params.escalationId, new Date(until)));
    },
  );

  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/escalations/:escalationId/undo',
    async (req) => command(req.params.id, (o) => o.undo(req.params.escalationId)),
  );

  const requireGate = (projectId: string, escalationId: string) => {
    const x = project(projectId)?.escalations[escalationId];
    if (!x) throw new CommandError(404, 'unknown_gate', `No gate "${escalationId}".`);
    if (x.type !== 'gate')
      throw new CommandError(422, 'not_a_gate', 'This escalation is not a gate.');
  };

  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/gates/:escalationId/approve',
    async (req) => {
      const { confirmation } = ApproveGate.parse(req.body ?? {});
      requireGate(req.params.id, req.params.escalationId);
      return command(req.params.id, (o) =>
        o.resolve(req.params.escalationId, 'approve', null, confirmation),
      );
    },
  );

  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/gates/:escalationId/send-back',
    async (req) => {
      const { notes } = SendBackGate.parse(req.body);
      requireGate(req.params.id, req.params.escalationId);
      return command(req.params.id, (o) => o.resolve(req.params.escalationId, 'send_back', notes));
    },
  );

  app.post<{ Params: { id: string; directiveId: string } }>(
    '/projects/:id/directives/:directiveId/stop',
    async (req) => command(req.params.id, (o) => o.stopDirective(req.params.directiveId)),
  );

  app.post<P>('/projects/:id/control', async (req) => {
    const cmd = Control.parse(req.body);
    return command(req.params.id, (o) => o.control(cmd));
  });

  return app;
}
