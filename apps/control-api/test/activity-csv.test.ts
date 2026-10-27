import type { ActivityItem } from '@lw/contracts';
import { describe, expect, it } from 'vitest';
import { activityCsv } from '../src/activity-csv';

const item = (over: Partial<ActivityItem>): ActivityItem => ({
  seq: 1,
  ts: '2026-10-27T19:21:36.000Z',
  type: 'step.recorded',
  severity: 'routine',
  phase: 4,
  agentId: 'rendering-registrar',
  taskId: 'register-stats-counter',
  toolServer: 'sitecore-authoring',
  operation: 'item.update',
  resultCode: 200,
  durationMs: 146,
  tokens: null,
  summary: 'Updated 1 field',
  actorId: 'rendering-registrar',
  toolLabel: 'Authoring API',
  outcome: '200',
  note: null,
  ...over,
});

describe('activityCsv', () => {
  it('quotes commas, quotes and line breaks, names the agent, and defuses formulas', () => {
    const csv = activityCsv(
      [
        item({ summary: 'Reject: "stale", see\nsteps' }),
        item({ seq: 2, agentId: null, actorId: 'director', summary: '=HYPERLINK("x")' }),
      ],
      (id) =>
        id === 'rendering-registrar'
          ? { persona: 'Carlos Ramirez', name: 'Rendering Registrar' }
          : undefined,
    );
    const [header, a, b] = csv.split('\r\n');
    expect(header!.split(',')).toHaveLength(17);
    expect(
      a!.startsWith(
        '1,2026-10-27T19:21:36.000Z,4,"Carlos Ramirez, Rendering Registrar",rendering-registrar,register-stats-counter,Authoring API,sitecore-authoring,item.update,200,200,146,,routine,step.recorded,"Reject: ""stale"", see\nsteps",',
      ),
    ).toBe(true);
    expect(csv).toContain('steps",');
    expect(b).toContain(`,director,`);
    expect(b).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
