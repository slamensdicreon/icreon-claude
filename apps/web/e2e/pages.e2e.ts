import { expect, test } from '@playwright/test';
import { fitsWidth, open, PROJECT } from './helpers';

const PROJECT_PAGES = ['', '/inbox', '/team', '/plan', '/workbench', '/activity', '/scorecard'];
// /projects and /inbox are API paths on the portfolio, not pages.
const PORTFOLIO_PAGES = ['/', '/team', '/workbench', '/activity', '/scorecard'];

for (const mode of ['bliss', 'everything'] as const) {
  test(`every project page opens in ${mode}, without errors`, async ({ page }) => {
    for (const p of PROJECT_PAGES) {
      const run = await open(page, `/p/${PROJECT}${p}`, { mode });
      await expect(page.locator('main').first()).toBeVisible();
      run.clean();
    }
  });

  test(`every portfolio page opens in ${mode}, without errors`, async ({ page }) => {
    for (const p of PORTFOLIO_PAGES) {
      const run = await open(page, p, { mode });
      await expect(page.locator('main').first()).toBeVisible();
      run.clean();
    }
  });
}

test('pages fit a phone without scrolling sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ['', '/workbench', '/activity']) {
    const run = await open(page, `/p/${PROJECT}${p}`);
    await fitsWidth(page);
    run.clean();
  }
});

test('Bliss or Everything stays chosen across sections', async ({ page }) => {
  const run = await open(page, `/p/${PROJECT}`, { mode: 'bliss' });
  await page.getByRole('button', { name: 'Everything', exact: true }).first().click();
  // The section rail is buttons, not links.
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /^Workbench/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/workbench$/);
  await page.waitForLoadState('networkidle');
  await expect(
    page.getByRole('button', { name: 'Everything', exact: true }).first(),
  ).toHaveAttribute('aria-pressed', 'true');
  run.clean();
});
