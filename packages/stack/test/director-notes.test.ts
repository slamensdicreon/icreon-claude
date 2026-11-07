import type { PlatformPack } from '@lw/platforms';
import type { Projections } from '@lw/events';
import { expect, it } from 'vitest';
import { directorNotes, projectContext } from '../src';

const note = (ref: string, question: string, over: Record<string, unknown> = {}) => ({
  ref,
  question,
  answer: `restated: ${question}`,
  rationale: 'Director directive; no plan change.',
  decidedBy: 'director',
  scopeKey: `directive:${ref}`,
  escalationId: null,
  ts: '2026-11-07T14:33:09.109Z',
  ...over,
});

it('gives every agent the Director’s notes in their own words, and nothing else from the log', async () => {
  const decisions = [
    note('D-01', 'The site has been renamed: it is now utiliquest, not astm.'),
    // A card answer and a Lead's decision belong to their tasks, not to every agent.
    note('D-02', 'Which hero variant?', { escalationId: 'esc-1', scopeKey: 'port-hero' }),
    note('D-03', 'Retry the port', { decidedBy: 'lead' }),
  ];
  const projections = {
    get: () => ({
      name: 'UtiliQuest',
      client: 'Star LLC',
      sourceUrl: 'https://utiliquest.com/',
      brief: [],
      artifacts: {},
      decisions,
      preview: {},
    }),
  } as unknown as Projections;
  const platform = { context: () => [] } as unknown as PlatformPack;
  const text = await projectContext(projections, platform).forTask('p1', {} as never);
  expect(text).toContain(
    "The Director's notes for this project (newest last; they override documents written before them",
  );
  expect(text).toContain(
    '- D-01 (2026-11-07 14:33 UTC): The site has been renamed: it is now utiliquest, not astm.',
  );
  expect(text).not.toContain('Which hero variant?');
  expect(text).not.toContain('Retry the port');
});

it('keeps the latest ten notes, clipped, and says nothing when there are none', () => {
  const many = Array.from({ length: 12 }, (_, i) => note(`D-${i + 1}`, `Note ${i + 1}`));
  const [block] = directorNotes(many);
  expect(block).not.toContain('Note 2\n');
  expect(block).toContain('D-3 ');
  expect(block).toContain('D-12 ');
  expect(directorNotes([note('D-1', 'x'.repeat(900))])[0]).toMatch(/x…$/);
  expect(directorNotes([])).toEqual([]);
});

it('tells every agent the files the Director gave the team, with the ref media.upload takes', async () => {
  const projections = {
    get: () => ({
      name: 'Paylocity',
      client: 'Star LLC',
      sourceUrl: 'https://www.paylocity.com/',
      brief: [],
      artifacts: {},
      decisions: [],
      preview: {},
      files: [
        {
          name: 'Paylocity logo.svg',
          contentType: 'image/svg+xml',
          bytes: 2048,
          ref: 'blob://p1/files/file-1-Paylocity-logo.svg',
          note: 'The footer logo',
        },
      ],
    }),
  } as unknown as Projections;
  const text = await projectContext(projections, {
    context: () => [],
  } as unknown as PlatformPack).forTask('p1', {} as never);
  expect(text).toContain('Files the Director gave the team');
  expect(text).toContain(
    '- Paylocity logo.svg (image/svg+xml, 2 KB): ref blob://p1/files/file-1-Paylocity-logo.svg. The footer logo',
  );
});
