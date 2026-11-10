import { expect, test } from '@playwright/test';
import { open, PROJECT } from './helpers';

test('archive waits for a pause, and an archived project offers Restore instead of the controls', async ({
  page,
}) => {
  const run = await open(page, `/p/${PROJECT}/settings`);
  // A running project can't be archived until it is paused.
  await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeDisabled();
  await expect(page.getByText('Pause the project first.', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete now', exact: true })).toBeDisabled();

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

  await page.getByRole('button', { name: 'Delete in 30 days' }).click();
  const dialog = page.getByRole('dialog');
  const schedule = dialog.getByRole('button', { name: 'Schedule deletion' });
  await expect(schedule).toBeDisabled();
  await dialog.getByLabel('Confirm').fill(name);
  await expect(schedule).toBeEnabled();
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
  await expect(page.getByRole('button', { name: 'Delete in 30 days' })).toBeVisible();
  run.clean();
});

test('a paused project can be deleted now, keeping nothing unless asked', async ({ page }) => {
  await page.route(new RegExp(`/projects/${PROJECT}/mission-control(\\?.*)?$`), async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.project.status = 'paused';
    await r.fulfill({ response: res, json: body });
  });
  let sent: unknown = null;
  await page.route(new RegExp(`/projects/${PROJECT}/delete-now$`), (r) => {
    sent = r.request().postDataJSON();
    return r.fulfill({ json: { projectId: PROJECT, finishedAt: '2026-11-09T12:00:00.000Z' } });
  });
  const run = await open(page, `/p/${PROJECT}/settings`);
  const name = (
    await page.request.get('http://localhost:4000/projects').then((r) => r.json())
  ).find((p: { id: string }) => p.id === PROJECT).name as string;

  await page.getByRole('button', { name: 'Delete now', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('link', { name: 'Download everything first (.zip)' }),
  ).toBeVisible();
  const go = dialog.getByRole('button', { name: 'Delete now' });
  await expect(go).toBeDisabled();
  await dialog.getByLabel('Confirm').fill(name);
  await go.click();
  await expect
    .poll(() => sent)
    .toEqual({ confirmation: name, keepRepository: false, keepHosting: false });
  // Back on the Dashboard: the project is gone.
  await expect(page).not.toHaveURL(new RegExp(`/p/${PROJECT}/settings`));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.clean();
});

test('an archived project offers its documents and log to download', async ({ page }) => {
  await page.route(new RegExp(`/projects/${PROJECT}/mission-control(\\?.*)?$`), async (r) => {
    const res = await r.fetch();
    const body = await res.json();
    body.project.status = 'archived';
    await r.fulfill({ response: res, json: body });
  });
  const run = await open(page, `/p/${PROJECT}/settings`);
  await expect(page.getByRole('link', { name: 'Documents (.zip)' })).toHaveAttribute(
    'href',
    new RegExp(`/projects/${PROJECT}/documents\\.zip$`),
  );
  await expect(page.getByRole('link', { name: 'Activity (.csv)' })).toBeVisible();
  run.clean();
});

test('the Dashboard lists deleted projects under Archived, with what happened outside', async ({
  page,
}) => {
  await page.route(/\/portfolio\/deleted$/, (r) =>
    r.fulfill({
      json: [
        {
          projectId: 'prj-gone',
          name: 'Globex site',
          client: 'Globex',
          requestedBy: 'steve',
          requestedAt: '2026-11-07T12:00:00.000Z',
          startedAt: '2026-12-08T07:41:00.000Z',
          finishedAt: '2026-12-08T07:42:00.000Z',
          purgedBy: 'vercel-cron',
          steps: {
            repository: { at: 'x', result: { outcome: 'deleted', detail: 'deleted' } },
            hosting: {
              at: 'x',
              result: { outcome: 'refused', detail: 'Vercel refused to delete globex-website' },
            },
          },
        },
      ],
    }),
  );
  const run = await open(page, '/');
  await page
    .getByRole('group', { name: 'Show projects' })
    .getByRole('button', { name: /Archived/ })
    .click();
  const deleted = page.getByRole('region', { name: 'Deleted projects' });
  await expect(deleted.getByText('Globex site')).toBeVisible();
  await expect(deleted.getByText('Refused')).toHaveAttribute('title', /Vercel refused/);
  await expect(deleted.getByText('Dec 8, 2026')).toBeVisible();
  run.clean();
});

test('the Danger zone says up front whether a deletion will get the repository and the Vercel project', async ({
  page,
}) => {
  await page.route(/\/portfolio\/deletion-readiness$/, (r) =>
    r.fulfill({
      json: {
        repository: { state: 'ok', detail: 'The app holds Administration: Read and write.' },
        hosting: {
          state: 'missing',
          detail: "The token's owner is a Developer in our-team, which can't delete projects.",
        },
        checkedAt: '2026-11-09T12:00:00.000Z',
      },
    }),
  );
  const run = await open(page, `/p/${PROJECT}/settings`);
  const ready = page.getByRole('status', { name: 'Deletion readiness' });
  await expect(ready).toContainText('Deleting a project won’t get everything yet');
  await expect(ready).toContainText('Build repositories (GitHub): Can delete');
  await expect(ready).toContainText('Hosting projects (Vercel): Can’t delete yet');
  await expect(ready).toContainText('a Developer in our-team');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.clean();
});
