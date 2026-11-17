import { DecisionCategory, type PlaybookSummary } from '@lw/contracts';
import { CommandError } from '@lw/domain';
import type { KnowledgeStore, OrganizationStore, RuleStore } from '@lw/events';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { organizationOf, owns } from './organizations';

/**
 * An organization's variant of a playbook: its own rules and lessons on top of Icreon's, for its
 * projects only. Icreon's playbook never changes; Icreon sees every variant in its admin console
 * and can switch any rule or entry off there. A Director's own rules and lessons apply at once.
 */
export interface VariantDeps {
  rules?: RuleStore;
  knowledge?: KnowledgeStore;
  orgs?: OrganizationStore;
  /** The catalog: what a variant can be of. */
  playbooks: () => PlaybookSummary[];
  /** Which playbooks the request's organization licenses (all, without licenses). */
  licensed?: (req: FastifyRequest) => Promise<(playbookId: string, platformId: string) => boolean>;
}

/** Where an organization's own rule or entry applies: a playbook it licenses, or one project. */
const OwnScope = z.object({
  kind: z.enum(['playbook', 'project']),
  id: z.string().trim().min(1).max(120),
});
const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Roles = z.array(z.string().trim().min(1).max(80)).max(20);

const NewRule = z.object({
  when: Text(3, 600),
  then: Text(3, 600),
  category: DecisionCategory.default('other'),
  scope: OwnScope,
  roles: Roles.default([]),
});
const RuleEdit = z.object({
  when: Text(3, 600).optional(),
  then: Text(3, 600).optional(),
  category: DecisionCategory.optional(),
  roles: Roles.optional(),
});
const NewEntry = z.object({
  kind: z.enum(['lesson', 'procedure']).default('lesson'),
  title: Text(3, 200),
  text: Text(3, 2000),
  scope: OwnScope,
  roles: Roles.default([]),
});
const EntryEdit = z.object({
  kind: z.enum(['lesson', 'procedure']).optional(),
  title: Text(3, 200).optional(),
  text: Text(3, 2000).optional(),
  roles: Roles.optional(),
});

const STATUS: Record<string, 'active' | 'retired'> = { activate: 'active', retire: 'retired' };

export function registerVariants(app: FastifyInstance, deps: VariantDeps): void {
  const rulesOf = () => {
    if (!deps.rules) throw new CommandError(503, 'unavailable', 'Rules need the database.');
    return deps.rules;
  };
  const knowledgeOf = () => {
    if (!deps.knowledge) throw new CommandError(503, 'unavailable', 'Lessons need the database.');
    return deps.knowledge;
  };

  /** The playbooks the organization licenses: what its variants can be of. */
  const licensedPlaybooks = async (req: FastifyRequest) => {
    const ok = deps.licensed ? await deps.licensed(req) : () => true;
    return deps.playbooks().filter((p) => ok(p.id, p.platform.id));
  };

  /** A scope the organization may write to: a playbook it licenses, or one of its projects. */
  const checkScope = async (req: FastifyRequest, scope: z.infer<typeof OwnScope>) => {
    if (scope.kind === 'playbook') {
      if (!(await licensedPlaybooks(req)).some((p) => p.id === scope.id))
        throw new CommandError(
          422,
          'not_licensed',
          `"${scope.id}" is not a playbook your organization licenses.`,
        );
    } else if (!(await owns(deps.orgs, req, scope.id)))
      throw new CommandError(404, 'unknown_project', `No project "${scope.id}".`);
  };

  /** One of the organization's own; anything else answers as if it didn't exist. */
  const ownRule = async (req: FastifyRequest, id: string) => {
    const r = await rulesOf().get(id);
    if (!r || r.organizationId !== organizationOf(req))
      throw new CommandError(404, 'unknown_rule', `No rule "${id}".`);
    return r;
  };
  const ownEntry = async (req: FastifyRequest, id: string) => {
    const e = await knowledgeOf().get(id);
    if (!e || e.organizationId !== organizationOf(req))
      throw new CommandError(404, 'unknown_entry', `No lesson "${id}".`);
    return e;
  };

  app.get('/organization/variants', async (req) => {
    const organizationId = organizationOf(req);
    const [playbooks, rules, knowledge] = await Promise.all([
      licensedPlaybooks(req),
      deps.rules ? deps.rules.list({ organizationId }) : [],
      deps.knowledge ? deps.knowledge.list({ organizationId }) : [],
    ]);
    return {
      playbooks: playbooks.map((p) => ({ id: p.id, name: p.name, platform: p.platform })),
      rules,
      knowledge,
    };
  });

  app.post('/organization/rules', async (req, reply) => {
    const input = NewRule.parse(req.body ?? {});
    await checkScope(req, input.scope);
    const rule = await rulesOf().create({
      ...input,
      author: 'director',
      status: 'active',
      organizationId: organizationOf(req),
    });
    return reply.status(201).send(rule);
  });

  app.put<{ Params: { id: string } }>('/organization/rules/:id', async (req) => {
    const r = await ownRule(req, req.params.id);
    return rulesOf().edit(r.id, RuleEdit.parse(req.body ?? {}));
  });

  app.post<{ Params: { id: string; action: string } }>(
    '/organization/rules/:id/:action',
    async (req) => {
      const status = STATUS[req.params.action];
      if (!status)
        throw new CommandError(404, 'unknown_action', 'A rule can be activated or retired.');
      const r = await ownRule(req, req.params.id);
      return rulesOf().setStatus(r.id, status);
    },
  );

  app.get<{ Params: { id: string } }>('/organization/rules/:id/history', async (req) => {
    const r = await ownRule(req, req.params.id);
    return rulesOf().history(r.id);
  });

  app.post('/organization/knowledge', async (req, reply) => {
    const input = NewEntry.parse(req.body ?? {});
    await checkScope(req, input.scope);
    const entry = await knowledgeOf().create({
      ...input,
      author: 'director',
      status: 'active',
      organizationId: organizationOf(req),
    });
    return reply.status(201).send(entry);
  });

  app.put<{ Params: { id: string } }>('/organization/knowledge/:id', async (req) => {
    const e = await ownEntry(req, req.params.id);
    return knowledgeOf().edit(e.id, EntryEdit.parse(req.body ?? {}));
  });

  app.post<{ Params: { id: string; action: string } }>(
    '/organization/knowledge/:id/:action',
    async (req) => {
      const status = STATUS[req.params.action];
      if (!status)
        throw new CommandError(404, 'unknown_action', 'A lesson can be activated or retired.');
      const e = await ownEntry(req, req.params.id);
      return knowledgeOf().setStatus(e.id, status);
    },
  );

  app.get<{ Params: { id: string } }>('/organization/knowledge/:id/history', async (req) => {
    const e = await ownEntry(req, req.params.id);
    return knowledgeOf().history(e.id);
  });
}
