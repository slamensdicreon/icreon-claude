import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** A model's side-by-side judgment of a migrated page against its source. */
export const ScreenVerdict = z.object({
  verdict: z.enum(['match', 'differs']),
  /** Each difference a visitor would notice: the section, what the source shows, what the new page shows. */
  differences: z.array(z.string()),
});
export type ScreenVerdict = z.infer<typeof ScreenVerdict>;

export interface ScreenInput {
  path: string;
  /** The source page's full-page screenshot, top to bottom, as PNG slices. */
  source: Uint8Array[];
  /** The new site's rendering of the same page, sliced the same way. */
  candidate: Uint8Array[];
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

const SYSTEM = `You check a website migration the way the client will: the source page and the new site's page, each as full-page desktop screenshots cut into slices from top to bottom. The new page must look like the source: same sections in the same order, same layouts, same imagery, same colours and bands, same header and footer.

Report every difference a visitor would notice, section by section, for example:
- a section missing, added, or in a different order;
- a different layout: columns, image left or right, grid instead of carousel, cards instead of rows, a sidebar moved;
- an image, icon or logo missing or broken (alt text or an empty box where the source has a picture);
- a different background band or colour, or text that is hard or impossible to read (white on white, red on red);
- list markers, buttons or form fields that differ in kind or style;
- header or footer arranged differently.

Ignore: cookie or consent banners, video players that show blank or grey (they don't play in screenshots), job postings or other live data that changes daily, font hinting, and spacing differences of a few pixels.

Write each difference as one line: the section, what the source shows, what the new page shows. Answer "match" only when a visitor would see the same page with nothing notable changed.`;

const image = (png: Uint8Array) => ({
  type: 'image' as const,
  source: {
    type: 'base64' as const,
    media_type: 'image/png' as const,
    data: Buffer.from(png).toString('base64'),
  },
});

/** Compares a migrated page with its source from screenshots. Structured output keeps it to the verdict. */
export async function compareScreens(
  input: ScreenInput,
  client: Anthropic = new Anthropic(),
): Promise<ScreenVerdict & { tokens: number }> {
  const response = await client.messages.parse({
    model: input.model,
    max_tokens: 4000,
    output_config: { effort: input.effort, format: zodOutputFormat(ScreenVerdict) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `Page ${input.path}. The source, top to bottom:` },
          ...input.source.map(image),
          { type: 'text', text: 'The new site, top to bottom:' },
          ...input.candidate.map(image),
        ],
      },
    ],
  });
  const verdict = response.parsed_output;
  if (!verdict) throw new Error(`Comparison not readable (stop reason ${response.stop_reason})`);
  const u = response.usage;
  return {
    ...verdict,
    tokens:
      u.input_tokens +
      u.output_tokens +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0),
  };
}
