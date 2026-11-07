import { expect, test } from '@playwright/test';
import { open, PROJECT } from './helpers';

test('archive waits for a pause, and an archived project offers Restore instead of the controls', async ({ page }) => {
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

test('an archived project can be scheduled for deletion, and the deletion cancelled', async ({
  page,
}) => {
  // The server's side, faked: archived, then scheduled once the request arrives, then cancelled.
  let deletion: { due: string; requestedBy: string; purging: boolean } | null = null;
  let typed: unknown = null;
  await page.route(new RegExp(`/projects/${PROJECT}/mission-control(\\?.*)?$`), async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.project.status = 'archived';
    body.project.deletion = deletion;
    await r.fulfill({ response: res, json: body });
  });
  await page.route(new RegExp(`/projects/${PROJECT}/deletion$`), (r) => {
    if (r.request().method() === 'POST') {
      typed = r.request().postDataJSON();
      deletion = { due: '2026-12-07T12:00:00.000Z', requestedBy: 'steve', purging: false };
    } else deletion = null;
    return r.fulfill({ json: { accepted: true, seq: 1 } });
  });
  const run = await open(page, `/p/${PROJECT}/settings`);
  const name = (
    await page.request.get('http://localhost:4000/projects').then((r) => r.json())
  ).find((p: { id: string }) => p.id === PROJECT).name as string;

  await page.getByRole('button', { name: 'Delete project' }).click();
  const dialog = page.getByRole('dialog');
  const schedule = dialog.getByRole('button', { name: 'Schedule deletion' });
  await expect(schedule).toBeDisabled();
  await dialog.getByLabel('Confirm').fill(name);
  await schedule.click();
  await expect.poll(() => typed).toEqual({ confirmation: name });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Deletion scheduled for December 7, 2026')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore project' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Cancel deletion' }).click();
  await expect.poll(() => deletion).toBeNull();
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('button', { name: 'Delete project' })).toBeVisible();
  run.clean();
});
