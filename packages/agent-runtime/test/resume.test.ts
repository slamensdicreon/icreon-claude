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
  MemoryBlobStore,
  MemoryIdempotencyStore,
  TokenBucketLimiter,
  ToolGateway,
  type ToolServer,
} from '@lw/tool-gateway';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  BlobCheckpoints,
  SessionStopped,
  type CheckpointRef,
  type ModelClient,
  type RunRequest,
  type SessionCheckpoint,
} from '../src';

const DIR = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const SITE = '/sitecore/content/Acme/Corporate';

let pb: Playbook;
let task: PlannedTask;
beforeAll(async () => {
  pb = await loadPlaybook(DIR);
  task = compilePlan(pb, {
    version: 1,
    collections: {
      components: [{ key: 'hero', name: 'Hero', status: 'keep', pilot: true, attrs: {} }],
      templates: [{ key: 'home', name: 'Home Page', status: 'keep', pilot: false, attrs: {} }],
      pages: [{ key: 'about', name: 'About', status: 'keep', pilot: false, attrs: {} }],
      media: [],
    },
  }).tasks.find((t) => t.taskId === 'migrate-pages-about')!;
});

type Block =
  { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
let ids = 0;
const use = (name: string, input: unknown): Block => ({
  type: 'tool_use',
  id: `tu_${++ids}`,
  name,
  input,
});
const reply = (content: Block[], stop: string): BetaMessage =>
  ({
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
    },
  }) as unknown as BetaMessage;

const create = (path: string) =>
  reply([use('sitecore-authoring__item_create', { path: `${SITE}/Home/${path}` })], 'tool_use');
const update = (path: string) =>
  reply([use('sitecore-authoring__item_update', { path: `${SITE}/Home/${path}` })], 'tool_use');
const submit = () =>
  reply([use('submit_result', { status: 'done', summary: 'Migrated About.' })], 'tool_use');

/** Replays scripted turns, keeps every request, and can run a hook before answering. */
function scripted(turns: BetaMessage[], before?: (n: number) => void) {
  const requests: MessageCreateParamsNonStreaming[] = [];
  const model: ModelClient = {
    async create(params) {
      requests.push(structuredClone(params));
      before?.(requests.length);
      const next = turns.shift();
      if (!next) throw new Error('script ran out of turns');
      return next;
    },
  };
  return { model, requests };
}

/** One worker's runtime: its own gateway (and idempotency memory), the shared log and server. */
function worker(model: ModelClient, server: ToolServer, store: InMemoryEventStore) {
  const reads = { context: 0, board: 0, lessons: 0 };
  const gateway = new ToolGateway({
    playbook: pb,
    servers: [server],
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
    context: {
      forTask: async () => {
        reads.context++;
        return 'Grid: Tailwind.';
      },
    },
    board: async () => {
      reads.board++;
      return null;
    },
    lessons: async () => {
      reads.lessons++;
      return null;
    },
  });
  return { runtime, reads };
}

/** Sitecore authoring that counts what it was asked to do. */
function authoring(onCall?: (op: string) => Promise<void> | void) {
  const calls: string[] = [];
  const server: ToolServer = {
    name: 'sitecore-authoring',
    catalog: {
      'item.read': { mutates: false, pathArgs: ['path'] },
      'item.create': { mutates: true, pathArgs: ['path'] },
      'item.update': { mutates: true, pathArgs: ['path'] },
    },
    target: () => 'acme',
    call: async (op, args) => {
      calls.push(`${op} ${String(args.path).split('/').pop()}`);
      await onCall?.(op);
      return { code: 200, body: { ok: op } };
    },
  };
  return { server, calls };
}

const request = (): RunRequest => ({
  projectId: 'p1',
  task,
  attempt: 1,
  feedback: null,
  instructions: null,
});

const modelSteps = async (store: InMemoryEventStore) =>
  (await store.read('p1'))
    .filter(
      (e): e is Extract<LwEvent, { type: 'step.recorded' }> =>
        e.type === 'step.recorded' && ['model', 'session'].includes(e.data.toolServer),
    )
    .map((e) => e.data.summary.split(':')[0]);

describe('checkpoints', () => {
  it('saves the session after every completed turn, with its counters', async () => {
    const { model } = scripted([
      create('About'),
      reply([], 'max_tokens'),
      update('About'),
      submit(),
    ]);
    const saved: SessionCheckpoint[] = [];
    const { runtime } = worker(model, authoring().server, new InMemoryEventStore());
    const out = await runtime.run(request(), {
      checkpoint: async (cp) => void saved.push(structuredClone(cp)),
    });

    expect(out.kind).toBe('done');
    // The turn that submitted ends the session: nothing to resume, so no checkpoint.
    expect(saved.map((c) => [c.turn, c.messages.length, c.stepIndex, c.maxTokens])).toEqual([
      [1, 3, 1, 16_000],
      // Hit the output limit: same conversation, more room next time.
      [2, 3, 1, 32_000],
      [3, 5, 2, 32_000],
    ]);
    expect(saved.map((c) => c.spent.tokens)).toEqual([1200, 2400, 3600]);
    // Each ends with the turn's tool results: every call it made has run.
    expect(saved[2]!.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', content: expect.stringContaining('item.update') }],
    });
    expect(saved[0]!.system).toEqual(saved[2]!.system);
  });

  it('keeps going when a checkpoint cannot be saved', async () => {
    const { model } = scripted([create('About'), submit()]);
    const { runtime } = worker(model, authoring().server, new InMemoryEventStore());
    const out = await runtime.run(request(), {
      checkpoint: async () => {
        throw new Error('blob store unreachable');
      },
    });
    expect(out.kind).toBe('done');
  });
});

