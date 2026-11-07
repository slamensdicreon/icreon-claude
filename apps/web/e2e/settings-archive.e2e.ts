import { expect, test } from '@playwright/test';
import { open, PROJECT } from './helpers';

test('archive waits for a pause, and an archived project offers only Restore', async ({ page }) => {
  const run = await open(page, `/p/${PROJECT}/settings`);
  // A running project can't be archived until it is paused.
  await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeDisabled();
  await expect(page.getByText('Pause the project first.', { exact: false })).toBeVisible();

  // The same page once the project is archived (the API's own snapshot, with its status changed).
  await page.route(new RegExp(`/projects/${PROJECT}/mission-control(\\?.*)?$`), async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.project.status = 'archived';
    await r.fulfill({ response: res, json: body });
  });
  let restored = false;
  await page.route(new RegExp(`/projects/${PROJECT}/restore$`), (r) => {
    restored = true;
    return r.fulfill({ json: { accepted: true, seq: 1 } });
  });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('This project is archived and read-only.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pause project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore project' }).click();
  await expect.poll(() => restored).toBe(true);
  run.clean();
});
