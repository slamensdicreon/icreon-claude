import { fileURLToPath } from 'node:url';
import { CypherConversation, CypherConversations, type ProjectIntakeInput } from '@lw/contracts';
import type { ModelClient } from '@lw/agent-runtime';
import {
  InMemoryEventStore,
  MemoryIntegrationStore,
  MemoryKnowledgeStore,
  MemoryRuleStore,
  MemoryVault,
  Projections,
} from '@lw/events';
import { loadCatalog } from '@lw/playbook-sdk';
import { createPlatforms } from '@lw/platforms';
import { OPTIMIZELY_DEFAULTS, SITECORE_DEFAULTS } from '@lw/connectors';
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

const CMS_SECRET = 'cms-secret-value-QRST';

/** A fake Optimizely: one REST API key on the gateway, and a Graph single key that works. */
const fakeOptimizely = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const authorization = new Headers(init?.headers).get('authorization') ?? '';
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (url === 'https://api.cms.optimizely.com/oauth/token')
    return body.client_id === 'cms-id' && body.client_secret === CMS_SECRET
      ? json(200, { access_token: 'jwt', expires_in: 300 })
      : json(401, { error: 'invalid_client' });
  if (url.startsWith('https://api.cms.optimizely.com/v1/contenttypes'))
    return authorization === 'Bearer jwt'
      ? json(200, { items: [], totalItemCount: 0 })
      : json(401, {});
  if (url === 'https://cg.optimizely.com/content/v2')
    return authorization === 'epi-single graph-key-1234'
      ? json(200, { data: { _Content: { total: 3 } } })
      : json(401, {});
  return json(404, {});
}) as typeof fetch;

