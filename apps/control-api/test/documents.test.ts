import { LwEvent, type EscalationView } from '@lw/contracts';
import { applyEvent, createProjectState, workbench, type ProjectState } from '@lw/domain';
import { describe, expect, it } from 'vitest';
import { withDocumentVoice } from '../src/enrich';
import { documentSummary } from '../src/voice';

const versioned = (
  s: ProjectState,
  producer: string,
  data: Record<string, unknown>,
  ts = '2026-11-04T15:00:00Z',
) =>
  applyEvent(
    s,
    LwEvent.parse({
      id: `e${s.seq + 1}`,
      projectId: s.projectId,
      seq: s.seq + 1,
      ts,
      actor: { kind: 'agent', id: producer },
      subject: { kind: 'artifact', id: data.artifactId },
      severity: 'notable',
      type: 'artifact.versioned',
      data,
    }),
  );

function state(): ProjectState {
  const s = createProjectState('px');
  const agent = (agentId: string, persona: string | null, tier: string) =>
    ({ agentId, persona, name: agentId, tier, workstream: null, state: 'idle' }) as never;
  s.agents['solution-architect'] = agent('solution-architect', 'Aisha Johnson', 'specialist');
  s.agents['chief-of-staff'] = agent('chief-of-staff', null, 'chief_of_staff');
  return s;
}

const gate = (artifactId: string, status = 'open') =>
  ({
    escalationId: 'E-01',
    type: 'gate',
    status,
    title: 'Approve Implementation Blueprint v2',
    typeLabel: 'Gate 1',
    evidence: [],
    gate: { phase: 2, artifactId, artifactVersion: 2 },
  }) as unknown as EscalationView;

describe('documents in plain words', () => {
  it('passes the agent’s own summary and pointers through untouched', () => {
    const s = state();
    const pointer = { label: 'The pilot pages', target: { kind: 'preview' as const, ref: '' } };
    versioned(s, 'solution-architect', {
      artifactId: 'pilot',
      kind: 'report',
      title: 'Pilot slice report',
      version: 1,
      summary: 'The pilot works end to end.',
      attention: [pointer],
    });
    const [a] = withDocumentVoice(workbench(s), s).artifacts;
    expect(a).toMatchObject({
      summary: 'The pilot works end to end.',
      attention: [pointer],
      summaryBy: 'agent',
      awaitingApproval: false,
    });
  });

  it('falls back to Cypher’s words: what it is, who wrote it, and what moved since you approved it', () => {
    const s = state();
    const bp = { artifactId: 'blueprint', kind: 'blueprint', title: 'Implementation Blueprint' };
    versioned(s, 'solution-architect', { ...bp, version: 1 });
    s.artifacts.blueprint!.approved = [{ version: 1, at: '2026-11-04T16:00:00Z', gate: 'Gate 1' }];
    versioned(s, 'solution-architect', { ...bp, version: 2 }, '2026-11-04T17:00:00Z');
    const [a] = withDocumentVoice(workbench(s), s).artifacts;
    expect(a!.summaryBy).toBe('cypher');
    expect(a!.summary).toBe(
      'This is the plan of record: every component, template, page and media item the team will build, and how. Aisha wrote version two. You approved version one at Gate 1; it has moved on since, so read what changed.',
    );
    expect(a!.attention!.map((p) => p.label)).toEqual([
      'What changed since version one',
      'Aisha, who wrote it',
    ]);
  });

  it('says when a gate waits on the document, and puts that first', () => {
    const s = state();
    versioned(s, 'chief-of-staff', {
      artifactId: 'blueprint',
      kind: 'blueprint',
      title: 'Implementation Blueprint',
      version: 1,
    });
    s.escalations['E-01'] = gate('blueprint');
    const [a] = withDocumentVoice(workbench(s), s).artifacts;
    expect(a!.awaitingApproval).toBe(true);
    expect(a!.summary).toContain('I wrote version one. It waits on your approval at Gate 1.');
    expect(a!.attention![0]).toEqual({
      label: 'The review that waits on you',
      target: { kind: 'surface', ref: 'inbox' },
    });
  });

  it('counts the open questions about a document in words', () => {
    const base = {
      kind: 'report',
      title: 'Report',
      latest: 1,
      writer: null,
      approved: null,
      awaiting: null,
    };
    expect(documentSummary({ ...base, questions: 1 })).toMatch(
      /One question about it waits on you\.$/,
    );
    expect(documentSummary({ ...base, questions: 3 })).toMatch(
      /Three questions about it wait on you\.$/,
    );
  });
});
