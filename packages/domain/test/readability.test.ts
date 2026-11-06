import { expect, it } from 'vitest';
import { openingOf, readabilityOf } from '../src';

it('passes an opening a non-technical reader can follow', () => {
  const doc = `# Pilot results\n\nThe first three sections of the home page now work in the new site. Editors can place them on a page and change their words without a developer. Nothing needs your decision.\n\n## Detail\n\nHero.tsx ported to Content SDK v1.4; \`HeroParams\` added.`;
  expect(readabilityOf(doc, 'markdown')).toEqual({ ok: true, notes: [] });
  // The detail below the opening is the team's: it is not judged.
  expect(openingOf(doc)).not.toMatch(/Hero\.tsx/);
});

it('names what makes a technical opening hard to read', () => {
  const doc = `Hero video autoplay waits for the Next.js client boundary in Hero.tsx; QuickActions kit badge needs the sampleKitRail from data/nav.ts (D-02), pinned at v1.4.2.`;
  const r = readabilityOf(doc, 'markdown');
  expect(r.ok).toBe(false);
  expect(r.notes.join(' ')).toMatch(/technical terms/);
});

it('asks for a summary when a document opens straight into a table', () => {
  const r = readabilityOf(
    '## Components\n\n| Name | Status |\n|---|---|\n| Hero | done |',
    'markdown',
  );
  expect(r.ok).toBe(false);
  expect(r.notes[0]).toMatch(/no plain summary/);
});

it('leaves data documents alone', () => {
  expect(readabilityOf('{"pages":[]}', 'json').ok).toBe(true);
});
