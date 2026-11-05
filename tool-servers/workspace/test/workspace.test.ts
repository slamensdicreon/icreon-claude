import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryEventStore } from '@lw/events';
import { LocalBlobStore } from '@lw/tool-gateway';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactLibrary,
  ArtifactsToolServer,
  BlackboardToolServer,
  DecisionLogToolServer,
} from '../src';

const ctx = (role = 'content-analyst') => ({ projectId: 'p1', token: 't', role, taskId: 'task' });

let store: InMemoryEventStore;
let library: ArtifactLibrary;

beforeEach(async () => {
  store = new InMemoryEventStore();
  library = new ArtifactLibrary(store, new LocalBlobStore(await mkdtemp(join(tmpdir(), 'lw-ws-'))));
});

describe('artifacts', () => {
  it('carries the agent’s summary and pointers onto the save, from the arguments or a JSON document', async () => {
    const s = new ArtifactsToolServer(library);
    const pointer = { label: 'The pilot pages', target: { kind: 'preview', ref: '' } };
    await s.call(
      'write',
      {
        artifactId: 'pilot',
        kind: 'report',
        title: 'Pilot slice report',
        format: 'markdown',
        content: '# Pilot',
        summary: 'The pilot works end to end.',
        attention: [pointer],
      },
      ctx('engineering-lead'),
    );
    await s.call(
      'write',
      {
        artifactId: 'inv',
        kind: 'inventory',
        title: 'Media inventory',
        format: 'json',
        content: JSON.stringify({
          doc: 'lw.document/1',
          summary: 'Seventeen files move across.',
          attention: [pointer],
          blocks: [],
        }),
      },
      ctx('repo-analyst'),
    );
    await s.call(
      'write',
      { artifactId: 'bare', kind: 'report', title: 'Bare', format: 'markdown', content: '# x' },
      ctx(),
    );
    const saved = (await store.read('p1')).flatMap((e) =>
      e.type === 'artifact.versioned' ? [e.data] : [],
    );
    expect(saved.map((d) => [d.artifactId, d.summary, d.attention])).toEqual([
      ['pilot', 'The pilot works end to end.', [pointer]],
      ['inv', 'Seventeen files move across.', [pointer]],
      ['bare', null, []],
    ]);
  });

  it('saves the document even when its summary or pointers are malformed, dropping them', async () => {
    const s = new ArtifactsToolServer(library);
    const r = await s.call(
      'write',
      {
        artifactId: 'odd',
        kind: 'report',
        title: 'Odd extras',
        format: 'markdown',
        content: '# Odd',
        summary: 'x'.repeat(1_500),
        attention: [{ label: 'Somewhere', target: { kind: 'nowhere', ref: 1 } }],
      },
      ctx(),
    );
    expect(r.code).toBe(200);
    const [saved] = (await store.read('p1')).flatMap((e) =>
      e.type === 'artifact.versioned' ? [e.data] : [],
    );
    expect(saved).toMatchObject({ artifactId: 'odd', attention: [] });
    expect(saved!.summary).toHaveLength(1_200);
  });

  it('versions each write, stores the content and announces it on the log', async () => {
    const s = new ArtifactsToolServer(library);
    const w = {
      artifactId: 'platform-notes',
      kind: 'platform_notes',
      title: 'Platform Notes',
      format: 'markdown',
    };
    expect(await s.call('write', { ...w, content: '# v1' }, ctx())).toMatchObject({
      code: 200,
      body: { version: 1 },
    });
    expect(
      await s.call('write', { ...w, content: '# v2' }, ctx('solution-architect')),
    ).toMatchObject({ body: { version: 2 } });

    expect(await s.call('read', { artifactId: 'platform-notes' }, ctx())).toMatchObject({
      code: 200,
      body: { version: 2, content: '# v2' },
    });
    expect(await s.call('read', { artifactId: 'platform-notes', version: 1 }, ctx())).toMatchObject(
      { body: { content: '# v1' } },
    );

    const events = (await store.read('p1')).filter((e) => e.type === 'artifact.versioned');
    expect(events.map((e) => [e.actor.id, e.data])).toEqual([
      [
        'content-analyst',
        expect.objectContaining({
          version: 1,
          ref: 'blob://p1/artifacts/platform-notes/v1.md',
          format: 'markdown',
        }),
      ],
      ['solution-architect', expect.objectContaining({ version: 2 })],
    ]);
  });

  it('refuses bad ids, invalid JSON, Blueprint writes and missing documents', async () => {
    const s = new ArtifactsToolServer(library);
    const w = {
      artifactId: 'inv',
      kind: 'inventory',
      title: 'Inventory',
      format: 'json',
      content: '{}',
    };
    expect((await s.call('write', { ...w, artifactId: '../etc' }, ctx())).code).toBe(422);
    expect(await s.call('write', { ...w, content: 'not json' }, ctx())).toMatchObject({
      code: 422,
      summary: 'content is not valid JSON',
    });
    expect((await s.call('write', { ...w, kind: 'blueprint' }, ctx())).code).toBe(422);
    expect((await s.call('read', { artifactId: 'nothing' }, ctx())).code).toBe(404);
    expect(await store.read('p1')).toEqual([]);
  });
});

describe('blackboard', () => {
  const blueprint = {
    version: 1,
    collections: {
      components: [{ key: 'hero', name: 'Hero' }],
      templates: [{ key: 'content', name: 'Content Page' }],
      pages: [{ key: 'home', name: 'Home' }],
      media: [],
    },
  };

  it('stores a valid Blueprint as the blueprint artifact and reads it back', async () => {
    const s = new BlackboardToolServer(library);
    expect((await s.call('read', {}, ctx())).code).toBe(404);
    expect(await s.call('write.blueprint', { blueprint }, ctx('solution-architect'))).toMatchObject(
      { code: 200, body: { version: 1 } },
    );
    const r = await s.call('read', {}, ctx());
    expect(r).toMatchObject({
      code: 200,
      body: { version: 1, blueprint: { collections: { pages: [{ key: 'home' }] } } },
    });
    expect((await library.latest('p1', 'blueprint'))?.kind).toBe('blueprint');
  });

  it('refuses a Blueprint the plan compiler could not use', async () => {
    const s = new BlackboardToolServer(library);
    const bad = {
      ...blueprint,
      collections: { ...blueprint.collections, pages: [{ name: 'No key' }] },
    };
    const r = await s.call('write.blueprint', { blueprint: bad }, ctx());
    expect(r.code).toBe(422);
    expect(r.summary).toMatch(/^Blueprint is invalid: collections\.pages\.0\.key/);
    expect(await store.read('p1')).toEqual([]);
  });
});

describe('decision log', () => {
  it("reads the project's decisions, and only that project's", async () => {
    const s = new DecisionLogToolServer((id) =>
      id === 'p1'
        ? [
            {
              decisionId: 'd1',
              ts: '2026-10-01T10:00:00.000Z',
              question: 'Keep the blog?',
              answer: 'Drop it',
              rationale: 'Two posts in three years',
              decidedBy: 'director',
              scopeKey: 'blog',
              escalationId: 'x1',
              ref: 'D-01',
            },
          ]
        : [],
    );
    expect(await s.call('read', {}, ctx('handover-writer'))).toMatchObject({
      code: 200,
      body: {
        decisions: [{ question: 'Keep the blog?', answer: 'Drop it', decidedBy: 'director' }],
      },
      summary: 'Read 1 decision',
    });
    expect(await s.call('read', {}, { ...ctx(), projectId: 'p2' })).toMatchObject({
      body: { decisions: [] },
    });
  });
});
