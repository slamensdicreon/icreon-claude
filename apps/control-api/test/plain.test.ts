import { fileURLToPath } from 'node:url';
import type { ModelClient } from '@lw/agent-runtime';
import { PlainVersion } from '@lw/contracts';
import { InMemoryEventStore, MemoryIntegrationStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { phaseDefs, roster } from '@lw/playbook-sdk/pure';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { parseExplained } from '../src/plain';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const REPORT = `Hero, QuickActions and HazardRoute ported from the Vite app, registered, and available in Page builder on preview deploy 6. Hero video autoplay waits for the Next.js client boundary.`;

/** A Claude that answers every document the same way, and counts how often it was asked. */
function scripted(reply: string) {
  const asked: string[] = [];
  const model: ModelClient = {
    async create(params) {
      asked.push(String(params.model));
      return {
        content: [{ type: 'text', text: reply }],
        stop_reason: 'end_turn',
        model: String(params.model),
        usage: { input_tokens: 1, output_tokens: 1 },
      } as never;
    },
  };
  return { model, asked };
}

async function setup(model: ModelClient | null) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const playbook = await loadPlaybook(PLAYBOOK);
  await store.append('p1', [
    {
      type: 'project.created',
      actor: { kind: 'system', id: 'intake' },
      subject: { kind: 'project', id: 'p1' },
      severity: 'notable',
      data: {
        name: 'Acme',
        client: 'Acme Corp',
        playbook: { id: playbook.manifest.id, version: playbook.manifest.version },
        budgets: playbook.manifest.defaults.budgets,
        phases: phaseDefs(playbook),
        roster: roster(playbook),
        site: { sourceUrl: 'https://www.acme.example' },
      },
    },
    {
      type: 'artifact.versioned',
      actor: { kind: 'agent', id: 'engineering-lead' },
      subject: { kind: 'artifact', id: 'pilot' },
      severity: 'notable',
      data: {
        artifactId: 'pilot',
        kind: 'report',
        title: 'Pilot slice report',
        version: 1,
        ref: 'blob://p1/artifacts/pilot/v1.md',
        format: 'markdown',
        summary: 'The pilot slice works end to end.',
      },
    },
  ]);
  await projections.waitFor('p1', await store.head('p1'));
  const app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    artifactContent: async () => new TextEncoder().encode(REPORT),
    ...(model ? { cypher: { model, store: new MemoryIntegrationStore() } } : {}),
  });
  return { app, store, projections };
}

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('never happened');
};

describe('plain versions', () => {
  it('writes the plain version once, keeps it as an event, and serves it after', async () => {
    const { model, asked } = scripted(
      JSON.stringify({
        inShort: 'The first three sections of the home page work in the new site.',
        means: ['Editors can place them on a page and change their words.'],
        toDo: null,
        plain: '## What works\n\nThe first three sections can be placed in Page builder.',
        glossary: [{ term: 'Page builder', meaning: 'Where editors put pages together.' }],
      }),
    );
    const { app, store } = await setup(model);
    const url = '/projects/p1/artifacts/pilot/versions/1/plain';
    const first = PlainVersion.parse((await app.inject(url)).json());
    // Not yet written: the author's summary stands in while Cypher writes.
    expect(first).toMatchObject({
      status: 'writing',
      inShort: 'The pilot slice works end to end.',
    });
    await until(async () => (await store.head('p1')) >= 3);
    await until(async () => (await app.inject(url)).json().status === 'ready');
    const ready = PlainVersion.parse((await app.inject(url)).json());
    expect(ready).toMatchObject({
      status: 'ready',
      inShort: 'The first three sections of the home page work in the new site.',
      toDo: null,
      plain: expect.stringContaining('Page builder'),
      glossary: [{ term: 'Page builder', meaning: 'Where editors put pages together.' }],
    });
    // Documents for the Director use the main model, and only once.
    await app.inject(url);
    expect(asked).toEqual(['claude-opus-5-5']);
    await app.close();
  });

  it('says what it knows without a model, and writes nothing', async () => {
    const { app, store } = await setup(null);
    const r = PlainVersion.parse(
      (await app.inject('/projects/p1/artifacts/pilot/versions/latest/plain')).json(),
    );
    expect(r).toMatchObject({
      status: 'none',
      inShort: 'The pilot slice works end to end.',
      plain: null,
    });
    expect(await store.head('p1')).toBe(2);
    await app.close();
  });
});

describe('reading the model’s answer', () => {
  it('takes the JSON object out of surrounding words, and trims what is too long', () => {
    const r = parseExplained(
      'Here it is:\n{"inShort":"It works.","means":["a","b","c","d"],"toDo":"Nothing.","plain":"x","glossary":[{"term":"t","meaning":"m"},{"term":""}]}',
      true,
    );
    expect(r).toEqual({
      inShort: 'It works.',
      means: ['a', 'b', 'c'],
      toDo: null,
      plain: 'x',
      glossary: [{ term: 't', meaning: 'm' }],
    });
  });

  it('drops the plain body for team files, and refuses an answer without a summary', () => {
    expect(parseExplained('{"inShort":"Fine.","plain":"long"}', false)?.plain).toBeNull();
    expect(parseExplained('{"means":["x"]}', true)).toBeNull();
    expect(parseExplained('not json at all', true)).toBeNull();
  });
});
