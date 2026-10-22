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