describe('resuming a session on another worker', () => {
  it('stops after the turn in progress when drained, and carries on from it without repeating a tool call', async () => {
    const store = new InMemoryEventStore();
    const blobs = new BlobCheckpoints(new MemoryBlobStore());
    const key = { projectId: 'p1', taskId: task.taskId, attempt: 1 };
    const drain = new AbortController();
    // The deploy lands while the first turn's tool call runs.
    const { server, calls } = authoring((op) => {
      if (op === 'item.create') drain.abort();
    });

    // First worker: one turn, then the worker goes away.
    const first = scripted([create('About'), update('About'), submit()]);
    let ref: CheckpointRef | null = null;
    const a = worker(first.model, server, store);
    const stopped = await a.runtime
      .run(request(), {
        drain: drain.signal,
        checkpoint: async (cp) => void (ref = await blobs.save(key, ref, cp)),
      })
      .catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(SessionStopped);
    expect((stopped as SessionStopped).turn).toBe(1);
    expect(first.requests).toHaveLength(1);
    expect(ref!.turn).toBe(1);

    // Second worker: picks the session up from its checkpoint.
    const second = scripted([update('About'), submit()]);
    const b = worker(second.model, server, store);
    const resume = await blobs.load(ref!);
    const out = await b.runtime.run(request(), {
      resume,
      checkpoint: async (cp) => void (ref = await blobs.save(key, ref, cp)),
    });

    expect(out).toMatchObject({ kind: 'done', summary: 'Migrated About.' });
    // The whole session's spend: three turns of 1,200 tokens, across both workers.
    expect(out.spent.tokens).toBe(3600);
    // The page was created once; the second worker went on to the update.
    expect(calls).toEqual(['item.create About', 'item.update About']);
    // It continued the same conversation, under the same system prompt...
    const before = first.requests[0]!;
    const after = second.requests[0]!;
    expect(after.system).toEqual(before.system);
    expect(after.messages.slice(0, 1)).toEqual(before.messages);
    expect(after.messages).toHaveLength(3);
    expect(after.messages.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', content: expect.stringContaining('item.create') }],
    });
    // ...without building a new brief (which would record its lessons again).
    expect(b.reads).toEqual({ context: 0, board: 0, lessons: 0 });
    expect(ref!.stepIndex).toBe(2);
    expect(await modelSteps(store)).toEqual(['Turn 1', 'Resumed after turn 1', 'Turn 2', 'Turn 3']);
  });

  it('abandons the turn in progress when it must stop now', async () => {
    const abort = new AbortController();
    const reason = new Error('WORKER_SHUTDOWN');
    // The grace period runs out while the second turn's tool call is still going.
    const { server, calls } = authoring(async (op) => {
      if (op !== 'item.update') return;
      abort.abort(reason);
      await new Promise(() => undefined);
    });
    const { model, requests } = scripted([create('About'), update('About'), submit()]);
    const saved: number[] = [];
    const { runtime } = worker(model, server, new InMemoryEventStore());
    await expect(
      runtime.run(request(), {
        abort: abort.signal,
        checkpoint: async (cp) => void saved.push(cp.turn),
      }),
    ).rejects.toBe(reason);
    // Turn 1 is saved; turn 2 is lost, and is what the next attempt redoes.
    expect(saved).toEqual([1]);
    expect(requests).toHaveLength(2);
    expect(calls).toEqual(['item.create About', 'item.update About']);
  });

  it('hands over before starting when its worker is already draining', async () => {
    const { model, requests } = scripted([submit()]);
    const { runtime, reads } = worker(model, authoring().server, new InMemoryEventStore());
    const drain = new AbortController();
    drain.abort();
    await expect(runtime.run(request(), { drain: drain.signal })).rejects.toBeInstanceOf(
      SessionStopped,
    );
    expect(requests).toHaveLength(0);
    expect(reads.lessons).toBe(0);
  });
});

describe('BlobCheckpoints', () => {
  const checkpoint = (turn: number, messages: number): SessionCheckpoint => ({
    turn,
    stepIndex: turn,
    maxTokens: 16_000,
    spent: { tokens: turn * 100, usd: turn / 100 },
    system: [{ type: 'text', text: 'You are the Content Migrator.' }],
    messages: Array.from({ length: messages }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `message ${i}`,
    })),
  });
  const key = { projectId: 'p1', taskId: 'migrate-pages-about', attempt: 2 };

  it('writes only what each turn added, and reads the whole session back', async () => {
    const blobs = new MemoryBlobStore();
    const store = new BlobCheckpoints(blobs);
    let ref = await store.save(key, null, checkpoint(1, 3));
    ref = await store.save(key, ref, checkpoint(2, 3));
    ref = await store.save(key, ref, checkpoint(3, 5));
    expect(ref.parts).toHaveLength(2);
    expect(ref.parts[0]).toMatch(/^blob:\/\/p1\/sessions\/migrate-pages-about\/2\/.+\.json$/);
    const second = JSON.parse(new TextDecoder().decode(await blobs.get(ref.parts[1]!)));
    expect(second).toEqual({ messages: checkpoint(3, 5).messages.slice(3) });

    expect(await store.load(ref)).toEqual(checkpoint(3, 5));

    await store.discard(ref);
    await expect(blobs.get(ref.parts[0]!)).rejects.toThrow('No blob');
  });

  it('refuses a checkpoint whose parts are not all there', async () => {
    const store = new BlobCheckpoints(new MemoryBlobStore());
    const ref = await store.save(key, null, checkpoint(1, 3));
    await expect(store.load({ ...ref, messages: 5 })).rejects.toThrow('3 of 5 messages');
  });
});
