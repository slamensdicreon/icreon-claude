import { fileURLToPath } from 'node:url';
import { CypherConversation, type ProjectIntakeInput } from '@lw/contracts';
import type { ModelClient } from '@lw/agent-runtime';
import { InMemoryEventStore, MemoryIntegrationStore, MemoryVault, Projections } from '@lw/events';
import { loadCatalog } from '@lw/playbook-sdk';
import { createPlatforms } from '@lw/platforms';
import { SITECORE_DEFAULTS } from '@lw/connectors';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { IntakeService } from '../src/intake';

const PLAYBOOKS = fileURLToPath(new URL('../../../playbooks', import.meta.url));
const SECRET = 'env-secret-value-WXYZ';

/** A fake Sitecore: one environment client, one CM host, and two Context IDs that work. */
const fakeSitecore = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (url.endsWith('/oauth/token'))
    return body.client_id === 'env-id' && body.client_secret === SECRET
      ? json(200, { access_token: 'jwt', expires_in: 900 })
      : json(401, { error: 'access_denied' });
  if (url.startsWith('https://xmc-globex.sitecorecloud.io/sitecore/api/authoring/graphql/v1/'))
    return json(200, { data: { sites: [{ name: 'globex' }] } });
  if (/sitecoreContextId=ctx-preview-(1234|5678)/.test(url))
    return json(200, { data: { site: { siteInfoCollection: [] } } });
  return json(404, {});
}) as typeof fetch;

const first: ProjectIntakeInput = {
  playbookId: 'sitecoreai-migration',
  name: 'Globex site',
  client: 'Globex',
  budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
  source: { repo: null, branch: 'main', url: 'https://www.globex.example' },
  target: {
    cmHost: 'https://xmc-globex.sitecorecloud.io',
    siteCollection: 'globex',
    site: 'globex',
    languages: ['en'],
    hostingProject: 'globex-website',
  },
  brief: { personalization: 'no', accessibility: 'WCAG 2.2 AA', codeExtraction: 'Yes' },
  credentials: {
    'sitecore-environment': { clientId: 'env-id', clientSecret: SECRET },
    'edge-preview': { contextId: 'ctx-preview-1234' },
  },
};

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(model: ModelClient | null = null) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const connections = new MemoryIntegrationStore();
  const playbooks = await loadCatalog(PLAYBOOKS);
  // The live site is optional for this test: the playbook asks for a repository otherwise.
  for (const e of playbooks.values()) e.playbook.manifest.intake.source.repo = 'optional';
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    intake: new IntakeService({
      store,
      catalog: playbooks,
      platforms: createPlatforms({ sitecore: { ...SITECORE_DEFAULTS, fetch: fakeSitecore } }),
      vault: new MemoryVault(),
      connections,
    }),
    cypher: { model, store: connections },
  });
  return { store, projections, connections };
}

const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app!.inject({ method, url, payload: payload as object });
  return { status: r.statusCode, body: r.json() as any, text: r.body };
};

type Turn =
  | { text: string }
  | {
      tool: string;
      input: Record<string, unknown> | ((seen: string[]) => Record<string, unknown>);
    };

/** A scripted Claude: plays the turns in order and records what each request carried. */
function scripted(turns: Turn[]) {
  const requests: any[] = [];
  const results: string[] = [];
  let i = 0;
  const model: ModelClient = {
    async create(params) {
      requests.push(params);
      const last = params.messages.at(-1)!;
      if (Array.isArray(last.content))
        for (const b of last.content as any[])
          if (b.type === 'tool_result') results.push(`${b.is_error ? 'ERROR ' : ''}${b.content}`);
      const turn = turns[i++] ?? { text: 'Done.' };
      const content =
        'text' in turn
          ? [{ type: 'text', text: turn.text }]
          : [
              {
                type: 'tool_use',
                id: `tu-${i}`,
                name: turn.tool,
                input: typeof turn.input === 'function' ? turn.input(results) : turn.input,
              },
            ];
      return {
        content,
        stop_reason: 'text' in turn ? 'end_turn' : 'tool_use',
        model: 'scripted',
        usage: { input_tokens: 1, output_tokens: 1 },
      } as any;
    },
  };
  return { model, requests, results };
}

it('says Cypher is unavailable without a model, and refuses a message', async () => {
  await start();
  expect(CypherConversation.parse((await call('GET', '/cypher')).body)).toEqual({
    available: false,
    messages: [],
  });
  const r = await call('POST', '/cypher', { body: 'hello' });
  expect(r.status).toBe(503);
  expect(r.body.error.message).toMatch(/model/);
});

