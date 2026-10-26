import { fileURLToPath } from 'node:url';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { LwEvent } from '@lw/contracts';
import { InMemoryEventStore } from '@lw/events';
import { compilePlan, type PlannedTask } from '@lw/plan';
import { loadPlaybook, type Playbook } from '@lw/playbook-sdk';
import {
  MemoryIdempotencyStore,
  TokenBucketLimiter,
  ToolGateway,
  type ToolResult,
  type ToolServer,
} from '@lw/tool-gateway';
import { beforeAll, describe, expect, it } from 'vitest';
import { AgentRuntime, costOf, PLATFORM_RULES, type ModelClient, type RunRequest } from '../src';

const DIR = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const SITE = '/sitecore/content/Acme/Corporate';

let pb: Playbook;
beforeAll(async () => {
  pb = await loadPlaybook(DIR);
});

type Block =
  { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
let ids = 0;
const text = (t: string): Block => ({ type: 'text', text: t });
const use = (name: string, input: unknown): Block => ({
  type: 'tool_use',
  id: `tu_${++ids}`,
  name,
  input,
});

function reply(
  content: Block[],
  stop: string,
  usage: Partial<BetaMessage['usage']> = {},
): BetaMessage {
  return {
    id: `msg_${++ids}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content,
    stop_reason: stop,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  } as unknown as BetaMessage;
}

/** Replays scripted turns and keeps every request it was sent. */
function scripted(
  turns: BetaMessage[],
): ModelClient & { requests: MessageCreateParamsNonStreaming[] } {
  const requests: MessageCreateParamsNonStreaming[] = [];
  return {
    requests,
    async create(params) {
      requests.push(structuredClone(params));
      const next = turns.shift();
      if (!next) throw new Error('script ran out of turns');
      return next;
    },
  };
}

function authoringServer(
  respond: (op: string, args: Record<string, unknown>) => ToolResult = () => ({
    code: 200,
    body: { created: true },
  }),
): ToolServer {
  return {
    name: 'sitecore-authoring',
    catalog: {
      'item.read': { mutates: false, pathArgs: ['path'], description: 'Read an item by path.' },
      'item.create': { mutates: true, pathArgs: ['path'], description: 'Create an item.' },
      'item.update': { mutates: true, pathArgs: ['path'] },
      'layout.compose': { mutates: true, pathArgs: ['path'] },
      'template.create': { mutates: true, pathArgs: ['path'] },
    },
    target: () => 'acme',
    call: async (op, args) => respond(op, args),
  };
}

function setup(model: ModelClient, servers: ToolServer[] = [authoringServer()]) {
  const store = new InMemoryEventStore();
  const gateway = new ToolGateway({
    playbook: pb,
    servers,
    bindings: () => ({ sitePath: SITE, module: 'Acme', project: 'acme' }),
    credentials: { tokenFor: async () => 'tok_test_1234567890' },
    idempotency: new MemoryIdempotencyStore(),
    rollback: { hasRecipe: async () => true },
    limiter: new TokenBucketLimiter(100, 100),
    store,
  });
  const runtime = new AgentRuntime({
    model,
    gateway,
    playbook: pb,
    store,
    context: { forTask: async () => 'Grid: Tailwind. Languages: en, fr-CA.' },
  });
  return { runtime, store };
}

function task(id: string): PlannedTask {
  const plan = compilePlan(pb, {
    version: 1,
    collections: {
      components: [{ key: 'hero', name: 'Hero', status: 'keep', pilot: true, attrs: {} }],
      templates: [{ key: 'home', name: 'Home Page', status: 'keep', pilot: false, attrs: {} }],
      pages: [{ key: 'about', name: 'About', status: 'keep', pilot: false, attrs: {} }],
      media: [{ key: 'logo', name: 'Logo', status: 'keep', pilot: false, attrs: {} }],
    },
  });
  return plan.tasks.find((t) => t.taskId === id)!;
}

const request = (taskId: string, extra: Partial<RunRequest> = {}): RunRequest => ({
  projectId: 'p1',
  task: task(taskId),
  attempt: 1,
  feedback: null,
  instructions: null,
  ...extra,
});

const steps = async (store: InMemoryEventStore) =>
  (await store.read('p1')).filter(
    (e): e is Extract<LwEvent, { type: 'step.recorded' }> => e.type === 'step.recorded',
  );

describe('AgentRuntime', () => {
  it('runs tool calls through the gateway and ends on submit_result', async () => {
    const model = scripted([
      reply(
        [
          text('Creating the page.'),
          use('sitecore-authoring__item_create', { path: `${SITE}/Home/About`, template: 'Page' }),
        ],
        'tool_use',
      ),
      reply(
        [
          use('submit_result', {
            status: 'done',
            summary: 'Created About under Home.',
            metrics: { pages: 1 },
          }),
        ],
        'tool_use',
      ),
    ]);
    const { runtime, store } = setup(model);
    const out = await runtime.run(
      request('migrate-pages-about', {
        feedback: 'Rich text lost its links',
        instructions: 'Keep the slug',
      }),
    );

    expect(out).toMatchObject({
      kind: 'done',
      summary: 'Created About under Home.',
      metrics: { pages: 1 },
    });
    expect(out.spent.tokens).toBe(2400);
    expect(out.spent.usd).toBeCloseTo(
      costOf('claude-sonnet-5-5', {
        input_tokens: 2000,
        output_tokens: 400,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }).usd,
    );

    const first = model.requests[0]!;
    expect(first.model).toBe('claude-sonnet-5-5');
    expect(first.output_config).toEqual({ effort: 'medium' });
    expect(first.fallbacks).toBe('default');
    expect(first.betas).toEqual(['server-side-fallback-2026-07-01']);
    const system = first.system as { text: string; cache_control?: unknown }[];
    expect(system[0]!.text).toBe(PLATFORM_RULES);
    expect(system[1]!.text).toContain('Content Migrator');
    expect(system[2]).toMatchObject({
      text: expect.stringContaining('Tailwind'),
      cache_control: { type: 'ephemeral' },
    });
    // Granted operations on connected servers only (no blackboard server here), plus submit.
    expect(first.tools!.map((t) => ('name' in t ? t.name : ''))).toEqual([
      'sitecore-authoring__item_create',
      'sitecore-authoring__item_read',
      'sitecore-authoring__item_update',
      'sitecore-authoring__layout_compose',
      'submit_result',
    ]);
    const brief = first.messages[0]!.content as string;
    expect(brief).toContain('Task: Migrate About');
    expect(brief).toContain('Your Lead rejected the previous attempt: Rich text lost its links');
    expect(brief).toContain('Instructions from the Director: Keep the slug');

    // The second turn carries the tool result, and history is only ever appended.
    const second = model.requests[1]!;
    expect(second.messages.slice(0, 1)).toEqual(first.messages);
    expect(second.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', content: JSON.stringify({ created: true }) }],
    });

    const recorded = (await steps(store)).map((s) => [
      s.data.toolServer,
      s.data.operation,
      s.data.resultCode,
    ]);
    expect(recorded).toEqual([
      ['model', 'claude-sonnet-5-5', 200],
      ['sitecore-authoring', 'item.create', 200],
      ['model', 'claude-sonnet-5-5', 200],
    ]);
  });

  it('returns gateway denials to the agent as tool errors, and lets it recover', async () => {
    const model = scripted([
      reply(
        [use('sitecore-authoring__item_create', { path: '/sitecore/templates/Project/acme/Page' })],
        'tool_use',
      ),
      reply(
        [use('submit_result', { status: 'done', summary: 'Used the Data folder instead.' })],
        'tool_use',
      ),
    ]);
    const { runtime } = setup(model);
    const out = await runtime.run(request('migrate-pages-about'));
    expect(out.kind).toBe('done');
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({
      content: [
        {
          type: 'tool_result',
          is_error: true,
          content: "/sitecore/templates/Project/acme/Page is outside content-migrator's scope.",
        },
      ],
    });
  });

  it('stops with access_denied when a target refuses the credential', async () => {
    const model = scripted([
      reply([use('sitecore-authoring__item_create', { path: `${SITE}/Home/A` })], 'tool_use'),
    ]);
    const { runtime } = setup(model, [authoringServer(() => ({ code: 403, body: null }))]);
    expect(await runtime.run(request('migrate-pages-about'))).toMatchObject({
      kind: 'access_denied',
      message:
        "sitecore-authoring returned 403 for item.create. Re-verify the credential's scope in Settings.",
    });
  });

  it('surfaces a decision the agent cannot make on its own', async () => {
    const decision = {
      question: 'Hero has five layouts. One rendering or five?',
      options: ['One with variants', 'Five renderings'],
      recommended: 'One with variants',
    };
    const model = scripted([
      reply(
        [
          use('submit_result', {
            status: 'needs_decision',
            summary: 'Blocked on granularity.',
            decision,
          }),
        ],
        'tool_use',
      ),
    ]);
    const { runtime } = setup(model);
    expect(await runtime.run(request('migrate-pages-about'))).toMatchObject({
      kind: 'needs_decision',
      decision,
    });
  });

  it('rejects a malformed submit and lets the agent correct it', async () => {
    const model = scripted([
      reply([use('submit_result', { status: 'needs_decision', summary: 'Stuck' })], 'tool_use'),
      reply([use('submit_result', { status: 'done', summary: 'Done after all.' })], 'tool_use'),
    ]);
    const { runtime } = setup(model);
    expect(await runtime.run(request('migrate-pages-about'))).toMatchObject({
      kind: 'done',
      summary: 'Done after all.',
    });
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ content: [{ is_error: true }] });
  });

  it('retries a truncated turn with more room instead of running a cut-off tool call', async () => {
    const model = scripted([
      reply([use('sitecore-authoring__item_create', { path: `${SITE}/Ho` })], 'max_tokens'),
      reply([use('submit_result', { status: 'done', summary: 'ok' })], 'tool_use'),
    ]);
    const { runtime, store } = setup(model);
    expect((await runtime.run(request('migrate-pages-about'))).kind).toBe('done');
    expect(model.requests.map((r) => r.max_tokens)).toEqual([16_000, 32_000]);
    expect((await steps(store)).some((s) => s.data.operation === 'item.create')).toBe(false);
  });

  it('fails cleanly on refusal and when the role’s token budget runs out', async () => {
    const refused = setup(scripted([reply([], 'refusal')]));
    expect(await refused.runtime.run(request('migrate-pages-about'))).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('declined'),
    });

    // The Rendering Registrar's budget is 400,000 tokens; each turn here uses 250,000.
    const loop = Array.from({ length: 5 }, () =>
      reply(
        [
          use('sitecore-authoring__item_read', {
            path: '/sitecore/layout/Renderings/Project/Acme/Hero',
          }),
        ],
        'tool_use',
        { input_tokens: 250_000, output_tokens: 0 },
      ),
    );
    const busy = setup(scripted(loop));
    expect(await busy.runtime.run(request('register-hero'))).toMatchObject({
      kind: 'failed',
      reason: 'Token budget of 400,000 exhausted.',
    });

    // Re-reading cached context counts at a tenth: six turns of 250,000 cached tokens and a
    // little new work stay inside the same budget, and the spend still reports every token.
    const cached = Array.from({ length: 6 }, () =>
      reply(
        [
          use('sitecore-authoring__item_read', {
            path: '/sitecore/layout/Renderings/Project/Acme/Hero',
          }),
        ],
        'tool_use',
        { input_tokens: 2_000, output_tokens: 1_000, cache_read_input_tokens: 250_000 },
      ),
    );
    cached.push(reply([use('submit_result', { status: 'done', summary: 'ok' })], 'tool_use'));
    const long = setup(scripted(cached));
    const done = await long.runtime.run(request('register-hero'));
    expect(done).toMatchObject({ kind: 'done' });
    expect(done.spent.tokens).toBeGreaterThan(1_500_000);
  });

  it('routes each role to its model, without fallbacks where the model has none', async () => {
    const model = scripted([
      reply([use('submit_result', { status: 'done', summary: 'ok' })], 'tool_use'),
    ]);
    const { runtime } = setup(model);
    await runtime.run(request('upload-media-logo'));
    expect(model.requests[0]).toMatchObject({
      model: 'claude-haiku-5-5',
      output_config: { effort: 'low' },
    });
    expect(model.requests[0]!.fallbacks).toBeUndefined();
    expect(model.requests[0]!.betas).toBeUndefined();
  });
});
