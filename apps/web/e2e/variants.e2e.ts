import { expect, test } from '@playwright/test';
import { open } from './helpers';

test('Your playbooks: a Director adds a rule and a lesson of their own, and retires the rule', async ({
  page,
}) => {
  const { clean } = await open(page, '/manage/variants');
  await expect(page.getByRole('heading', { name: 'Your rules' })).toBeVisible();

  const when = `a page title repeats the brand name ${Date.now()}`;
  // The app may still be settling in: type until the field keeps it.
  await expect(async () => {
    await page.getByLabel('When', { exact: true }).fill(when);
    await expect(page.getByLabel('When', { exact: true })).toHaveValue(when, { timeout: 500 });
  }).toPass();
  await page.getByLabel('Then', { exact: true }).fill('keep it once, at the end');
  await page.getByRole('button', { name: 'Add rule' }).click();
  const rule = page.locator('[data-status]', { hasText: when });
  await expect(rule).toBeVisible();

  const title = `Page names follow the sitemap ${Date.now()}`;
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('What to know').fill('Name migrated pages as the sitemap does.');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('[data-status]', { hasText: title })).toBeVisible();

  await rule.getByRole('button', { name: 'Retire' }).click();
  await expect(rule).toHaveAttribute('data-status', 'retired');
  await expect(rule.getByRole('button', { name: 'Restore' })).toBeVisible();
  clean();
});
