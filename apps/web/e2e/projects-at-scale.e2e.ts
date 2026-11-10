import { expect, test, type Page } from '@playwright/test';
import { fitsWidth, open } from './helpers';

/**
 * The Dashboard and the switcher with many projects: the API's own list, padded with copies on
 * two platforms and three playbooks.
 */
const EXTRA = [
  [
    'Contoso',
    'sitecoreai',
    'SitecoreAI',
    'sitecoreai-customer-portal',
    'Build a SitecoreAI customer portal',
    'running',
  ],
  [
    'Fabrikam',
    'optimizely',
    'Optimizely',
    'optimizely-saas-migration',
    'Build an Optimizely CMS (SaaS) website',
    'running',
  ],
  [
    'Globex',
    'optimizely',
    'Optimizely',
    'optimizely-saas-migration',
    'Build an Optimizely CMS (SaaS) website',
    'paused',
  ],
  [
    'Initech',
    'sitecoreai',
    'SitecoreAI',
    'sitecoreai-homepage-demo',
    'SitecoreAI homepage demo',
    'intake',
  ],
  [
    'Umbrella',
    'sitecoreai',
    'SitecoreAI',
    'sitecoreai-migration',
    'Build a SitecoreAI website',
    'running',
  ],
  [
    'Hooli',
    'sitecoreai',
    'SitecoreAI',
    'sitecoreai-migration',
    'Build a SitecoreAI website',
    'running',
  ],
  [
    'Wayne',
    'sitecoreai',
    'SitecoreAI',
    'sitecoreai-customer-portal',
    'Build a SitecoreAI customer portal',
    'running',
  ],
] as const;

async function padOverview(page: Page) {
  await page.route(/\/portfolio\/overview$/, async (r) => {
    const res = await r.fetch();
    const o = await res.json();
    const base = o.projects.find((p: { yours: number }) => p.yours === 0) ?? o.projects[0];
    for (const [name, pid, pname, bid, bname, status] of EXTRA)
      o.projects.push({
        ...base,
        projectId: `x-${name.toLowerCase()}`,
        name: `${name} site`,
        client: `${name} Inc`,
        initials: name.slice(0, 2).toUpperCase(),
        status,
        archived: false,
        yours: 0,
        healthWord: status === 'paused' ? 'Paused' : 'Healthy',
        platform: { id: pid, name: pname },
        playbook: { id: bid, name: bname },
      });
    await r.fulfill({ response: res, json: o });
  });
}

test('the projects table filters by platform and playbook, groups, searches and remembers', async ({
  page,
}) => {
  await padOverview(page);
  const run = await open(page, '/');
  const table = page.getByRole('region', { name: 'Projects', exact: true });
  const rows = table.locator('tbody tr').filter({ has: page.locator('td') });

  // Grouped by playbook to start: each group's head names it and counts its projects.
  await expect(table.getByRole('button', { name: /^Customer portal 2 projects/ })).toBeVisible();
  await expect(
    table.getByRole('button', { name: /^CMS \(SaaS\) website 2 projects/ }),
  ).toBeVisible();

  // Optimizely only: two projects, and the playbook chips narrow to its one playbook.
  await table
    .getByRole('group', { name: 'Platform' })
    .getByRole('button', { name: /Optimizely/ })
    .click();
  await expect(rows).toHaveCount(2);
  await expect(table.getByRole('group', { name: 'Playbook' }).getByRole('button')).toHaveText([
    'All 2',
    'CMS (SaaS) website 2',
  ]);

  // Folding a group hides its rows.
  await table.getByRole('button', { name: /^CMS \(SaaS\) website 2 projects/ }).click();
  await expect(rows).toHaveCount(0);
  await table.getByRole('button', { name: /^CMS \(SaaS\) website 2 projects/ }).click();

  // Grouped by state, then searched by client.
  await table
    .getByRole('group', { name: 'Group by' })
    .getByRole('button', { name: 'State' })
    .click();
  await expect(table.getByRole('button', { name: /^Paused 1 project/ })).toBeVisible();
  await table.getByLabel('Search projects').fill('globex inc');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Globex site');
  await table.getByLabel('Search projects').fill('nothing like it');
  await expect(table.getByText('No project matches.')).toBeVisible();

  // The platform and the grouping stay for this browser; the search doesn't.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(
    table.getByRole('group', { name: 'Platform' }).getByRole('button', { name: /Optimizely/ }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    table.getByRole('group', { name: 'Group by' }).getByRole('button', { name: 'State' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(table.getByLabel('Search projects')).toHaveValue('');
  await table.getByRole('button', { name: 'Clear filters' }).click();
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(9);
  await fitsWidth(page);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.clean();
});

test('a long project list makes the switcher search first, with Needs you and Recent', async ({
  page,
}) => {
  await page.route(/\/projects$/, async (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    const res = await r.fetch();
    const list = await res.json();
    const base = list[0];
    for (const [name, pid, pname] of EXTRA)
      list.push({
        ...base,
        id: `x-${name.toLowerCase()}`,
        name: `${name} site`,
        client: `${name} Inc`,
        initials: name.slice(0, 2).toUpperCase(),
        waitingCount: 0,
        demo: false,
        platform: { id: pid, name: pname },
      });
    await r.fulfill({ response: res, json: list });
  });
  await page.addInitScript(() =>
    localStorage.setItem('lw-recent-projects', JSON.stringify(['x-hooli'])),
  );
  const run = await open(page, '/');
  await page
    .getByRole('button', { name: /Switch project/ })
    .first()
    .click();
  const menu = page.getByRole('dialog', { name: 'Projects' });
  await expect(menu.getByRole('region', { name: 'Needs you' })).toBeVisible();
  await expect(menu.getByRole('region', { name: 'Recent' })).toContainText('Hooli site');

  const find = menu.getByLabel('Find a project');
  await expect(find).toBeFocused();
  await find.fill('wayne');
  await expect(menu.getByRole('region', { name: 'Matches' }).getByRole('button')).toHaveText(
    /Wayne site/,
  );
  await find.press('Enter');
  await expect(page).toHaveURL(/\/p\/x-wayne/);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.errors.length = 0; // The padded project has no API behind it.
});

test('on a phone the projects come first: filters fold behind a button, nothing scrolls sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await padOverview(page);
  const run = await open(page, '/');
  const table = page.getByRole('region', { name: 'Projects', exact: true });
  const toggle = table.getByRole('button', { name: /^Filters/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(table.getByRole('group', { name: 'Platform' })).toBeHidden();
  await expect(table.getByLabel('Search projects')).toBeVisible();
  await toggle.click();
  await table
    .getByRole('group', { name: 'Platform' })
    .getByRole('button', { name: /Optimizely/ })
    .click();
  await toggle.click();
  await expect(toggle).toHaveText('Filters •');
  await fitsWidth(page);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.clean();
});
