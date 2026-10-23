import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { ResearchToolServer } from '../src';

const ctx = { projectId: 'p', token: 'x', role: 'research-agent', taskId: 't' };
const client = (content: unknown[]) =>
  ({
    messages: { create: async () => ({ stop_reason: 'end_turn', content }) },
  }) as unknown as Anthropic;

describe('ResearchToolServer', () => {
  it('returns a cited summary and the search results', async () => {
    const s = new ResearchToolServer({
      client: client([
        {
          type: 'web_search_tool_result',
          content: [
            {
              type: 'web_search_result',
              title: 'Content SDK',
              url: 'https://doc.sitecore.com/a',
              page_age: null,
            },
          ],
        },
        {
          type: 'text',
          text: 'Content SDK 1.x is current.',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://doc.sitecore.com/a',
              title: 'Content SDK',
            },
          ],
        },
      ]),
    });
    const r = await s.call('web.search', { query: 'Sitecore Content SDK version' }, ctx);
    expect(r.body).toMatchObject({
      summary: 'Content SDK 1.x is current.',
      citations: [{ url: 'https://doc.sitecore.com/a' }],
      results: [{ title: 'Content SDK' }],
    });
  });

  it('returns a fetched page as text, and the error when it fails', async () => {
    const ok = new ResearchToolServer({
      client: client([
        {
          type: 'web_fetch_tool_result',
          content: {
            type: 'web_fetch_result',
            url: 'https://doc.sitecore.com/a',
            retrieved_at: null,
            content: { type: 'document', title: 'A', source: { type: 'text', data: 'Hello' } },
          },
        },
      ]),
    });
    expect(
      (await ok.call('web.fetch', { url: 'https://doc.sitecore.com/a' }, ctx)).body,
    ).toMatchObject({ text: 'Hello' });
    const no = new ResearchToolServer({
      client: client([
        {
          type: 'web_fetch_tool_result',
          content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' },
        },
      ]),
    });
    expect(await no.call('web.fetch', { url: 'https://x.example/a' }, ctx)).toMatchObject({
      code: 502,
    });
  });
});
