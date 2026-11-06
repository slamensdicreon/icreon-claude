import { EventBody, type LwEvent } from '@lw/contracts';
import { describe, expect, it } from 'vitest';
import { applyEvent, audienceOf, createProjectState, headlineOf, readMinutes } from '../src';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, actor = 'system'): LwEvent =>
  ({
    ...EventBody.parse({ type, data }),
    id: `e${++seq}`,
    projectId: 'p1',
    seq,
    ts: new Date(Date.UTC(2026, 9, 1, 12, seq)).toISOString(),
    actor: { kind: actor === 'system' ? 'system' : 'agent', id: actor },
    subject: { kind: 'project', id: 'p1' },
    severity: 'routine',
  }) as LwEvent;

const saved = (artifactId: string, by: string, extra: Record<string, unknown> = {}) =>
  ev(
    'artifact.versioned',
    { artifactId, kind: 'inventory', title: 'Component inventory', version: 1, ...extra },
    by,
  );

describe('documents in plain words', () => {
  it('says who a document is for, from its kind and title', () => {
    expect(audienceOf('blueprint', 'Implementation Blueprint')).toBe('director');
    expect(audienceOf('platform_notes', 'Platform Notes')).toBe('director');
    expect(audienceOf('report', 'Pilot slice report')).toBe('director');
    expect(audienceOf('report', 'Conformance: batch 2')).toBe('team');
    expect(audienceOf('inventory', 'Route and content inventory')).toBe('director');
    expect(audienceOf('inventory', 'Component inventory')).toBe('team');
    expect(audienceOf('pull_request', '12 Register batch 2 renderings')).toBe('team');
    expect(audienceOf('something_new', 'Whatever')).toBe('team');
  });

  it('gives each a short title a non-technical reader can scan', () => {
    expect(headlineOf('blueprint', 'Implementation Blueprint')).toBe('How the site gets rebuilt');
    expect(headlineOf('inventory', 'Route and content inventory')).toBe(
      'What content moves, and where',
    );
    expect(headlineOf('inventory', 'Page inventory')).toBe('Every page on the site');
    expect(headlineOf('inventory', 'Media inventory')).toBe('Media list');
    expect(headlineOf('report', 'Conformance: batch 2')).toBe('Quality check, batch 2');
    expect(headlineOf('report', 'Pilot slice report')).toBe('Pilot results');
    expect(headlineOf('pull_request', '12 Register batch 2 renderings')).toBe(
      'Code: Register batch 2 renderings',
    );
    expect(headlineOf('inventory', 'Template inventory')).toBe('Template list');
  });

  it('reads at an easy pace, never under a minute', () => {
    expect(readMinutes('one two three')).toBe(1);
    expect(readMinutes(Array(1100).fill('word').join(' '))).toBe(5);
  });
});

describe('the phase a document was written in', () => {
  const start = () => {
    seq = 0;
    const s = createProjectState('p1');
    applyEvent(
      s,
      ev('project.created', {
        name: 'Acme',
        client: 'Acme',
        playbook: { id: 'x', version: '1' },
        budgets: { tokens: 1, usd: 1, hours: 1 },
        phases: [
          {
            number: 1,
            name: 'Discovery',
            shortName: 'Discovery',
            gate: 'none',
            gateLabel: null,
            exitCriteria: '',
          },
          {
            number: 2,
            name: 'Blueprint',
            shortName: 'Blueprint',
            gate: 'director',
            gateLabel: 'Gate 1',
            exitCriteria: '',
          },
        ],
        roster: [],
        site: { sourceUrl: 'https://acme.example' },
      }),
    );
    return s;
  };

  it('is none before any phase began (an older log)', () => {
    const s = start();
    applyEvent(s, saved('a', 'repo-analyst'));
    expect(s.artifacts.a!.versions[0]!.phase).toBeNull();
  });

  it('is the newest current phase when the author runs no task', () => {
    const s = start();
    applyEvent(s, ev('phase.entered', { phase: 1 }));
    applyEvent(s, ev('phase.entered', { phase: 2 }));
    applyEvent(s, saved('a', 'repo-analyst'));
    expect(s.artifacts.a!.versions[0]!.phase).toBe(2);
  });

  it("keeps the agent's own title and audience when it gave them", () => {
    const s = start();
    applyEvent(
      s,
      saved('a', 'repo-analyst', { headline: 'Every section, listed', audience: 'director' }),
    );
    expect(s.artifacts.a!.versions[0]).toMatchObject({
      headline: 'Every section, listed',
      audience: 'director',
    });
  });
});
