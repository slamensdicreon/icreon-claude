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
  ResolveEscalation,
  RollbackPhase,
  SendBackGate,
  SettingKey,
  type PolicyRow,
  type ActivityItem,
  type ActivityPage,
  type ApiError,
  type ArtifactView,
  type CommandResult,
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
import type { EventStore, Projections } from '@lw/events';
import { CommandError } from '@lw/domain';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ProjectCommands } from './commands';
import { registerGithubAuth, registerOriginCheck, type GithubAuthOptions } from './auth';
import type { GithubApp } from '@lw/connectors';
import type { IntakeService } from './intake';
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
    settingsView(known(req.params.id), deps.policyDefaults?.(req.params.id) ?? []),
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
      const { instructions } = RerunTask.parse(req.body);
      return command(req.params.id, (o) =>
        supported(o, 'rerunTask')(req.params.taskId, instructions),
      );
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
