import { InMemoryEventStore } from '@lw/events';
import { describe, expect, it } from 'vitest';
import { withLiveGuard, NOT_CONNECTED, type Activities, type AgentRequest } from '../src';

const req = (projectId: string): AgentRequest =>
  ({
    projectId,
    attempt: 1,
    task: {
      taskId: 'inventory-repo',
      role: 'repo-analyst',
      title: 'Inventory',
      templateId: 'inventory-repo',
    },
  }) as unknown as AgentRequest;

describe('withLiveGuard', () => {
  it('blocks an unconnected role on a live project, and leaves demos to the stand-ins', async () => {
    const store = new InMemoryEventStore();
    const calls: string[] = [];
    const base = {
      runAgent: async (r: AgentRequest) => {
        calls.push(r.projectId);
        return { tokens: 1, usd: 0 };
      },
      rollbackTask: async () => void calls.push('rollback'),
    } as unknown as Activities;
    const guarded = withLiveGuard(base, {
      store,
      isLive: async (id) => id === 'live',
      missing: (role) => (role === 'repo-analyst' ? ['github.tree.read'] : []),
      roleName: () => 'Repo Analyst',
    });

    await expect(guarded.runAgent(req('live'))).rejects.toMatchObject({
      type: NOT_CONNECTED,
      message: expect.stringContaining('github.tree.read'),
    });
    expect((await store.read('live')).map((e) => e.data)).toEqual([
      expect.objectContaining({
        resultCode: 503,
        summary: 'Not run: github.tree.read not connected',
      }),
    ]);
    await guarded.runAgent(req('demo'));
    await guarded.rollbackTask({ projectId: 'live', task: req('live').task } as never);
    expect(calls).toEqual(['demo']);
    expect((await store.read('live')).at(-1)!.data).toMatchObject({ resultCode: 501 });
  });
});
