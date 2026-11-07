import type Anthropic from '@anthropic-ai/sdk';
import { expect, it } from 'vitest';
import { sortProposals } from '../src/proposal-sort';

const blank = { title: '', text: '', when: '', then: '', scopeKind: '', scopeId: '', roles: [] };

it('recommends on each proposal, keeping only real ids and real edits', async () => {
  const seen: { system: string; body: string }[] = [];
  const client = {
    messages: {
      parse: async (req: { system: string; messages: { content: string }[] }) => {
        seen.push({ system: req.system, body: req.messages[0]!.content });
        return {
          stop_reason: 'end_turn',
          parsed_output: {
            recommendations: [
              {
                id: 'k1',
                action: 'edit',
                reason: ' Every role hits this. ',
                duplicateOf: '',
                edit: { ...blank, scopeKind: 'global', scopeId: '*' },
              },
              {
                id: 'k2',
                action: 'reject',
                reason: 'Repeats K-12.',
                duplicateOf: ' K-12 ',
                edit: blank,
              },
              // An edit that changes nothing is an approval.
              {
                id: 'r1',
                action: 'edit',
                reason: 'Right as written.',
                duplicateOf: '',
                edit: blank,
              },
              // An id the model made up is dropped.
              { id: 'zz', action: 'approve', reason: '?', duplicateOf: '', edit: blank },
            ],
          },
        };
      },
    },
  } as unknown as Anthropic;
  const proposal = (id: string, kind: 'knowledge' | 'rule') => ({
    kind,
    id,
    ref: id.toUpperCase(),
    type: kind === 'rule' ? 'retry' : 'lesson',
    title: `Title ${id}`,
    text: `Text ${id}`,
    scope: { kind: 'project', id: 'p1' },
    roles: [],
    from: 'UtiliQuest',
  });
  const out = await sortProposals(
    {
      proposals: [proposal('k1', 'knowledge'), proposal('k2', 'knowledge'), proposal('r1', 'rule')],
      active: ['K-12: Read before you write'],
      playbooks: [
        {
          id: 'sitecoreai-homepage-demo',
          name: 'SitecoreAI homepage demo',
          platform: 'sitecoreai',
        },
      ],
      notes: ['The crawl is bounded.'],
    },
    client,
  );
  expect(out).toEqual([
    {
      id: 'k1',
      action: 'edit',
      reason: 'Every role hits this.',
      duplicateOf: null,
      edit: { scope: { kind: 'global', id: '*' } },
    },
    { id: 'k2', action: 'reject', reason: 'Repeats K-12.', duplicateOf: 'K-12', edit: null },
    { id: 'r1', action: 'approve', reason: 'Right as written.', duplicateOf: null, edit: null },
  ]);
  expect(seen[0]!.body).toContain('Already in force:\n- K-12: Read before you write');
  expect(seen[0]!.body).toContain('Changed in the product since:\n- The crawl is bounded.');
  expect(seen[0]!.body).toContain(
    'id k1 (K1, knowledge lesson, scope project:p1, from UtiliQuest)',
  );
  expect(seen[0]!.system).toMatch(/never do \(accept work that failed its checks/);
  expect(await sortProposals({ proposals: [], active: [], playbooks: [] }, client)).toEqual([]);
});