it('drafts a remix on the saved connection from a conversation, and creates nothing', async () => {
  let projectId = '';
  const { model, requests, results } = scripted([
    { tool: 'list_projects', input: {} },
    { tool: 'list_connections', input: {} },
    {
      tool: 'propose_remix',
      input: () => ({
        fromProjectId: projectId,
        name: 'Globex careers',
        sourceUrl: 'https://careers.globex.example',
        brief: { personalization: 'yes', unknownQuestion: 'x' },
        reason: 'Same tenant and team as Globex site.',
      }),
    },
    { text: 'Drafted Globex careers like Globex site. Open it to review and create.' },
  ]);
  const { store } = await start(model);
  projectId = (await call('POST', '/projects', first)).body.projectId;
  await call('POST', '/connections', { name: 'Globex tenant', fromProject: projectId });

  const r = await call('POST', '/cypher', {
    body: 'Set up careers.globex.example like the Globex site.',
  });
  expect(r.status).toBe(200);
  const convo = CypherConversation.parse(r.body);
  expect(convo.messages.map((m) => m.role)).toEqual(['director', 'cypher']);
  const reply = convo.messages[1]!;
  expect(reply.body).toMatch(/^Drafted Globex careers/);
  expect(reply.projects).toEqual([{ id: projectId, name: 'Globex site' }]);
  expect(reply.proposals).toHaveLength(1);
  expect(reply.proposals[0]).toMatchObject({
    kind: 'remix',
    reason: 'Same tenant and team as Globex site.',
    draft: {
      playbookId: 'sitecoreai-migration',
      from: { projectId, name: 'Globex site' },
      name: 'Globex careers',
      client: 'Globex',
      sourceUrl: 'https://careers.globex.example',
      repo: null,
      branch: 'main',
      budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
      target: { cmHost: 'xmc-globex.sitecorecloud.io', siteCollection: 'globex' },
    },
  });
  // The brief keeps the original's answers, takes the changed one, and drops unknown keys.
  expect(reply.proposals[0]!.draft.brief).toEqual({
    personalization: 'yes',
    accessibility: 'WCAG 2.2 AA',
    codeExtraction: 'Yes',
  });
  expect(reply.proposals[0]!.draft.connectionId).toMatch(/^con-/);
  expect(reply.proposals[0]!.draft.providedCredentials.sort()).toEqual([
    'edge-preview',
    'sitecore-environment',
  ]);

  // The model read the portfolio and connections; no secret reached it.
  expect(results[0]).toContain('"name":"Globex site"');
  expect(results[1]).toContain('"name":"Globex tenant"');
  expect(results.join('\n')).not.toContain(SECRET);
  expect(requests[0].system).toMatch(/You are Cypher/);
  expect(requests[0].tools.map((t: { name: string }) => t.name)).toEqual([
    'list_projects',
    'project_detail',
    'list_playbooks',
    'list_connections',
    'propose_project',
    'propose_remix',
  ]);

  // Drafts only: still just the one project.
  expect(await store.projectIds()).toEqual([projectId]);

  // The conversation is kept, and the next turn carries it, the draft included.
  expect(CypherConversation.parse((await call('GET', '/cypher')).body).messages).toHaveLength(2);
  await call('POST', '/cypher', { body: 'Thanks' });
  const carried = requests.at(-1).messages.map((m: { content: unknown }) => m.content);
  expect(carried[1]).toMatch(/Proposed a remix of Globex site: "Globex careers"/);

  expect((await call('DELETE', '/cypher')).status).toBe(200);
  expect(CypherConversation.parse((await call('GET', '/cypher')).body).messages).toEqual([]);
});

it('drafts a new project from a brief, telling the model what it got wrong', async () => {
  const { model, results } = scripted([
    { tool: 'list_playbooks', input: {} },
    {
      tool: 'propose_project',
      input: { playbookId: 'nope', name: 'Initech site', client: 'Initech', reason: 'x' },
    },
    {
      tool: 'propose_project',
      input: {
        playbookId: 'sitecoreai-migration',
        name: 'Initech site',
        client: 'Initech',
        sourceUrl: 'https://www.initech.example',
        brief: { accessibility: 'WCAG 2.2 AA' },
        reason: 'A migration to SitecoreAI from the live site.',
        notCovered: ['Rebranding'],
      },
    },
    { text: 'Drafted.' },
  ]);
  const { store } = await start(model);
  const r = await call('POST', '/cypher', {
    body: 'Initech wants www.initech.example on SitecoreAI, and a rebrand.',
  });
  expect(results[0]).toContain('"id":"sitecoreai-migration"');
  expect(results[1]).toMatch(/^ERROR No playbook "nope"/);
  const [p] = CypherConversation.parse(r.body).messages[1]!.proposals;
  expect(p).toMatchObject({
    kind: 'new',
    notCovered: ['Rebranding'],
    draft: {
      from: null,
      connectionId: null,
      name: 'Initech site',
      client: 'Initech',
      sourceUrl: 'https://www.initech.example',
      repo: null,
      brief: { accessibility: 'WCAG 2.2 AA' },
      providedCredentials: [],
    },
  });
  expect(await store.projectIds()).toEqual([]);
});
