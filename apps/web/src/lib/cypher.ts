import type {
  CypherConversation,
  CypherConversations,
  CypherConversationSummary,
} from '@lw/contracts';
import { useSyncExternalStore } from 'react';
import { del, get, postFor } from './api';

/**
 * Saved conversations with Cypher on the Dashboard, shared by the sidebar (the list, New chat)
 * and the Cypher panel (the open conversation). One store, so picking a conversation in the rail
 * opens it in the panel and a new message in the panel shows up in the rail.
 */

export interface CypherState {
  /** The list has been fetched at least once. */
  loaded: boolean;
  /** False when no model is configured: Cypher can't answer. */
  available: boolean;
  conversations: CypherConversationSummary[];
  /** The conversation on screen; null is a new chat. */
  activeId: string | null;
  active: CypherConversation | null;
  /** A conversation being fetched after it was picked. */
  opening: string | null;
}

type Listener = () => void;

class CypherStore {
  private state: CypherState = {
    loaded: false,
    available: true,
    conversations: [],
    activeId: null,
    active: null,
    opening: null,
  };
  private readonly listeners = new Set<Listener>();

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  read = () => this.state;

  private set(patch: Partial<CypherState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** The list, newest first. Failing quietly keeps whatever was shown. */
  async load(): Promise<void> {
    try {
      const l = await get<CypherConversations>('/cypher');
      this.set({ loaded: true, available: l.available, conversations: l.conversations });
    } catch {
      this.set({ loaded: true, available: this.state.loaded ? this.state.available : false });
    }
  }

  async open(id: string): Promise<void> {
    if (this.state.activeId === id && this.state.active) return;
    this.set({ activeId: id, opening: id, active: null });
    try {
      const c = await get<CypherConversation>(`/cypher/${id}`);
      if (this.state.activeId === id) this.set({ active: c, opening: null });
    } catch (err) {
      if (this.state.activeId === id) this.set({ activeId: null, active: null, opening: null });
      void this.load();
      throw err;
    }
  }

  fresh(): void {
    this.set({ activeId: null, active: null, opening: null });
  }

  /** Sends in the open conversation, or starts one; the list follows. */
  async send(body: string): Promise<CypherConversation> {
    const { activeId } = this.state;
    const next = await postFor<CypherConversation>('/cypher', {
      body,
      ...(activeId ? { conversationId: activeId } : {}),
    });
    this.set({ activeId: next.id, active: next, opening: null });
    void this.load();
    return next;
  }

  async remove(id: string): Promise<void> {
    await del(`/cypher/${id}`);
    this.set({
      conversations: this.state.conversations.filter((c) => c.id !== id),
      ...(this.state.activeId === id ? { activeId: null, active: null, opening: null } : {}),
    });
  }
}

export const cypher = new CypherStore();

export function useCypher(): CypherState {
  return useSyncExternalStore(cypher.subscribe, cypher.read, cypher.read);
}
