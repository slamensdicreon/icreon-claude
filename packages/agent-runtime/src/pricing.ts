import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** USD per million tokens. Cache writes (5-minute TTL) bill at 1.25× input; reads as listed. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  // Haiku 5.5 rates for prompts up to 100K tokens.
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export interface Spend {
  tokens: number;
  usd: number;
}

export function costOf(
  model: string,
  usage: Pick<
    BetaUsage,
    'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
  >,
): Spend {
  const p = PRICES[model];
  if (!p)
    throw new Error(
      `No price for model ${model}; add it to pricing.ts before routing a role to it`,
    );
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const tokens = usage.input_tokens + usage.output_tokens + read + write;
  const usd =
    (usage.input_tokens * p.input +
      write * p.input * 1.25 +
      read * p.cacheRead +
      usage.output_tokens * p.output) /
    1_000_000;
  return { tokens, usd };
}

/**
 * What a turn counts against a role's token budget: new input, cache writes and output in full,
 * the cached conversation it re-reads at a tenth, as it is billed. A long session re-reads its
 * context every turn; counting that in full stopped ordinary tasks long before they cost much.
 */
export function budgetTokens(
  usage: Pick<
    BetaUsage,
    'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'
  >,
): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    Math.ceil((usage.cache_read_input_tokens ?? 0) / 10)
  );
}

export function knownModel(model: string): boolean {
  return model in PRICES;
}
