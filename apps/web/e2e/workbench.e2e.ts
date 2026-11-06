import { expect, test } from '@playwright/test';
import { open, PROJECT } from './helpers';

test('the Workbench tells the story, and opens a document from it', async ({ page }) => {
  const run = await open(page, `/p/${PROJECT}/workbench`);
  await expect(page.getByRole('heading', { name: 'Start here' })).toBeVisible();
  await expect(page.getByText(/Phase \d+ ·/).first()).toBeVisible();
  // A card opens the document under All files; Story comes back.
  await page.locator('ul button').filter({ hasText: 'Pilot results' }).first().click();
  await expect(page.getByRole('button', { name: 'All files', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.getByRole('heading', { name: /Pilot slice report|Pilot results/ }).first(),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Start here' })).toBeVisible();
  run.clean();
});

test('a document reads in plain words, switches to the original, and can be rewritten', async ({
  page,
}) => {
  // The plain version as the API serves it once Cypher has written it.
  await page.route(/\/versions\/\d+\/plain$/, (r) =>
    r.fulfill({
      json: {
        status: 'ready',
        version: 1,
        inShort:
          'The pilot works: the first three sections can be placed and edited in the new site.',
        means: ['Editors can build the home page without a developer.'],
        toDo: null,
        plain:
          '## What the pilot proved\n\nAn editor can drop each section onto a page in Page builder.',
        glossary: [{ term: 'Page builder', meaning: 'Where editors put pages together.' }],
      },
    }),
  );
  let rewriteNote: unknown = null;
  await page.route(/\/plain\/rewrite$/, async (r) => {
    rewriteNote = r.request().postDataJSON();
    await r.fulfill({ status: 202, json: { status: 'writing', version: 1 } });
  });
  const run = await open(page, `/p/${PROJECT}/workbench`);
  await page.locator('ul button').filter({ hasText: 'Pilot results' }).first().click();

  await expect(page.getByRole('region', { name: 'In plain words' })).toBeVisible();
  await expect(page.getByText('Nothing. This is for your information.')).toBeVisible();
  await expect(page.locator('abbr[data-term]').first()).toBeVisible();
  await page.getByRole('button', { name: 'Technical', exact: true }).click();
  await expect(page.getByText('The team’s own document, as written.')).toBeVisible();
  await page.getByRole('button', { name: 'Plain words', exact: true }).click();

  await page.getByRole('button', { name: /Not quite right/ }).click();
  await page.getByLabel('What was wrong with it? (optional)').fill('Too technical.');
  await page.getByRole('button', { name: 'Rewrite it' }).click();
  await expect.poll(() => rewriteNote).toEqual({ note: 'Too technical.' });
  run.clean();
});
