import { randomUUID } from 'node:crypto';
import type {
  ConnectionView,
  CypherConversation,
  CypherMessage,
  CypherProposal,
  PlaybookSummary,
  PortfolioItem,
  ProjectDraft,
  RemixDraft,
} from '@lw/contracts';
import type { ModelClient } from '@lw/agent-runtime';
import type { IntegrationStore } from '@lw/events';
import { CommandError } from '@lw/domain';

type CreateParams = Parameters<ModelClient['create']>[0];
type BetaMessageParam = CreateParams['messages'][number];
type BetaTool = NonNullable<CreateParams['tools']>[number];
type BetaContentBlock = Awaited<ReturnType<ModelClient['create']>>['content'][number];
type ToolResult = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

/** Where the conversation is kept: one portfolio conversation, the Director's. */
const KEY = 'cypher:portfolio';
/** Turns kept, and turns the model sees. */
const KEEP = 200;
const CONTEXT = 30;
const MAX_STEPS = 8;
const MODEL = 'claude-opus-5-5';

/** Defaults the wizard starts from when nothing says otherwise. */
const DEFAULT_BUDGETS = { usd: 1200, tokens: 8_000_000, hours: 240 };

export interface CypherDeps {
  model: ModelClient | null;
  store: IntegrationStore;
  portfolio(): Promise<PortfolioItem[]>;
  playbooks(): PlaybookSummary[];
  connections(): Promise<ConnectionView[]>;
  /** What one project is waiting on the Director for, and its status line. */
  detail(projectId: string): Promise<{ status: string; waitingOnYou: string[] } | null>;
  remixDraft(projectId: string): Promise<RemixDraft>;
  now?: () => number;
}

const SYSTEM = `You are Cypher, Chief of Staff at Launchworks, an agentic studio that migrates and builds websites with teams of AI agents. You talk with the Director (the human in charge) on the Dashboard, above any one project.

You help with two things:
1. The portfolio: where projects stand, what needs the Director, what's blocked, what was delivered. Read it with your tools before answering; never guess numbers or states. Name projects by name.
2. Starting projects. The Director gives a brief in their own words, or asks to set up a site "like" an existing project (a remix: same playbook, connection, brief and budgets, a new site).
   - Choose the playbook from list_playbooks that fits the brief. Say why in a sentence, and say plainly what the brief asks for that the playbook won't do.
   - Use a saved connection (list_connections) when the new site is on a tenant one already covers; its credentials are then reused and nothing is typed again.
   - A project needs a name, the client, and a source: the live site's URL, a GitHub repository (owner/name), or both. Without a repository the agents rebuild from the live site. Ask only for what's missing and can't be inferred; don't ask about budgets (the Director sets them in the wizard).
   - When you have enough, call propose_project or propose_remix. That only drafts: the Director opens it in the New Project wizard, reviews, adds any credentials and clicks Create. You never create, start, pause or change a project yourself, and you say so if asked.

Be brief and plain: short paragraphs or a few bullets, no headings. Today is {today}.`;

