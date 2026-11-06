import { expect, test } from '@playwright/test';
import { open, PROJECT } from './helpers';

test('the Floor orbits the team around Cypher, and follows whoever you pick', async ({ page }) => {
  const run = await open(page, `/p/${PROJECT}/activity`);
  await page
    .getByRole('button', { name: /^Floor$/ })
    .first()
    .click();
  const agents = page.locator('button[aria-label^="Follow "]');
  await expect(agents.first()).toBeVisible();
  expect(await agents.count()).toBeGreaterThan(5);
  await expect(page.getByRole('img', { name: /^Cypher/ }).first()).toBeVisible();

  // Pointing at someone holds the rings, so they can be clicked.
  const first = agents.first();
  await first.hover({ force: true });
  await first.click();
  await expect(page.locator('button[aria-label^="Following "]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop following' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Stop following' }).first().click();
  await expect(page.getByText('Click anyone to follow them')).toBeVisible();

  // Replay loads history and goes back to live.
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Replay window' })).toBeVisible();
  await page.getByRole('button', { name: 'Live', exact: true }).first().click();
  run.clean();
});
