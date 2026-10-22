import { describe, expect, it } from 'vitest';
import { canTransition, compareEscalations, computeHealth, isInSecondRetry } from '../src';

const budgets = { tokens: 1000, usd: 100, hours: 10 };
const zero = { tokens: 0, usd: 0, hours: 0 };

describe('task state machine', () => {
  it('follows the requirements doc transitions', () => {
    expect(canTransition('planned', 'ready')).toBe(true);
    expect(canTransition('validating', 'rejected')).toBe(true);
    expect(canTransition('rejected', 'running')).toBe(true);
    expect(canTransition('done', 'rolled_back')).toBe(true);
    expect(canTransition('planned', 'done')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
    expect(canTransition('running', 'done')).toBe(false); // must pass validation
  });

  it('flags the second retry (attempt 3) only while the task is active', () => {
    expect(isInSecondRetry('running', 2)).toBe(false);
    expect(isInSecondRetry('running', 3)).toBe(true);
    expect(isInSecondRetry('done', 3)).toBe(false);
  });
});

describe('health (design spec status strip rule)', () => {
  it('is blocked when a Blocker is open, naming it', () => {
    const r = computeHealth({
      openBlockers: [{ title: 'Media upload 403' }],
      tasks: [],
      budgets,
      spent: zero,
    });
    expect(r).toEqual({ health: 'blocked', reason: 'Blocker open: Media upload 403' });
  });

  it('needs attention on a second retry or budget above 80%', () => {
    expect(
      computeHealth({
        openBlockers: [],
        tasks: [{ title: 'Port Hero', state: 'running', attempt: 3 }],
        budgets,
        spent: zero,
      }).health,
    ).toBe('attention');
    const r = computeHealth({
      openBlockers: [],
      tasks: [],
      budgets,
      spent: { tokens: 0, usd: 81, hours: 0 },
    });
    expect(r).toEqual({ health: 'attention', reason: 'Cost budget at 81%' });
  });

  it('is healthy otherwise', () => {
    expect(
      computeHealth({
        openBlockers: [],
        tasks: [],
        budgets,
        spent: { tokens: 800, usd: 0, hours: 0 },
      }).health,
    ).toBe('healthy');
  });
});

describe('escalation queue order', () => {
  it('puts open before deferred, then Blocker, Access, Decision, Review, Budget, Risk, then newest first', () => {
    const x = (type: any, raisedAt: string, status: any = 'open') => ({ type, raisedAt, status });
    const sorted = [
      x('risk', '2026-01-01T00:00:00Z'),
      x('decision', '2026-01-01T00:02:00Z'),
      x('blocker', '2026-01-01T00:05:00Z', 'deferred'),
      x('decision', '2026-01-01T00:01:00Z'),
      x('blocker', '2026-01-01T00:03:00Z'),
      x('gate', '2026-01-01T00:04:00Z'),
      x('access', '2026-01-01T00:06:00Z'),
    ].sort(compareEscalations);
    expect(
      sorted.map(
        (s) => `${s.type}@${s.raisedAt.slice(14, 16)}${s.status === 'deferred' ? '*' : ''}`,
      ),
    ).toEqual([
      'blocker@03',
      'access@06',
      'decision@02',
      'decision@01',
      'gate@04',
      'risk@00',
      'blocker@05*',
    ]);
  });
});
