import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';

/** One model turn. The runtime only needs this; tests supply a scripted fake. */
export interface ModelClient {
  create(params: MessageCreateParamsNonStreaming): Promise<BetaMessage>;
}

/**
 * Claude via the Anthropic SDK. Streams under the hood so long turns never hit HTTP timeouts,
 * and returns the final message. Credentials resolve the SDK's usual way (ANTHROPIC_API_KEY, a
 * CLI profile, or workload identity); the same code serves Claude Platform on AWS through its
 * client class.
 */
export function anthropicModelClient(client: Anthropic = new Anthropic()): ModelClient {
  return {
    async create(params) {
      return client.beta.messages.stream(params).finalMessage();
    },
  };
}

/**
 * Confirms the API key works and can use each model, without spending tokens (a model lookup, not
 * a completion). Workers log this at start so a bad key shows up before the first agent runs.
 */
export async function checkModels(
  ids: string[],
  client: Anthropic = new Anthropic(),
): Promise<{ id: string; ok: boolean; detail: string }[]> {
  return Promise.all(
    [...new Set(ids)].map(async (id) => {
      try {
        const m = await client.models.retrieve(id);
        return { id, ok: true, detail: m.display_name ?? id };
      } catch (err) {
        const status = (err as { status?: number }).status;
        const detail =
          status === 401
            ? 'the API key was rejected'
            : status === 403 || status === 404
              ? 'this key cannot use the model'
              : err instanceof Error
                ? err.message
                : String(err);
        return { id, ok: false, detail };
      }
    }),
  );
}
