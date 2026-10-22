import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ModelClient } from '@lw/agent-runtime';
import type { LwEvent } from '@lw/contracts';
import { canTransition, plan } from '@lw/domain';
import { InMemoryEventStore, Projections } from '@lw/events';
import { createWorker, defaultPolicy, ProjectCommandsClient, startProject } from '@lw/orchestrator';
import { loadPlaybook } from '@lw/playbook-sdk';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { composeStack, liveRoles, type Stack } from '../src';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const SITE = fileURLToPath(
  new URL('../../../tool-servers/browser/test/fixture-site', import.meta.url),
);

let http: Server;
let origin: string;

beforeAll(async () => {
  http = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    for (const c of path === '/' ? ['index.html'] : [path.slice(1), `${path.slice(1)}.html`]) {
      try {
        let body: Buffer | string = await readFile(join(SITE, c));
        if (c === 'sitemap.xml') body = body.toString().replaceAll('__ORIGIN__', origin);
        res.writeHead(200, {
          'content-type':
            extname(c) === '.xml'
              ? 'application/xml'
              : extname(c) === '.pdf'
                ? 'application/pdf'
                : 'text/html',
        });
        return res.end(body);
      } catch {
        /* next */
      }
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const a = http.address();
  origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

afterAll(async () => {
  await new Promise((r) => http.close(r));
});

let n = 0;
const msg = (content: unknown[], stop = 'tool_use'): BetaMessage =>
  ({
    id: `m${++n}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content,
    stop_reason: stop,
    usage: {
      input_tokens: 2_000,
      output_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  }) as unknown as BetaMessage;
const call = (name: string, input: unknown) => ({ type: 'tool_use', id: `tu${++n}`, name, input });
const submit = (summary: string) => call('submit_result', { status: 'done', summary });

/** The last tool result's JSON (the gateway's untrusted wrapper around the server body). */
function lastResult(params: MessageCreateParamsNonStreaming): any {
  const last = params.messages.at(-1)!;
  const block = (last.content as { type: string; content?: string }[]).find(
    (b) => b.type === 'tool_result',
  );
  return JSON.parse(block!.content!);
}

/**
 * Plays Claude for two roles, the way a well-behaved agent would: the Content Analyst crawls the
 * source site and saves a page inventory; the Solution Architect reads it and writes a Blueprint
 * whose pages are the pages actually crawled.
 */
function scriptedClaude(sourceUrl: () => string): ModelClient & { roles: string[] } {
  const roles: string[] = [];
  return {
    roles,
    async create(params) {
      const role = (params.system as { text: string }[])[1]!.text;
      const turn = params.messages.length; // 1 = brief only; 3 = after one tool round; 5 = after two
      if (turn === 1) roles.push(role.split('\n')[0]!);
      if (role.includes('Content Analyst')) {
        if (turn === 1) return msg([call('browser__crawl', { url: `${sourceUrl()}/` })]);
        if (turn === 3) {
          const crawl = lastResult(params).content as { pages: { url: string; title: string }[] };
          const pages = crawl.pages.map((p) => ({ path: new URL(p.url).pathname, title: p.title }));
          const recrawl = (params.messages[0]!.content as string).includes('Re-crawl');
          return msg([
            call('artifacts__write', {
              artifactId: recrawl ? 'parity-inventory' : 'page-inventory',
              kind: 'inventory',
              title: recrawl ? 'Parity re-crawl' : 'Page inventory',
              format: 'json',
              content: JSON.stringify({ pages }),
            }),
          ]);
        }
        return msg([submit('Crawled the source site and saved the page inventory.')]);
      }
      if (role.includes('Solution Architect')) {
        if (turn === 1) return msg([call('artifacts__read', { artifactId: 'page-inventory' })]);
        if (turn === 3) {
          const inv = JSON.parse(lastResult(params).content.content) as {
            pages: { path: string; title: string }[];
          };
          const slug = (p: string) => (p === '/' ? 'home' : p.slice(1).replace(/[^a-z0-9]+/g, '-'));
          return msg([
            call('blackboard__write_blueprint', {
              blueprint: {
                version: 1,
                collections: {
                  components: [
                    { key: 'hero', name: 'Hero', pilot: true },
                    { key: 'rich-text', name: 'RichText', pilot: true },
                    { key: 'site-footer', name: 'Footer' },
                  ],
                  templates: [{ key: 'content', name: 'Content Page' }],
                  pages: inv.pages.map((p) => ({
                    key: slug(p.path),
                    name: p.title.replace(' | Acme', ''),
                  })),
                  media: [],
                },
              },
            }),
          ]);
        }
        return msg([submit('Blueprint v1 maps every crawled page to the Content Page template.')]);
      }
      return msg([submit('ok')]);
    },
  };
}

let env: TestWorkflowEnvironment;
let stack: Stack;

afterAll(async () => {
  await stack?.close();
  await env?.teardown();
});

it('runs a live Content Analyst and Solution Architect whose crawl becomes the plan', async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const playbook = await loadPlaybook(PLAYBOOK);
  const claude = scriptedClaude(() => origin);
  stack = await composeStack({
    store,
    projections,
    playbook,
    playbookDir: PLAYBOOK,
    dataDir: await mkdtemp(join(tmpdir(), 'lw-stack-')),
    model: claude,
    allowPrivateNetworks: true,
  });
  expect(stack.liveRoles.sort()).toEqual(['content-analyst', 'solution-architect']);
  // Connected servers are not enough: Editor Experience QA's Page builder operations don't exist yet.
  expect(liveRoles(playbook, [])).toEqual([]);

  const worker = await createWorker({
    connection: env.nativeConnection,
    taskQueue: 'live',
    activities: stack.activities,
  });
  await worker.runUntil(async () => {
    const handle = await startProject(
      env.client,
      {
        projectId: 'p1',
        name: 'Acme corporate site',
        client: 'Acme Corp',
        playbook,
        site: { sourceUrl: origin },
        policy: defaultPolicy(playbook, {
          undoWindowMs: 0,
          budgets: { tokens: 1e9, usd: 1e6, hours: 1e6 },
        }),
      },
      'live',
    );
    const commands = new ProjectCommandsClient(env.client, 'p1');
    // The Director approves both gates (typing the name for Gate 2) and takes recommendations.
    let done = false;
    const bot = (async () => {
      const handled = new Set<string>();
      while (!done) {
        for (const x of Object.values(projections.get('p1')?.escalations ?? {})) {
          if (x.status !== 'open' || handled.has(x.escalationId)) continue;
          handled.add(x.escalationId);
          const option = x.type === 'gate' ? 'approve' : x.options.find((o) => o.recommended)!.id;
          await commands
            .resolve(
              x.escalationId,
              option,
              null,
              x.gate?.requiresConfirmation ? 'Acme corporate site' : undefined,
            )
            .catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await handle.result();
    done = true;
    await bot;
  });

  const s = projections.get('p1')!;
  expect(s.status).toBe('completed');
  expect(s.sourceUrl).toBe(origin);

  // The crawl ran through the gateway and the real browser.
  const events = await store.read('p1');
  const steps = events.filter(
    (e): e is Extract<LwEvent, { type: 'step.recorded' }> => e.type === 'step.recorded',
  );
  expect(
    steps.find((e) => e.data.toolServer === 'browser' && e.data.operation === 'crawl'),
  ).toMatchObject({
    data: {
      agentId: 'content-analyst',
      resultCode: 200,
      summary: expect.stringMatching(/^Crawled 7 pages/),
    },
  });
  expect(steps.filter((e) => e.data.toolServer === 'model').length).toBeGreaterThanOrEqual(6);

  // The agents' documents are versioned artifacts with stored content.
  expect(s.artifacts['page-inventory']).toMatchObject({
    latest: 1,
    versions: [{ producer: 'content-analyst', format: 'json' }],
  });
  expect(s.artifacts['parity-inventory']).toMatchObject({
    latest: 1,
    versions: [{ producer: 'content-analyst' }],
  });
  expect(s.artifacts['blueprint']!.versions.find((v) => v.ref)).toMatchObject({
    producer: 'solution-architect',
  });

  // Gate 1 expanded the plan from the agent-written Blueprint: one migration task per crawled page.
  const pages = plan(s)
    .tasks.filter((t) => t.group === 'migrate-pages-{key}')
    .map((t) => t.taskId)
    .sort();
  expect(pages).toEqual(
    ['about', 'blog-post-1', 'contact', 'hidden', 'home', 'privacy', 'services'].map(
      (k) => `migrate-pages-${k}`,
    ),
  );
  expect(plan(s).tasks.every((t) => t.state === 'done')).toBe(true);

  // Only the live roles called the model.
  expect([...new Set(claude.roles)].sort()).toEqual([
    'Your role: Content Analyst.',
    'Your role: Solution Architect.',
  ]);

  const last = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'task.planned') last.set(e.data.taskId, 'planned');
    if (e.type === 'task.state') {
      expect(last.get(e.data.taskId)).toBe(e.data.from);
      expect(canTransition(e.data.from, e.data.to)).toBe(true);
      last.set(e.data.taskId, e.data.to);
    }
  }
}, 180_000);
