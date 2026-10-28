import type { EscalationView, TaskView } from '@lw/contracts';
import { describe, expect, it } from 'vitest';
import { cardGroups, clusterQueue, problemOf } from '../src';

const task = (key: string, name: string): TaskView =>
  ({
    taskId: `migrate-pages-${key}`,
    title: `Migrate ${name}`,
    group: 'migrate-pages-{key}',
    itemKeys: [key],
  }) as TaskView;

const card = (id: string, t: TaskView, context: string, extra: Partial<EscalationView> = {}) =>
  ({
    escalationId: id,
    type: 'access',
    status: 'open',
    title: `Access denied: ${t.title}`,
    context,
    impact: `${t.title} and the tasks that depend on it wait.`,
    options: [{ id: 'retry', label: 'I fixed access; re-verify and retry', recommended: true }],
    sourceTaskId: t.taskId,
    gate: null,
    raisedAt: `2026-10-28T10:0${id.slice(-1)}:00.000Z`,
    ...extra,
  }) as EscalationView;

describe('card clustering', () => {
  const about = task('about', 'About');
  const safety = task('safety', 'Safety');
  const faq = task('faq', 'FAQ');
  const tasks = Object.fromEntries([about, safety, faq].map((t) => [t.taskId, t]));

  it('reads two cards about one cause on different items as the same problem', () => {
    expect(
      problemOf(
        'Content Migrator was refused: item.create under /sitecore/content/ansco/Home/about (403), id 1f2e3d4c5b6a7980.',
        ['Migrate About', 'about'],
      ),
    ).toBe(
      problemOf(
        'Content Migrator was refused: item.create under /sitecore/content/ansco/Home/safety (403), id 0a9b8c7d6e5f4a3b.',
        ['Migrate Safety', 'safety'],
      ),
    );
    // Contractions survive: only double quotes and backticks count as quoted text.
    expect(problemOf("It can't read the page", [])).toBe("it can't read the page");
  });

  it('shows one card for a batch with the same cause, and keeps different causes apart', () => {
    const queue = [
      card('e1', about, 'Content Migrator was refused: item.create under /Home/about (403).'),
      card('e2', safety, 'Content Migrator was refused: item.create under /Home/safety (403).'),
      card('e3', faq, 'Content Migrator was refused: the media library is read only.'),
    ];
    const out = clusterQueue(queue, tasks);
    expect(out.map((x) => x.escalationId)).toEqual(['e1', 'e3']);
    expect(out[0]!.group).toEqual({
      escalationIds: ['e1', 'e2'],
      taskIds: ['migrate-pages-about', 'migrate-pages-safety'],
      taskTitles: ['Migrate About', 'Migrate Safety'],
    });
    expect(out[1]!.group).toBeUndefined();
    // Every member knows its group, so answering any of them can answer all.
    expect(cardGroups(queue, tasks).get('e2')?.escalationIds).toEqual(['e1', 'e2']);
  });

  it('never groups gates, deferred cards, or cards from tasks outside a batch', () => {
    const single = { ...about, group: null } as TaskView;
    const queue = [
      card('e1', about, 'Refused.', { status: 'deferred' }),
      card('e2', safety, 'Refused.'),
      card('e3', single, 'Refused.', { sourceTaskId: 'one-off' }),
    ];
    expect(cardGroups(queue, { ...tasks, 'one-off': single }).size).toBe(0);
  });
});
