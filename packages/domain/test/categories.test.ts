import type { EscalationType } from '@lw/contracts';
import { describe, expect, it } from 'vitest';
import { categoryOf } from '../src';

const card = (title: string, type: EscalationType = 'decision', context = '') => ({
  type,
  title,
  context,
});

// Cards as Ansco raised them (2026-10), one or two per kind of question.
const CASES: [ReturnType<typeof card>, string][] = [
  [card('Approve Blueprint summary v1', 'gate'), 'release'],
  [card('Budget at 80%', 'budget'), 'release'],
  [card('Approve release: Deploy the head to Vercel and register it'), 'release'],
  [card('Lead rejected 3 times: retry or accept?'), 'retry'],
  [card('Access denied: Upload iStock-1234.jpg', 'access'), 'media'],
  [card('Source URL for assistance.png?'), 'media'],
  [card('Where is stock.png’s source URL, or is it a stock asset to skip?'), 'media'],
  [card('Allow media upload from the image CDN host?'), 'media'],
  [card('Not connected: Prove the pilot slice end to end', 'access'), 'tool'],
  [card("The sandbox 'lw-prj-1-port-site-header' already exists"), 'tool'],
  [card('The Deploy API returns 403 when listing environments, so I …'), 'tool'],
  [card('Standard values still 409 on any write.'), 'tool'],
  [card('Reading /sitecore/content/Brands/ansco is still denied for …'), 'access'],
  [card("The scope widening isn't applied: reading /sitecore/content…"), 'access'],
  [card('No task builds RichText, VideoEmbed, Accordion.'), 'scope'],
  [card('FaqView has no Blueprint rendering; how should it end?'), 'scope'],
  [card('Site Footer still missing; who creates it?'), 'ownership'],
  [card('Validate templates and designs: what it needs is missing'), 'ownership'],
  [card('How do I get the Hero and Rich Text rendering IDs?'), 'ownership'],
  [card('How should Ansco Page be renamed to Corporate Page?'), 'naming'],
  [card('How should Compact and Legal variants be expressed?'), 'naming'],
  [card("How should Ansco Page's insert options be settled?"), 'naming'],
  [card('How do I get the Spanish FAQ source copy?'), 'content'],
  [card('Draft the Implementation Blueprint: needs a decision'), 'other'],
];

describe('categoryOf', () => {
  it.each(CASES)('%o is %s', (c, want) => {
    expect(categoryOf(c)).toBe(want);
  });

  it('reads the context too, and puts a gate first whatever it says', () => {
    expect(
      categoryOf(card('Port Card Grid: needs a decision', 'decision', 'The sandbox is stuck')),
    ).toBe('tool');
    expect(
      categoryOf({ ...card('Approve Gate 1', 'decision', 'source url'), gate: { phase: 2 } }),
    ).toBe('release');
  });
});
