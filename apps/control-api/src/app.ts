import cors from '@fastify/cors';
import {
  ApproveGate,
  Control,
  DeferEscalation,
  PostMessage,
  ResolveEscalation,
  SendBackGate,
  type ActivityItem,
  type ActivityPage,
  type ApiError,
  type CommandResult,
} from '@lw/contracts';
import {
  agentDetail,
  conversation,
  decisions,
  missionControl,
  plan,
  projectListItem,
  team,
  toActivity,
  type ProjectState,
} from '@lw/domain';
import type { EventStore, Projections } from '@lw/events';
import { CommandError } from '@lw/domain';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ProjectCommands } from './commands';
import { streamProject } from './sse';

export interface AppDeps {
  store: EventStore;
  projections: Projections;
  /** Command handlers for a project, or undefined if no such project runs here. */
  commands: (projectId: string) => ProjectCommands | undefined;
  /** Intake: starts a new project and returns its id. Absent where intake isn't wired. */
  createProject?: (input: { name: string; client: string }) => Promise<string>;
  /** Origin allowed to call the API from a browser (the Control Center or the prototype). */
  corsOrigin?: string | null;
  logger?: boolean;
}

type P = { Params: { id: string } };

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  const body: ApiError = { error: { code, message } };
  return reply.status(status).send(body);
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { store, projections } = deps;
  const corsOrigin = deps.corsOrigin ?? null;
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(cors, { origin: corsOrigin ?? false });

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

  const project = (id: string): ProjectState | null => projections.get(id) ?? null;
  const orchestrator = (id: string): ProjectCommands => {
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

  app.get('/projects', async () => projections.all().map(projectListItem));

  const Intake = z.object({ name: z.string().min(1).max(120), client: z.string().min(1).max(120) });

  app.post('/projects', async (req, reply) => {
    if (!deps.createProject) {
      return fail(reply, 501, 'intake_unavailable', 'Project intake is not wired in this mode.');
    }
    const projectId = await deps.createProject(Intake.parse(req.body));
    return reply.status(201).send({ projectId });
  });

  // ---- Snapshots --------------------------------------------------------------------------

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

  const ActivityQuery = z.object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    severity: z.string().optional(), // comma-separated
    agent: z.string().optional(),
    type: z.string().optional(), // comma-separated
    phase: z.coerce.number().int().optional(),
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

  app.get<P & { Querystring: { after?: string } }>('/projects/:id/stream', async (req, reply) => {
    if (!project(req.params.id))
      return fail(reply, 404, 'unknown_project', `No project "${req.params.id}".`);
    await streamProject(store, req.params.id, req, reply, corsOrigin);
  });

  // ---- Commands ---------------------------------------------------------------------------

  app.post<P>('/projects/:id/messages', async (req) => {
    const { body } = PostMessage.parse(req.body);
    return command(req.params.id, (o) => o.postMessage(body));
  });

  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/escalations/:escalationId/resolve',
    async (req) => {
      const { optionId } = ResolveEscalation.parse(req.body);
      const x = project(req.params.id)?.escalations[req.params.escalationId];
      if (x?.type === 'gate')
        throw new CommandError(
          422,
          'use_gate_endpoint',
          'This is a gate: use approve or send-back.',
        );
      return command(req.params.id, (o) => o.resolve(req.params.escalationId, optionId));
    },
  );

  app.post<{ Params: { id: string; escalationId: string } }>(
    '/projects/:id/escalations/:escalationId/defer',
    async (req) => {
      const { until } = DeferEscalation.parse(req.body);
      return command(req.params.id, (o) => o.defer(req.params.escalationId, new Date(until)));
    },
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
