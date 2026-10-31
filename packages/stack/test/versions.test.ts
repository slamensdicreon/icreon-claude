import type { Activities } from '@lw/orchestrator';
import { expect, it } from 'vitest';
import { byVersion } from '../src';

const acts = (name: string) =>
  ({
    emit: async () => name,
    runAgent: async () => name,
    validate: async () => name,
    loadBlueprint: async () => name,
    interpretDirective: async () => name,
    triage: async () => name,
    rollbackTask: async () => name,
  }) as unknown as Activities;

it("runs each project's calls on the version it was created on", async () => {
  const pinned: Record<string, string> = { lambert: '0.5.1', star: '0.6.3', gone: '0.4.0' };
  const a = byVersion(
    acts('current'),
    new Map([
      ['0.5.1', acts('0.5.1')],
      ['0.6.3', acts('0.6.3')],
    ]),
    (id) => pinned[id] ?? null,
  );
  expect(await a.runAgent({ projectId: 'lambert' } as never)).toBe('0.5.1');
  expect(await a.validate({ projectId: 'star' } as never)).toBe('0.6.3');
  expect(await a.loadBlueprint('lambert')).toBe('0.5.1');
  expect(await a.emit('star', [])).toBe('0.6.3');
  // A new project, or a version no longer kept: the current team.
  expect(await a.triage({ projectId: 'new' } as never)).toBe('current');
  expect(await a.runAgent({ projectId: 'gone' } as never)).toBe('current');
});
