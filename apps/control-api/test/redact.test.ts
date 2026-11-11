import { LwEvent } from '@lw/contracts';
import { describe, expect, it } from 'vitest';
import { redactForWatcher, redactJsonForWatcher } from '../src/redact';

const base = {
  id: '00000000-0000-4000-8000-000000000001',
  projectId: 'prj-1',
  seq: 7,
  ts: '2026-11-10T12:00:00.000Z',
  actor: { kind: 'system', id: 'meter' },
  severity: 'routine',
} as const;

describe('a Watcher’s copy', () => {
  it('blanks spend in a live event, and stays a valid event', () => {
    const e = LwEvent.parse({
      ...base,
      type: 'budget.updated',
      subject: { kind: 'project', id: 'prj-1' },
      data: { spent: { usd: 412.5, tokens: 1_200_000, hours: 3 } },
    });
    const seen = redactForWatcher(e) as typeof e;
    expect(seen.data).toEqual({ spent: { usd: 0, tokens: 0, hours: 0 } });
    expect(LwEvent.safeParse(seen).success).toBe(true);
  });

  it('keeps a credential’s name and drops its hint, reference and scope', () => {
    const e = LwEvent.parse({
      ...base,
      type: 'credential.registered',
      subject: { kind: 'tool', id: 'sitecore-environment' },
      data: {
        credentialId: 'sitecore-environment',
        system: 'SitecoreAI',
        scope: 'xmc-client.sitecorecloud.io',
        reference: 'vault:prj-1/sitecore-environment',
        hint: 'WXYZ',
        expiresAt: null,
      },
    });
    const seen = redactForWatcher(e) as { data: Record<string, unknown> };
    expect(seen.data).toMatchObject({
      credentialId: 'sitecore-environment',
      system: 'SitecoreAI',
      scope: '',
      reference: '',
      hint: '',
    });
    expect(LwEvent.safeParse(seen).success).toBe(true);
  });

  it('rewords activity lines about money and leaves everything else as it was', () => {
    const rows = [
      { type: 'budget.updated', summary: 'Spend: $412.50, 1,200,000 tokens', tokens: null },
      { type: 'project.updated', summary: 'Budgets set to $900, 6,000,000 tokens, 200 h' },
      { type: 'task.completed', summary: 'Homepage built', tokens: 5400 },
    ];
    expect(redactForWatcher(rows)).toEqual([
      { type: 'budget.updated', summary: 'Spend recorded', tokens: null },
      { type: 'project.updated', summary: 'Budgets changed' },
      { type: 'task.completed', summary: 'Homepage built', tokens: 0 },
    ]);
    expect(redactJsonForWatcher('not json')).toBe('not json');
  });

  it('reads Cypher’s lines to the Director as lines about the Director', () => {
    const voice = {
      text: 'Four things are yours. Three need you soon, the first before 1:35.',
      emphasis: 'Four things are yours.',
      closing: 'Nothing needs you.',
      title: 'Where search reads its content',
    };
    expect(redactForWatcher(voice)).toEqual({
      text: 'Four things wait on the Director. Three need the Director soon, the first before 1:35.',
      emphasis: 'Four things wait on the Director.',
      closing: 'Nothing waits on the Director.',
      title: 'Where search reads its content',
    });
  });
});
