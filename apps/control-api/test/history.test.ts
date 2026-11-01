import { EventBody, type LwEvent } from '@lw/contracts';
import { applyEvent, createProjectState } from '@lw/domain';
import { expect, it } from 'vitest';
import { projectHistory } from '../src/history';

function build(steps: number) {
  const s = createProjectState('p1');
  const log: LwEvent[] = [];
  for (let seq = 1; seq <= steps; seq++) {
    const e = {
      ...EventBody.parse({
        type: 'step.recorded',
        data: {
          stepId: `s${seq}`,
          agentId: 'content-migrator',
          taskId: 'home',
          toolServer: 'sitecore-authoring',
          operation: 'item.update',
          resultCode: 200,
          durationMs: 1,
          tokens: 0,
          summary: seq % 3 === 0 ? `Updated page ${seq}` : `Read item ${seq}`,
        },
      } as never),
      id: `e${seq}`,
      projectId: 'p1',
      seq,
      ts: new Date(Date.UTC(2026, 9, 1, 12, 0, seq)).toISOString(),
      actor: { kind: 'agent', id: 'content-migrator' },
      subject: { kind: 'project', id: 'p1' },
      severity: 'routine',
    } as LwEvent;
    applyEvent(s, e);
    log.push(e);
  }
  const reads: { before: number | undefined; limit: number }[] = [];
  const readNewest = async (before: number | undefined, limit: number) => {
    reads.push({ before, limit });
    return log
      .filter((e) => before === undefined || e.seq < before)
      .reverse()
      .slice(0, limit);
  };
  return { s, readNewest, reads };
}

const extra = { lessons: [], now: Date.UTC(2026, 9, 2) };

it('reads newest first, a page at a time, only as far back as 40 matching rows need', async () => {
  const { s, readNewest, reads } = build(1600);
  const h = await projectHistory(s, readNewest, 'updated page', extra);
  expect(h.activity).toHaveLength(40);
  expect(h.activity[0]!.what).toContain('Updated page 1599');
  expect(h.activity[39]!.what).toContain(`Updated page ${1599 - 39 * 3}`);
  // 40 matches sit in the newest 120 events: one page is enough.
  expect(reads).toEqual([{ before: undefined, limit: 500 }]);
});

it('pages back through the log when matches are rare, and stops at its start', async () => {
  const { s, readNewest, reads } = build(1200);
  const h = await projectHistory(s, readNewest, 'updated page 99', extra);
  expect(h.activity.map((a) => a.what.replace(/.*Updated page /, ''))).toEqual([
    '999',
    '996',
    '993',
    '990',
    '699',
    '399',
    '99',
  ]);
  expect(reads.map((r) => r.before)).toEqual([undefined, 701, 201]);
});
