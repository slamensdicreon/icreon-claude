import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { open } from './helpers';

/** The API's own Dashboard, padded past six projects with copies in every state. */
const EXTRA = [
  ['Contoso', 'running'],
  ['Fabrikam', 'running'],
  ['Hooli', 'running'],
  ['Globex', 'paused'],
  ['Umbrella', 'paused'],
  ['Initech', 'intake'],
  ['Wonka', 'completed'],
] as const;

async function padOverview(page: Page) {
  await page.route(/\/portfolio\/overview$/, async (r) => {
    const res = await r.fetch();
    const o = await res.json();
    const base = o.projects.find((p: { yours: number }) => p.yours === 0) ?? o.projects[0];
    for (const [name, status] of EXTRA)
      o.projects.push({
        ...base,
        projectId: `x-${name.toLowerCase()}`,
        name: `${name} site`,
        client: `${name} Inc`,
        initials: name.slice(0, 2).toUpperCase(),
        status,
        archived: status === 'completed',
        yours: 0,
        readTone: 'normal',
        healthWord: status === 'paused' ? 'Paused' : 'Healthy',
        platform: { id: 'sitecoreai', name: 'SitecoreAI' },
        playbook: { id: 'sitecoreai-migration', name: 'Build a SitecoreAI website' },
      });
    await r.fulfill({ response: res, json: o });
  });
}

test('Bliss folds many projects into a line per state, and a line opens Everything on it', async ({
  page,
}) => {
  await padOverview(page);
  const run = await open(page, '/', { mode: 'bliss' });
  const lines = page.getByRole('region', { name: 'Projects', exact: true });
  const moving = lines.getByRole('listitem', { name: /moving$/ });
  await expect(moving).toContainText('On pace');
  await expect(moving.getByRole('button', { name: 'Open Hooli site' })).toBeVisible();
  await expect(lines.getByRole('listitem', { name: 'One ready to start' })).toContainText(
    'Initech site',
  );
  const paused = lines.getByRole('listitem', { name: 'Two paused' });
  await expect(paused).toContainText('Globex site and Umbrella site');
  await expect(page.getByRole('region', { name: 'Your book' })).toContainText('SitecoreAI');

  // A tile opens its project; "Tidy up" opens Everything on the paused ones.
  await paused.getByRole('button', { name: 'Tidy up' }).click();
  const table = page.getByRole('region', { name: 'Projects', exact: true });
  await expect(
    table.getByRole('group', { name: 'Show projects' }).getByRole('button', { name: /Paused/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.clean();
});

test('several projects at once: each action counts what it applies to, archive and delete ask for the number', async ({
  page,
}) => {
  await padOverview(page);
  const sent: { url: string; body: unknown }[] = [];
  await page.route(/\/projects\/x-[a-z]+\/(archive|delete-now|control)$/, (r) => {
    sent.push({ url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
    return r.fulfill({ json: { accepted: true, seq: 1 } });
  });
  const run = await open(page, '/');
  const table = page.getByRole('region', { name: 'Projects', exact: true });
  await table.getByLabel('Select Globex site').check();
  await table.getByLabel('Select Hooli site').check();
  const bar = page.getByRole('region', { name: 'Selected projects' });
  await expect(bar).toContainText('2 projects selected');
  // Hooli runs: it can be paused, not archived; Globex is paused: it can be resumed and archived.
  await expect(bar.getByRole('button', { name: 'Pause 1' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Resume 1' })).toBeVisible();

  // Export: the two selected, as CSV.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    bar.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv.split('\r\n')[0]).toMatch(/^Project,Client,Platform,Playbook,Status/);
  expect(csv).toContain('Globex site,Globex Inc,SitecoreAI,Website,paused');
  expect(csv).toContain('Hooli site');

  await bar.getByRole('button', { name: 'Archive 1' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Globex site');
  await expect(dialog).toContainText('1 selected project is left out');
  const go = dialog.getByRole('button', { name: 'Archive 1 project' });
  await expect(go).toBeDisabled();
  await dialog.getByLabel('Confirm').fill('1');
  await go.click();
  await expect
    .poll(() => sent)
    .toEqual([{ url: '/projects/x-globex/archive', body: { confirmation: 'Globex site' } }]);
  await expect(bar).toHaveCount(0); // Done: the selection clears.

  // Delete now, for every paused one, keeping their repositories.
  await table
    .getByRole('group', { name: 'Show projects' })
    .getByRole('button', { name: /Paused/ })
    .click();
  await table.getByLabel('Select every project shown').check();
  await bar.getByRole('button', { name: /^Delete now/ }).click();
  await dialog.getByText('Keep their build repositories').click();
  await dialog.getByLabel('Confirm').fill('2');
  await dialog.getByRole('button', { name: 'Delete 2 projects' }).click();
  await expect.poll(() => sent.length).toBe(3);
  expect(sent.slice(1)).toEqual([
    {
      url: '/projects/x-globex/delete-now',
      body: { confirmation: 'Globex site', keepRepository: true, keepHosting: false },
    },
    {
      url: '/projects/x-umbrella/delete-now',
      body: { confirmation: 'Umbrella site', keepRepository: true, keepHosting: false },
    },
  ]);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.clean();
});