const firstOptimizely: ProjectIntakeInput = {
  playbookId: 'optimizely-saas-migration',
  name: 'Globex website',
  client: 'Globex',
  budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
  source: { repo: null, branch: 'main', url: 'https://www.globex.example' },
  target: {
    cmsUrl: 'https://app-globex123.cms.optimizely.com',
    application: 'Globex Website',
    typePrefix: 'Globex',
    languages: ['en'],
    hostingProject: 'globex-website',
  },
  brief: { experimentation: 'no', accessibility: 'WCAG 2.2 AA' },
  credentials: {
    'cms-api-client': { clientId: 'cms-id', clientSecret: CMS_SECRET },
    'graph-single-key': { singleKey: 'graph-key-1234' },
  },
};

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(
  model: ModelClient | null = null,
  stores: { rules?: MemoryRuleStore; knowledge?: MemoryKnowledgeStore } = {},
) {
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
      platforms: createPlatforms({
        sitecore: { ...SITECORE_DEFAULTS, fetch: fakeSitecore },
        optimizely: { ...OPTIMIZELY_DEFAULTS, fetch: fakeOptimizely },
      }),
      vault: new MemoryVault(),
      connections,
    }),
    cypher: { model, store: connections },
    ...stores,
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
  expect(CypherConversations.parse((await call('GET', '/cypher')).body)).toEqual({
    available: false,
    conversations: [],
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
    // The small call that names the conversation after its first exchange.
    {
      text: '```json\n{"title": "Globex careers remix", "summary": "Drafted Globex careers from the Globex site on its saved connection, for the Director to create."}\n```',
    },
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
  expect(convo.title).toBe('Globex careers remix');
  expect(convo.summary).toMatch(/^Drafted Globex careers/);
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
  // The brief keeps the original's answers, takes the changed one, and drops unknown keys and
  // the source-code question (no repository).
  expect(reply.proposals[0]!.draft.brief).toEqual({
    personalization: 'yes',
    accessibility: 'WCAG 2.2 AA',
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
  // The title came from a separate, smaller call that saw the transcript and no tools.
  const naming = requests.at(-1);
  expect(naming.model).toBe('claude-haiku-5-5');
  expect(naming.tools).toBeUndefined();
  expect(naming.messages[0].content).toMatch(/^Director: Set up careers/);
  expect(requests[0].tools.map((t: { name: string }) => t.name)).toEqual([
    'list_projects',
    'project_detail',
    'list_playbooks',
    'list_connections',
    'propose_project',
    'propose_remix',
    'project_history',
    'list_cards',
    'answer_cards',
  ]);

  // Drafts only: still just the one project.
  expect(await store.projectIds()).toEqual([projectId]);

  // The conversation is saved and listed; the next turn in it carries the draft along.
  const listed = CypherConversations.parse((await call('GET', '/cypher')).body);
  expect(listed.available).toBe(true);
  expect(listed.conversations).toMatchObject([
    { id: convo.id, title: 'Globex careers remix', messageCount: 2 },
  ]);
  const again = await call('POST', '/cypher', { body: 'Thanks', conversationId: convo.id });
  expect(again.status).toBe(200);
  expect(CypherConversation.parse(again.body).messages).toHaveLength(4);
  const carried = requests.at(-1).messages.map((m: { content: unknown }) => m.content);
  expect(carried[1]).toMatch(/Proposed a remix of Globex site: "Globex careers"/);
  expect(CypherConversation.parse((await call('GET', `/cypher/${convo.id}`)).body).title).toBe(
    'Globex careers remix',
  );

  // A message without a conversation starts a new one, listed first; a deleted one is gone.
  const fresh = CypherConversation.parse(
    (await call('POST', '/cypher', { body: 'What needs me today?' })).body,
  );
  expect(fresh.id).not.toBe(convo.id);
  expect(fresh.title).toBe('What needs me today?');
  expect(
    CypherConversations.parse((await call('GET', '/cypher')).body).conversations.map((c) => c.id),
  ).toEqual([fresh.id, convo.id]);
  expect((await call('DELETE', `/cypher/${convo.id}`)).status).toBe(200);
  expect((await call('GET', `/cypher/${convo.id}`)).status).toBe(404);
  expect(
    (await call('POST', '/cypher', { body: 'Still there?', conversationId: convo.id })).status,
  ).toBe(404);
  expect(
    CypherConversations.parse((await call('GET', '/cypher')).body).conversations.map((c) => c.id),
  ).toEqual([fresh.id]);
});

it('keeps the one conversation from before conversations were saved apart', async () => {
  const { connections } = await start();
  const at = '2026-10-01T10:00:00.000Z';
  await connections.put('cypher:portfolio', {
    messages: [
      { id: 'm1', role: 'director', body: 'What needs me?', at, proposals: [], projects: [] },
      { id: 'm2', role: 'cypher', body: 'Two cards on Ansco.', at, proposals: [], projects: [] },
    ],
  });
  const listed = CypherConversations.parse((await call('GET', '/cypher')).body);
  expect(listed.conversations).toMatchObject([
    { title: 'Earlier conversation', summary: null, messageCount: 2, updatedAt: at },
  ]);
  expect(await connections.get('cypher:portfolio')).toBeNull();
  const c = CypherConversation.parse(
    (await call('GET', `/cypher/${listed.conversations[0]!.id}`)).body,
  );
  expect(c.messages.map((m) => m.body)).toEqual(['What needs me?', 'Two cards on Ansco.']);
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
    // The naming call answers nonsense: the first message stands in as the title.
    { text: 'Sure! Here you go.' },
  ]);
  const { store } = await start(model);
  const r = await call('POST', '/cypher', {
    body: 'Initech wants www.initech.example on SitecoreAI, and a rebrand.',
  });
  expect(CypherConversation.parse(r.body).title).toBe(
    'Initech wants www.initech.example on SitecoreAI, and a…',
  );
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

it("reads a project's history and proposes a rule and a lesson, applying neither", async () => {
  let projectId = '';
  const rules = new MemoryRuleStore();
  const knowledge = new MemoryKnowledgeStore();
  await knowledge.create({
    kind: 'lesson',
    status: 'active',
    scope: { kind: 'platform', id: 'sitecoreai' },
    title: 'Media downloads refused by the source CDN',
    text: 'Fetch through the browser tool with the page as referer.',
    author: 'director',
  });
  const { model, requests, results } = scripted([
    { tool: 'project_history', input: () => ({ projectId, search: 'intake' }) },
    { tool: 'search_knowledge', input: { search: 'media' } },
    {
      tool: 'propose_rule',
      input: {
        when: 'the source site refuses a media download',
        then: 'skip the file and log it as a gap',
        category: 'media',
        scope: 'playbook',
        scopeId: 'sitecoreai-migration',
      },
    },
    {
      tool: 'propose_lesson',
      input: {
        title: 'Hero images missing alt text',
        text: 'Take alt text from the source page, never from the file name.',
        scope: 'platform',
        scopeId: 'sitecoreai',
        roles: ['media-migrator'],
      },
    },
    { tool: 'propose_lesson', input: { title: 'No scope id', text: 'x x x', scope: 'project' } },
    { text: 'Proposed R-1 and K-2; approve them under Rules and Knowledge.' },
    { text: '{"title": "Media lessons", "summary": "Proposed a rule and a lesson."}' },
  ]);
  await start(model, { rules, knowledge });
  projectId = (await call('POST', '/projects', first)).body.projectId;
  const r = await call('POST', '/cypher', { body: 'What did Globex teach us about media?' });
  expect(r.status).toBe(200);
  const reply = CypherConversation.parse(r.body).messages[1]!;
  // The history tool and the knowledge tools are offered when their stores are there.
  const offered = requests[0].tools.map((t: { name: string }) => t.name);
  expect(offered).toEqual(
    expect.arrayContaining([
      'project_history',
      'search_knowledge',
      'propose_rule',
      'propose_lesson',
    ]),
  );
  const history = JSON.parse(results[0]!);
  expect(history).toMatchObject({ name: 'Globex site', search: 'intake' });
  expect(history.activity.length + history.decisions.length).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(results[1]!).knowledge[0]).toMatchObject({
    title: 'Media downloads refused by the source CDN',
  });
  expect(results[4]).toMatch(/^ERROR A project lesson needs the project's id/);
  expect(reply.filed).toEqual([
    { kind: 'rule', ref: 'R-1', title: 'When the source site refuses a media download' },
    { kind: 'lesson', ref: 'K-2', title: 'Hero images missing alt text' },
  ]);
  expect(reply.projects).toEqual([{ id: projectId, name: 'Globex site' }]);
  // Proposed only: nothing applies until the Director approves.
  expect((await rules.list())[0]).toMatchObject({ status: 'proposed', author: 'cypher' });
  expect((await knowledge.list({ status: 'proposed' }))[0]).toMatchObject({
    author: 'cypher',
    roles: ['media-migrator'],
    scope: { kind: 'platform', id: 'sitecoreai' },
  });
});

it('opens a project drafted with Cypher with his reasoning and the brief', async () => {
  await start();
  const r = await call('POST', '/projects', {
    ...first,
    origin: {
      conversationId: 'c1',
      reason: 'The SitecoreAI migration playbook fits: a live site moving to SitecoreAI.',
      notCovered: ['A careers portal'],
    },
  });
  expect(r.status).toBe(201);
  const convo = (await call('GET', `/projects/${r.body.projectId}/conversation`)).body;
  const handoff = convo.items.find(
    (m: { title: string }) => m.title === 'From our conversation on the Dashboard',
  );
  expect(handoff).toMatchObject({
    body: 'The SitecoreAI migration playbook fits: a live site moving to SitecoreAI.',
    bullets: ['Not covered by the playbook: A careers portal'],
  });
  expect(handoff.rows).toEqual(
    expect.arrayContaining([expect.objectContaining({ value: 'WCAG 2.2 AA' })]),
  );
});

it('drafts a site remixed as a homepage demo: the demo playbook on the same connection', async () => {
  let projectId = '';
  const { model } = scripted([
    {
      tool: 'propose_remix',
      input: () => ({
        fromProjectId: projectId,
        playbookId: 'sitecoreai-homepage-demo',
        name: 'Initech homepage demo',
        client: 'Initech',
        sourceUrl: 'https://www.initech.example',
        reason: 'A homepage demo for Initech on the Globex tenant.',
      }),
    },
    { text: 'Drafted the Initech homepage demo on the Globex tenant.' },
    { text: '```json\n{"title": "Initech demo", "summary": "Drafted a homepage demo."}\n```' },
  ]);
  const { store } = await start(model);
  projectId = (await call('POST', '/projects', first)).body.projectId;
  await call('POST', '/connections', { name: 'Globex tenant', fromProject: projectId });

  const r = await call('POST', '/cypher', {
    body: 'Remix the Globex site as a homepage demo for initech.example.',
  });
  expect(r.status).toBe(200);
  const proposal = CypherConversation.parse(r.body).messages[1]!.proposals[0]!;
  expect(proposal).toMatchObject({
    kind: 'remix',
    draft: {
      playbookId: 'sitecoreai-homepage-demo',
      from: { projectId, name: 'Globex site' },
      name: 'Initech homepage demo',
      client: 'Initech',
      sourceUrl: 'https://www.initech.example',
      budgets: { usd: 300, tokens: 20_000_000, hours: 10 },
      target: { cmHost: 'xmc-globex.sitecorecloud.io', siteCollection: 'globex' },
    },
  });
  // Only the demo's own questions: nothing about personalization or accessibility.
  expect(proposal.draft.brief).toEqual({});
  expect(proposal.draft.connectionId).toMatch(/^con-/);
  expect(await store.projectIds()).toEqual([projectId]);
});

it('lists the playbooks of both platforms, and drafts an Optimizely site remixed as its homepage demo', async () => {
  let projectId = '';
  const { model, results } = scripted([
    { tool: 'list_playbooks', input: {} },
    { tool: 'list_connections', input: {} },
    // The SitecoreAI demo can't take an Optimizely project's connection.
    {
      tool: 'propose_remix',
      input: () => ({
        fromProjectId: projectId,
        playbookId: 'sitecoreai-homepage-demo',
        name: 'Initech homepage demo',
        reason: 'A homepage demo for Initech.',
      }),
    },
    {
      tool: 'propose_remix',
      input: () => ({
        fromProjectId: projectId,
        playbookId: 'optimizely-homepage-demo',
        name: 'Initech homepage demo',
        client: 'Initech',
        sourceUrl: 'https://www.initech.example',
        brief: { experimentation: 'yes' },
        reason: 'A homepage demo for Initech on the Globex instance.',
      }),
    },
    { text: 'Drafted the Initech homepage demo on the Globex instance.' },
    { text: '```json\n{"title": "Initech demo", "summary": "Drafted a homepage demo."}\n```' },
  ]);
  const { store } = await start(model);
  projectId = (await call('POST', '/projects', firstOptimizely)).body.projectId;
  await call('POST', '/connections', { name: 'Globex instance', fromProject: projectId });

  const r = await call('POST', '/cypher', {
    body: 'Remix the Globex website as a homepage demo for initech.example.',
  });
  expect(r.status).toBe(200);

  // Every playbook is listed with the platform it runs on, so Cypher can pick one that fits.
  const playbooks = JSON.parse(results[0]!) as {
    id: string;
    name: string;
    platform: string;
    phases: string[];
    team: string[];
    brief: { key: string }[];
  }[];
  expect(playbooks.map((b) => [b.id, b.platform]).sort()).toEqual([
    ['optimizely-homepage-demo', 'Optimizely CMS (SaaS)'],
    ['optimizely-saas-migration', 'Optimizely CMS (SaaS)'],
    ['sitecoreai-customer-portal', 'SitecoreAI'],
    ['sitecoreai-homepage-demo', 'SitecoreAI'],
    ['sitecoreai-migration', 'SitecoreAI'],
  ]);
  const website = playbooks.find((b) => b.id === 'optimizely-saas-migration')!;
  expect(website.name).toBe('Build an Optimizely CMS (SaaS) website');
  // Ten phases, with the two that wait on the Director marked.
  expect(website.phases).toHaveLength(10);
  expect(
    website.phases.filter((ph) => ph.endsWith(' gate)')).map((ph) => ph.split(' (')[0]),
  ).toEqual(['2 Blueprint', '9 Handover and acceptance']);
  expect(website.team.some((line) => line.startsWith('Experience Builder: '))).toBe(true);
  expect(website.brief.map((q) => q.key)).toContain('experimentation');
  // The saved instance, with what it shares and no secret.
  expect(JSON.parse(results[1]!)).toMatchObject([
    {
      name: 'Globex instance',
      platform: 'optimizely',
      target: { cmsUrl: 'https://app-globex123.cms.optimizely.com', languages: ['en'] },
    },
  ]);
  expect(results.join('\n')).not.toContain(CMS_SECRET);
  expect(results.join('\n')).not.toContain('graph-key-1234');
  expect(results[2]).toMatch(/^ERROR .*another platform/);

  const reply = CypherConversation.parse(r.body).messages[1]!;
  expect(reply.proposals).toHaveLength(1);
  const proposal = reply.proposals[0]!;
  expect(proposal).toMatchObject({
    kind: 'remix',
    reason: 'A homepage demo for Initech on the Globex instance.',
    draft: {
      playbookId: 'optimizely-homepage-demo',
      from: { projectId, name: 'Globex website' },
      name: 'Initech homepage demo',
      client: 'Initech',
      sourceUrl: 'https://www.initech.example',
      // The demo's own budgets, not the website project's.
      budgets: { usd: 300, tokens: 20_000_000, hours: 10 },
    },
  });
  // The instance carries over; the demo's application, type prefix and hosting are left to fill.
  expect(proposal.draft.target).toEqual({
    cmsUrl: 'https://app-globex123.cms.optimizely.com',
    languages: ['en'],
  });
  // Only the demo's own questions: nothing about Experimentation or accessibility.
  expect(proposal.draft.brief).toEqual({});
  expect(proposal.draft.connectionId).toMatch(/^con-/);
  expect(proposal.draft.providedCredentials.sort()).toEqual(['cms-api-client', 'graph-single-key']);
  // Drafts only: still just the one project.
  expect(await store.projectIds()).toEqual([projectId]);
});