const TOOLS: BetaTool[] = [
  {
    name: 'list_projects',
    description:
      'Every project: status (intake = created, not started; running; paused; completed), health and why, current phase, phases done, how many decisions wait on the Director, budget and spend, source site, live site, and the playbook it runs.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'project_detail',
    description: "One project's status line and the titles of what waits on the Director.",
    input_schema: {
      type: 'object',
      properties: { projectId: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'list_playbooks',
    description:
      'The playbooks a new project can run: what each does, its platform, outcomes, phases, team, what intake needs (repository and/or live site) and its brief questions (key, question, options).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_connections',
    description:
      'Saved tenant connections: the platform, the shared facts (CM host, site collection, languages), which credentials they hold and whether those checked out, and the projects using them.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_project',
    description:
      'Draft a new project for the Director to open in the New Project wizard. Drafts only: nothing is created.',
    input_schema: {
      type: 'object',
      properties: {
        playbookId: { type: 'string' },
        name: { type: 'string', description: 'Project name, e.g. "Acme website".' },
        client: { type: 'string' },
        sourceUrl: { type: 'string', description: 'The live site, https://…' },
        repo: { type: 'string', description: 'GitHub owner/name, if there is one.' },
        branch: { type: 'string' },
        connectionId: { type: 'string', description: 'A saved connection to reuse.' },
        brief: {
          type: 'object',
          description: "Answers to the playbook's brief questions, by key, where the brief says.",
          additionalProperties: { type: 'string' },
        },
        reason: { type: 'string', description: 'Why this playbook, in a sentence or two.' },
        notCovered: {
          type: 'array',
          items: { type: 'string' },
          description: 'What the brief asks for that the playbook will not do.',
        },
      },
      required: ['playbookId', 'name', 'client', 'reason'],
    },
  },
  {
    name: 'propose_remix',
    description:
      'Draft a new project like an existing one (its playbook, connection, client, brief and budgets) for a new site, for the Director to open in the New Project wizard. Drafts only.',
    input_schema: {
      type: 'object',
      properties: {
        fromProjectId: { type: 'string' },
        name: { type: 'string' },
        client: { type: 'string', description: 'Only if different from the original.' },
        sourceUrl: { type: 'string' },
        repo: { type: 'string' },
        branch: { type: 'string' },
        brief: {
          type: 'object',
          description: 'Brief answers that differ from the original, by key.',
          additionalProperties: { type: 'string' },
        },
        reason: { type: 'string' },
      },
      required: ['fromProjectId', 'name', 'reason'],
    },
  },
];

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const URL_OK = /^https?:\/\/[^\s]+\.[^\s]+/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * Cypher on the Dashboard: a conversation about the whole portfolio, and the way to start a
 * project by describing it. Its tools read the portfolio, the playbook catalog and saved
 * connections, and draft projects; none creates, starts or changes anything.
 */
export class PortfolioCypher {
  constructor(private readonly deps: CypherDeps) {}

  get available(): boolean {
    return this.deps.model !== null;
  }

  async conversation(): Promise<CypherConversation> {
    return { available: this.available, messages: await this.messages() };
  }

  async clear(): Promise<void> {
    await this.deps.store.delete(KEY);
  }

  /** Answers the Director's message, keeping both in the conversation. */
  async ask(body: string): Promise<CypherConversation> {
    if (!this.deps.model)
      throw new CommandError(
        503,
        'cypher_unavailable',
        'Cypher needs the model, which is not configured on this server.',
      );
    const now = this.deps.now ?? Date.now;
    const history = await this.messages();
    const asked: CypherMessage = {
      id: randomUUID(),
      role: 'director',
      body,
      at: new Date(now()).toISOString(),
      proposals: [],
      projects: [],
    };
    const reply = await this.answer([...history, asked]);
    const messages = [...history, asked, { ...reply, at: new Date(now()).toISOString() }];
    await this.deps.store.put(KEY, { messages: messages.slice(-KEEP) });
    return { available: true, messages: messages.slice(-KEEP) };
  }

  private async messages(): Promise<CypherMessage[]> {
    return (await this.deps.store.get<{ messages: CypherMessage[] }>(KEY))?.messages ?? [];
  }

  private async answer(history: CypherMessage[]): Promise<CypherMessage> {
    const model = this.deps.model!;
    const messages: BetaMessageParam[] = history.slice(-CONTEXT).map((m) => ({
      role: m.role === 'director' ? 'user' : 'assistant',
      content:
        m.body +
        m.proposals
          .map(
            (p) =>
              `\n\n(Proposed ${p.kind === 'remix' ? `a remix of ${p.draft.from?.name}` : 'a project'}: "${p.draft.name}" on ${p.draft.playbookId}${p.draft.sourceUrl ? `, from ${p.draft.sourceUrl}` : ''}.)`,
          )
          .join(''),
    }));
    // The API wants the conversation to start with the Director.
    while (messages[0]?.role === 'assistant') messages.shift();
    const proposals: CypherProposal[] = [];
    const projects = new Map<string, string>();
    const system = SYSTEM.replace(
      '{today}',
      new Date((this.deps.now ?? Date.now)()).toISOString().slice(0, 10),
    );
    let text = '';
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await model.create({
        model: MODEL,
        max_tokens: 4000,
        system,
        tools: TOOLS,
        messages,
        output_config: { effort: 'medium' },
      });
      const said = response.content
        .filter((b): b is Extract<BetaContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (said) text = said;
      const uses = response.content.filter(
        (b): b is Extract<BetaContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      if (response.stop_reason !== 'tool_use' || !uses.length) break;
      messages.push({ role: 'assistant', content: response.content } as BetaMessageParam);
      const results: ToolResult[] = [];
      for (const use of uses) {
        try {
          const out = await this.tool(use.name, (use.input ?? {}) as Input, proposals, projects);
          results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(out) });
        } catch (err) {
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            is_error: true,
            content: err instanceof Error ? err.message : String(err),
          });
        }
      }
      messages.push({ role: 'user', content: results } as BetaMessageParam);
    }
    return {
      id: randomUUID(),
      role: 'cypher',
      body:
        text ||
        (proposals.length ? 'Here is the draft.' : 'I could not finish that. Ask me again?'),
      at: '',
      proposals,
      projects: [...projects].map(([id, name]) => ({ id, name })),
    };
  }

  private async tool(
    name: string,
    input: Input,
    proposals: CypherProposal[],
    projects: Map<string, string>,
  ): Promise<unknown> {
    switch (name) {
      case 'list_projects': {
        const items = (await this.deps.portfolio()).filter((p) => !p.demo);
        return items.map((p) => ({
          id: p.id,
          name: p.name,
          client: p.client,
          status: p.status,
          health: p.health,
          healthReason: p.healthReason,
          currentPhase: p.currentPhase,
          phases: p.phases,
          waitingOnDirector: p.waitingCount,
          blocked: p.hasOpenBlocker,
          playbook: p.playbook,
          budgets: p.budgets,
          spent: p.spent,
          sourceUrl: p.sourceUrl,
          liveUrl: p.liveUrl,
          startedAt: p.startedAt,
          lastActivityAt: p.lastActivityAt,
          capabilityGaps: p.capabilityGaps,
        }));
      }
      case 'project_detail': {
        const id = String(input.projectId ?? '');
        const p = (await this.deps.portfolio()).find((x) => x.id === id);
        if (!p) throw new Error(`No project "${id}". Use list_projects for ids.`);
        projects.set(p.id, p.name);
        return { name: p.name, ...(await this.deps.detail(id)) };
      }
      case 'list_playbooks':
        return this.deps.playbooks().map((b) => ({
          id: b.id,
          version: b.version,
          name: b.name,
          description: b.description,
          platform: b.platform.name,
          charter: b.charter,
          phases: b.phases.map(
            (ph) => `${ph.number} ${ph.name}${ph.gate ? ` (${ph.gate} gate)` : ''}`,
          ),
          team: b.roles.map((r) => `${r.name}: ${r.description}`),
          source: b.intake.source,
          brief: b.intake.brief,
        }));
      case 'list_connections':
        return (await this.deps.connections()).map((c) => ({
          id: c.id,
          name: c.name,
          platform: c.platform,
          target: c.target,
          credentials: c.credentials.map((k) => ({ system: k.system, ok: k.ok })),
          projects: c.projects.map((p) => p.name),
        }));
      case 'propose_project': {
        const draft = await this.newDraft(input);
        proposals.push({
          kind: 'new',
          reason: str(input.reason) ?? '',
          notCovered: Array.isArray(input.notCovered) ? input.notCovered.map(String) : [],
          draft,
        });
        return { drafted: true, note: 'Shown to the Director to open in the wizard.' };
      }
      case 'propose_remix': {
        const id = String(input.fromProjectId ?? '');
        const base = await this.deps.remixDraft(id);
        const draft: ProjectDraft = {
          ...base,
          ...this.source(input),
          name: this.name(input),
          client: str(input.client) ?? base.client,
          brief: { ...base.brief, ...this.brief(input, base.playbookId) },
        };
        projects.set(base.from.projectId, base.from.name);
        proposals.push({ kind: 'remix', reason: str(input.reason) ?? '', notCovered: [], draft });
        return { drafted: true, note: 'Shown to the Director to open in the wizard.' };
      }
      default:
        throw new Error(`No tool "${name}".`);
    }
  }

  private async newDraft(input: Input): Promise<ProjectDraft> {
    const playbook = this.deps.playbooks().find((b) => b.id === input.playbookId);
    if (!playbook)
      throw new Error(`No playbook "${String(input.playbookId)}". Use list_playbooks for ids.`);
    const client = str(input.client);
    if (!client) throw new Error('The client is required.');
    let connection: ConnectionView | null = null;
    const connectionId = str(input.connectionId);
    if (connectionId) {
      connection = (await this.deps.connections()).find((c) => c.id === connectionId) ?? null;
      if (!connection) throw new Error(`No connection "${connectionId}".`);
      if (connection.platform !== playbook.platform.id)
        throw new Error(
          `${connection.name} is a ${connection.platform} connection; ${playbook.name} runs on ${playbook.platform.name}.`,
        );
    }
    return {
      playbookId: playbook.id,
      from: null,
      connectionId: connection?.id ?? null,
      client,
      timezone: 'America/New_York',
      budgets: DEFAULT_BUDGETS,
      brief: this.brief(input, playbook.id),
      target: connection?.target ?? {},
      providedCredentials: connection?.credentials.map((c) => c.credentialId) ?? [],
      name: this.name(input),
      ...this.source(input),
    };
  }

  private name(input: Input): string {
    const name = str(input.name);
    if (!name) throw new Error('The project name is required.');
    return name.slice(0, 120);
  }

  private source(input: Input) {
    const sourceUrl = str(input.sourceUrl);
    const repo = str(input.repo);
    if (sourceUrl && !URL_OK.test(sourceUrl))
      throw new Error(`"${sourceUrl}" is not a site URL (https://…).`);
    if (repo && !REPO.test(repo)) throw new Error(`"${repo}" is not a GitHub owner/name.`);
    return { sourceUrl, repo, branch: str(input.branch) ?? 'main' };
  }

  /** Brief answers for questions the playbook asks; anything else is dropped. */
  private brief(input: Input, playbookId: string): Record<string, string> {
    const questions = this.deps.playbooks().find((b) => b.id === playbookId)?.intake.brief ?? [];
    const given = (input.brief ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
      questions
        .filter((q) => typeof given[q.key] === 'string' && (given[q.key] as string).trim())
        .map((q) => [q.key, (given[q.key] as string).trim()]),
    );
  }
}
