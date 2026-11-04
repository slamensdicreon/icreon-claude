import { randomUUID } from 'node:crypto';
import type {
  BetaMessageParam,
  BetaTextBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { BlobStore } from '@lw/tool-gateway';
import type { Spend } from './pricing';

/** An agent session as it stood after its last completed turn: enough to carry on from there. */
export interface SessionCheckpoint {
  /** Model turns taken so far. */
  turn: number;
  /** Tool calls made so far, so the next one gets its own step index (part of its idempotency key). */
  stepIndex: number;
  /** Room for one response, as raised by turns that hit the output limit. */
  maxTokens: number;
  spent: Spend;
  /** The system prompt the session started with; a resumed session keeps it. */
  system: BetaTextBlockParam[];
  /**
   * The conversation, ending with the last completed turn: its tool results (every tool call it
   * made has run) or its paused reply. Only ever appended to.
   */
  messages: BetaMessageParam[];
}

/**
 * Where a saved session is, small enough to travel in an activity heartbeat: the blobs that hold
 * its conversation, in order, and its counters.
 */
export interface CheckpointRef {
  parts: string[];
  /** How many messages the parts hold together. */
  messages: number;
  turn: number;
  stepIndex: number;
  maxTokens: number;
  spent: Spend;
}

/** Which session a checkpoint belongs to: a task's attempt on a project. */
export interface SessionKey {
  projectId: string;
  taskId: string;
  attempt: number;
}

/** Keeps sessions where a later attempt, on another worker, can read them. */
export interface CheckpointStore {
  /** Saves what the session added since `previous` and returns where the whole of it now is. */
  save(
    key: SessionKey,
    previous: CheckpointRef | null,
    checkpoint: SessionCheckpoint,
  ): Promise<CheckpointRef>;
  load(ref: CheckpointRef): Promise<SessionCheckpoint>;
  /** Drops a session nothing will resume. */
  discard(ref: CheckpointRef): Promise<void>;
}

interface Part {
  /** Only the first part carries it. */
  system?: BetaTextBlockParam[];
  messages: BetaMessageParam[];
}

/**
 * Sessions in the blob store, one part per turn holding only what the turn added, so saving
 * never rewrites the conversation. A part is never overwritten: one that a lost attempt wrote
 * but never reported is just not referenced, and the next attempt writes its own.
 */
export class BlobCheckpoints implements CheckpointStore {
  constructor(private readonly blobs: BlobStore) {}

  async save(key: SessionKey, previous: CheckpointRef | null, cp: SessionCheckpoint) {
    const parts = [...(previous?.parts ?? [])];
    const from = previous?.messages ?? 0;
    // A turn that only changed counters (it hit the output limit) adds no part.
    if (!parts.length || cp.messages.length > from) {
      const part: Part = {
        ...(parts.length ? {} : { system: cp.system }),
        messages: cp.messages.slice(from),
      };
      const path = `sessions/${safe(key.taskId)}/${key.attempt}/${randomUUID()}.json`;
      parts.push(
        await this.blobs.put(
          key.projectId,
          path,
          new TextEncoder().encode(JSON.stringify(part)),
          'application/json',
        ),
      );
    }
    return {
      parts,
      messages: cp.messages.length,
      turn: cp.turn,
      stepIndex: cp.stepIndex,
      maxTokens: cp.maxTokens,
      spent: { tokens: cp.spent.tokens, usd: cp.spent.usd },
    };
  }

  async load(ref: CheckpointRef): Promise<SessionCheckpoint> {
    const parts = await Promise.all(
      ref.parts.map(
        async (p) => JSON.parse(new TextDecoder().decode(await this.blobs.get(p))) as Part,
      ),
    );
    const system = parts[0]?.system;
    const messages = parts.flatMap((p) => p.messages);
    if (!system || messages.length !== ref.messages)
      throw new Error(
        `Checkpoint incomplete: ${messages.length} of ${ref.messages} messages${system ? '' : ', no system prompt'}`,
      );
    return {
      turn: ref.turn,
      stepIndex: ref.stepIndex,
      maxTokens: ref.maxTokens,
      spent: { ...ref.spent },
      system,
      messages,
    };
  }

  async discard(ref: CheckpointRef) {
    await this.blobs.delete?.(ref.parts);
  }
}

/** A task id as one path segment. */
const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, '_');
