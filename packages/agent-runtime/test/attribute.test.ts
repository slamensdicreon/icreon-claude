import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { attributeFailures, type AttributionReading } from '../src/attribute';

const answering = (parsed: AttributionReading, seen: { system: string; body: string }[] = []) =>
  ({
    messages: {
      parse: async (req: { system: string; messages: { content: string }[] }) => {
        seen.push({ system: req.system, body: req.messages[0]!.content });
        return {
          parsed_output: parsed,
          stop_reason: 'end_turn',
          usage: { input_tokens: 200, output_tokens: 40 },
        };
      },
    },
  }) as unknown as Anthropic;

const input = {
  lead: { model: 'claude-sonnet-5-5', effort: 'low' as const },
  task: { title: 'Migrate Home', role: 'Content Migrator' },
  permissions: ['sitecore-authoring: item.update, media.upload'],
  failures: [
    { id: 'parity.visual', detail: 'Hero: the source shows a grey band; the page shows black.' },
    { id: 'parity.render', detail: '/ shows 80% of the text.' },
    { id: 'head.pages-render', detail: '/ answered 500.' },
  ],
  components: [
    { key: 'hero', name: 'Hero Banner' },
    { key: 'cards', name: 'Service Cards' },
  ],
};

describe('attributeFailures', () => {
  it('keeps components to the list, and a failure it left out or misnamed with the task', async () => {
    const seen: { system: string; body: string }[] = [];
    const a = await attributeFailures(
      input,
      answering(
        {
          failures: [
            { check: 'parity.visual', owner: 'component', component: 'hero', fix: 'Grey band.' },
            // A component not on the list can't be sent work.
            { check: 'parity.render', owner: 'component', component: 'footer', fix: 'Copy.' },
            // A check that didn't fail is ignored.
            { check: 'build.green', owner: 'component', component: 'cards', fix: 'x' },
          ],
        },
        seen,
      ),
    );
    expect(a.failures).toEqual([
      { check: 'parity.visual', owner: 'component', component: 'hero', fix: 'Grey band.' },
      { check: 'parity.render', owner: 'task', component: null, fix: 'Copy.' },
      { check: 'head.pages-render', owner: 'task', component: null, fix: '/ answered 500.' },
    ]);
    expect(a.tokens).toBeGreaterThan(0);
    expect(seen[0]!.body).toMatch(/- hero: Hero Banner/);
    expect(seen[0]!.system).toMatch(/header and footer are components too/);
  });
});
