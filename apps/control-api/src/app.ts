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
  type AutonomyLevel,
  type DecisionCategory,
  type CommandResult,
  type PortfolioDiagnostics,
  type PlaybookScorecard,
  type RuleDraftView,
  type RuleView as RuleViewT,
  type EscalationView as EscalationViewT,
  type ServiceHealth,
} from '@lw/contracts';
import {
  agentDetail,
  conversation,
  decisions,
  missionControl,
  plan,
  projectListItem,
  cardGroups,
  isLogEvent,
  portfolioItem,
  scorecard,
  LOCKED_CATEGORIES,
  cardCategory,
  problemOf,
  preview,
  scheduleSnapshot,
  settingsView,
  sinceSummary,
  team,
  toActivity,
  workbench,
  type ProjectState,
} from '@lw/domain';
import { Blueprint, blueprintSnapshot } from '@lw/plan';
import type { EventStore, IntegrationStore, Projections, RuleStore } from '@lw/events';
import { CommandError } from '@lw/domain';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ProjectCommands } from './commands';
import { registerGithubAuth, registerOriginCheck, type GithubAuthOptions } from './auth';
import type { GithubApp } from '@lw/connectors';
import type { IntakeService } from './intake';
import { PortfolioCypher } from './cypher';
import type { ModelClient, RuleDraftInput } from '@lw/agent-runtime';
import { streamProject, type StreamOptions } from './sse';
import { activityCsv } from './activity-csv';
import { escalationsCsv } from './escalations-csv';

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
  /** The worker's last heartbeat (it writes one every 30 s), for the Dashboard's diagnostics. */
  heartbeat?: () => Promise<WorkerHeartbeat | null>;
  /** Rules from the Director's answers, applied by Lead triage. Absent where nothing stores them. */
  rules?: RuleStore;
  /** Drafts a rule from an answered card (Claude); without it, the draft copies the card. */
  ruleDrafter?: ((input: RuleDraftInput) => Promise<{ when: string; then: string }>) | null;
  /** Cypher on the Dashboard: the model (null where none is configured) and where it keeps the conversation. */
  cypher?: { model: ModelClient | null; store: IntegrationStore };
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
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(cors, { origin: corsOrigin ?? false, credentials: Boolean(deps.auth) });
  if (deps.auth) {
    registerGithubAuth(app, deps.auth);
    registerOriginCheck(app, [deps.auth.appUrl, deps.auth.publicUrl, ...(deps.extraOrigins ?? [])]);
  } else {
    // Local development: no sign-in, one operator on this machine.
    app.get('/auth/me', async () => ({ login: 'local', name: 'Director', avatarUrl: null }));
  }

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
    app.log.error(err);
    return fail(
      reply,
      500,
      'internal',
      'The Control API hit an unexpected error. Check the server log.',
    );
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
  /** Runs a command, then answers with the log position it reached, so the UI can reconcile. */
  const command = async (projectId: string, fn: (o: ProjectCommands) => Promise<unknown>) => {
    await fn(orchestrator(projectId));
    const seq = await store.head(projectId);
    await projections.waitFor(projectId, seq);
    const r: CommandResult = { accepted: true, seq };
    return r;
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
      .map(projectListItem);
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
    try {
      const d = (await Promise.race([
        o.diagnose(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 8000)),
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
    }
  }

  // ---- Saved connections and remix ---------------------------------------------------------

  app.get('/connections', async () => {
    await projections.catchUpAll();
    return deps.intake ? deps.intake.connections(projections.all()) : [];
  });

  app.post('/connections', async (req, reply) => {
    if (!deps.intake)
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    const { name, fromProject } = CreateConnection.parse(req.body);
    await projections.catchUp(fromProject);
    const s = project(fromProject);
    if (!s) return fail(reply, 404, 'unknown_project', `No project "${fromProject}".`);
    const id = await deps.intake.createConnection(s, name);
    return reply.status(201).send({ connectionId: id });
  });

  app.put<{ Params: { id: string; credentialId: string } }>(
    '/connections/:id/credentials/:credentialId',
    async (req, reply) => {
      if (!deps.intake)
        return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
      const { secret } = RotateConnectionCredential.parse(req.body);
      await projections.catchUpAll();
      await deps.intake.rotateConnectionCredential(
        req.params.id,
        req.params.credentialId,
        secret,
        projections.all(),
      );
      return { ok: true };
    },
  );

  app.get<P>('/projects/:id/remix', async (req, reply) => {
    if (!deps.intake)
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    await projections.catchUp(req.params.id);
    const s = project(req.params.id);
    if (!s) return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
    return deps.intake.remixDraft(s);
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
      const chosen = x.status === 'expired' ? x.defaultOptionId : x.resolution?.optionId;
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
      const names = (y: typeof x) => {
        const tk = y.sourceTaskId ? s.tasks[y.sourceTaskId] : undefined;
        return tk ? [tk.title, tk.taskId, ...tk.itemKeys] : [];
      };
      const problem = problemOf(x.title, names(x));
      // The same cause, answered the same way: evidence the rule holds.
      const similar = Object.values(s.escalations).filter((y) => {
        if (y.escalationId === x.escalationId || cardCategory(y) !== category) return false;
        const yChosen = y.status === 'expired' ? y.defaultOptionId : y.resolution?.optionId;
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
   * Director approves it (Dashboard → Rules). Groups already behind a rule are skipped.
   */
  app.post<P>('/projects/:id/rules/harvest', async (req, reply) => {
    const store = rules(reply);
    if (!store) return;
    const s = known(req.params.id);
    const names = (y: EscalationViewT) => {
      const tk = y.sourceTaskId ? s.tasks[y.sourceTaskId] : undefined;
      return tk ? [tk.title, tk.taskId, ...tk.itemKeys] : [];
    };
    const groups = new Map<
      string,
      { cards: EscalationViewT[]; answer: string; category: DecisionCategory }
    >();
    for (const y of Object.values(s.escalations)) {
      if (y.gate) continue;
      const category = cardCategory(y);
      if (LOCKED_CATEGORIES.includes(category)) continue;
      const chosen = y.status === 'expired' ? y.defaultOptionId : y.resolution?.optionId;
      const answer = y.options.find((o) => o.id === chosen)?.label;
      if (!answer) continue;
      const key = [category, problemOf(y.title, names(y)), answer].join('\n');
      const g = groups.get(key) ?? { cards: [], answer, category };
      g.cards.push(y);
      groups.set(key, g);
    }
    const covered = new Set(
      (await store.list())
        .filter((r) => r.status !== 'retired')
        .flatMap((r) => r.sources.map((x) => x.escalationId)),
    );
    const worth = [...groups.values()]
      .filter((g) => g.cards.length >= 2 && !g.cards.some((c) => covered.has(c.escalationId)))
      .sort((a, b) => b.cards.length - a.cards.length)
      .slice(0, 20);
    const created: RuleViewT[] = [];
    for (const g of worth) {
      const [first, ...rest] = g.cards;
      const t = first!.sourceTaskId ? s.tasks[first!.sourceTaskId] : undefined;
      let drafted = { when: first!.title.replace(/[?.]$/, '').toLowerCase(), then: g.answer };
      if (deps.ruleDrafter)
        drafted = await deps
          .ruleDrafter({
            card: {
              title: first!.title,
              context: first!.context,
              options: first!.options.map((o) => o.label),
            },
            answer: g.answer,
            notes: first!.resolution?.notes ?? null,
            role: t?.role ?? null,
            task: t?.title ?? null,
            similar: rest.slice(0, 8).map((y) => ({ title: y.title, answer: g.answer })),
          })
          .catch(() => drafted);
      created.push(
        await store.create({
          ...drafted,
          category: g.category,
          scope: s.playbook
            ? { kind: 'playbook', id: s.playbook.id }
            : { kind: 'project', id: s.projectId },
          sources: g.cards.slice(0, 20).map((y) => ({
            projectId: s.projectId,
            escalationId: y.escalationId,
            title: y.title,
            answer: g.answer,
          })),
          author: 'cypher',
          status: 'proposed',
        }),
      );
    }
    return { proposed: created, groups: groups.size };
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
          remixDraft: async (id) => {
            await projections.catchUp(id);
            const s = project(id);
            if (!s) throw new Error(`No project "${id}". Use list_projects for ids.`);
            return deps.intake!.remixDraft(s);
          },
        })
      : null;

  app.get('/cypher', async () =>
    cypher ? cypher.conversation() : { available: false, messages: [] },
  );

  app.post('/cypher', async (req, reply) => {
    if (!cypher) return fail(reply, 501, 'cypher_unavailable', 'Cypher is not wired in this mode.');
    return cypher.ask(AskCypher.parse(req.body).body);
  });

  app.delete('/cypher', async (_req, reply) => {
    if (!cypher) return fail(reply, 501, 'cypher_unavailable', 'Cypher is not wired in this mode.');
    await cypher.clear();
    return { ok: true };
  });

  // The playbooks a new project can run: what each team delivers and what its intake collects.
  app.get('/playbooks', async (_req, reply) => {
    if (!deps.intake) {
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    }
    return deps.intake.playbooks();
  });

  app.post('/intake/verify', async (req, reply) => {
    if (!deps.intake) {
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    }
    return deps.intake.verify(VerifyIntakeCredential.parse(req.body));
  });

  app.post('/projects', async (req, reply) => {
    if (!deps.intake) {
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    }
    const projectId = await deps.intake.create(ProjectIntake.parse(req.body));
    await projections.catchUp(projectId);
    return reply.status(201).send({ projectId, canStart: deps.intake.canStart });
  });

  app.post<P>('/projects/:id/start', async (req, reply) => {
    const s = known(req.params.id);
    if (!deps.intake) {
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    }
    await deps.intake.start(s);
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
    await projections.catchUp(req.params.id);
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
    return s
      ? missionControl(s)
      : fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
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

  app.get<P>('/projects/:id/workbench', async (req, reply) => {
    const s = project(req.params.id);
    return s ? workbench(s) : fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
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

  const clock = deps.now ?? Date.now;
  const known = (id: string): ProjectState => {
    const s = project(id);
    if (!s) throw new CommandError(404, 'unknown_project', `No project "${id}".`);
    return s;
  };

  app.get<P>('/projects/:id/schedule', async (req) =>
    scheduleSnapshot(known(req.params.id), clock()),
  );

  app.get<P>('/projects/:id/preview', async (req) => preview(known(req.params.id)));

  app.get<P>('/projects/:id/settings', async (req) =>
    settingsView(
      known(req.params.id),
      deps.policyDefaults?.(req.params.id) ?? [],
      deps.autonomyDefaults?.(req.params.id) ?? {},
    ),
  );

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
    return sinceSummary(s, events, from, clock());
  });

  /** Screenshots and images a project's documents refer to (`blob://<project>/<key>`). */
  app.get<{ Params: { id: string; '*': string } }>('/projects/:id/blobs/*', async (req, reply) => {
    known(req.params.id);
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
    return reply
      .header('content-type', type)
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(Buffer.from(bytes));
  });

  const ActivityQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
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

      // Newest first, keyset-paginated on seq; read in chunks until the page is full.
      const items: ActivityItem[] = [];
      let before = q.before ?? s.seq + 1;
      while (items.length < q.limit && before > 1) {
        const chunk = await store.read(s.projectId, { before, limit: 500, order: 'desc' });
        if (!chunk.length) break;
        for (const e of chunk) {
          const item = toActivity(s, e);
          if (keep(item)) items.push(item);
          if (items.length === q.limit) break;
        }
        before = items.length === q.limit ? items.at(-1)!.seq : chunk.at(-1)!.seq;
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
      const seq = await store.head(s.projectId);
      await projections.waitFor(s.projectId, seq);
      const r: CommandResult = { accepted: true, seq };
      return r;
    }
    return command(req.params.id, (o) => supported(o, 'changeSetting')(key, value));
  });

  app.post<P>('/projects/:id/reset', async (req, reply) => {
    const s = known(req.params.id);
    if (!deps.intake) {
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    }
    const { confirmation, newBuildRepo } = ResetProject.parse(req.body);
    await deps.intake.reset(s, confirmation, newBuildRepo);
    const seq = await store.head(s.projectId);
    await projections.catchUp(s.projectId);
    const r: CommandResult = { accepted: true, seq };
    return r;
  });

  // The repository the new site is built in, for a project started before it was created
  // automatically, or after fixing the GitHub App's access to the organization.
  app.post<P>('/projects/:id/build-repo', async (req, reply) => {
    const s = known(req.params.id);
    if (!deps.intake) {
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    }
    await deps.intake.createBuildRepo(s, CreateBuildRepo.parse(req.body ?? {}).name);
    const seq = await store.head(s.projectId);
    await projections.waitFor(s.projectId, seq);
    const r: CommandResult = { accepted: true, seq };
    return r;
  });

  app.put<P>('/projects/:id/brief', async (req, reply) => {
    const s = known(req.params.id);
    if (!deps.intake) {
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    }
    await deps.intake.setBrief(s, ChangeBrief.parse(req.body).answers);
    const seq = await store.head(s.projectId);
    await projections.waitFor(s.projectId, seq);
    const r: CommandResult = { accepted: true, seq };
    return r;
  });

  // One intake value, changed before Start.
  app.put<{ Params: { id: string; key: string } }>(
    '/projects/:id/target/:key',
    async (req, reply) => {
      const s = known(req.params.id);
      if (!deps.intake) {
        return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
      }
      await deps.intake.setTargetValue(s, req.params.key, ChangeTargetValue.parse(req.body).value);
      const seq = await store.head(s.projectId);
      await projections.waitFor(s.projectId, seq);
      const r: CommandResult = { accepted: true, seq };
      return r;
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
    const seq = await store.head(s.projectId);
    await projections.waitFor(s.projectId, seq);
    const r: CommandResult = { accepted: true, seq };
    return r;
  });

  app.put<{ Params: { id: string; credentialId: string } }>(
    '/projects/:id/credentials/:credentialId',
    async (req, reply) => {
      const s = known(req.params.id);
      if (!deps.intake) {
        return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
      }
      await deps.intake.setCredential(
        s,
        req.params.credentialId,
        SetCredential.parse(req.body).secret,
      );
      const seq = await store.head(s.projectId);
      await projections.waitFor(s.projectId, seq);
      const r: CommandResult = { accepted: true, seq };
      return r;
    },
  );

  app.post<{ Params: { id: string; credentialId: string } }>(
    '/projects/:id/credentials/:credentialId/verify',
    async (req) => {
      const s = known(req.params.id);
      // A live project's credentials are in the vault: the API checks them itself.
      if (s.mode === 'live' && deps.intake) {
        await deps.intake.reverify(s, req.params.credentialId);
        const seq = await store.head(s.projectId);
        await projections.waitFor(s.projectId, seq);
        const r: CommandResult = { accepted: true, seq };
        return r;
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

  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/escalations/:escalationId/resolve',
    async (req) => {
      const { optionId, notes, all } = ResolveEscalation.parse(req.body);
      const s = project(req.params.id);
      const x = s?.escalations[req.params.escalationId];
      if (x?.type === 'gate')
        throw new CommandError(
          422,
          'use_gate_endpoint',
          'This is a gate: use approve or send-back.',
        );
      // Read the group before answering: an answered card leaves it.
      const group =
        all && s
          ? cardGroups(Object.values(s.escalations), s.tasks).get(req.params.escalationId)
          : undefined;
      const result = await command(req.params.id, (o) =>
        o.resolve(req.params.escalationId, optionId, notes || null),
      );
      // A shadowed card the Lead answered by a rule: the Director's choice tells the rule how it did.
      if (x?.triage?.mode === 'shadow' && x.triage.ruleIds.length)
        await ruleOutcome(
          x.triage.ruleIds,
          req.params.id,
          x.escalationId,
          optionId === x.triage.optionId,
        );
      // The rest of its group, the same way; a card answered meanwhile is left as it is.
      for (const id of group?.escalationIds ?? []) {
        if (id === req.params.escalationId) continue;
        await command(req.params.id, (o) => o.resolve(id, optionId, notes || null)).catch((e) => {
          if (!(e instanceof CommandError && e.status === 409)) throw e;
        });
      }
      return result;
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
