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

  // The facets are one toolbar line of menus, not rows of chips.
  const facet = (name: string) => table.getByRole('button', { name: new RegExp(`^${name}`) });
  await expect(facet('Platform')).toHaveText(/Platform\s*All/);
  const search = await table.getByLabel('Search projects').boundingBox();
  const group = await facet('Group by').boundingBox();
  const mid = (b: { y: number; height: number } | null) => b!.y + b!.height / 2;
  expect(Math.abs(mid(search) - mid(group))).toBeLessThan(8);

  // Optimizely only: two projects, and the playbook menu narrows to its one playbook.
  await facet('Platform').click();
  await page
    .getByRole('group', { name: 'Platform' })
    .getByRole('button', { name: /Optimizely/ })
    .click();
  await expect(page.getByRole('group', { name: 'Platform' })).toBeHidden();
  await expect(facet('Platform')).toHaveText(/Optimizely/);
  await expect(rows).toHaveCount(2);
  await facet('Playbook').click();
  await expect(page.getByRole('group', { name: 'Playbook' }).getByRole('button')).toHaveText([
    'All2',
    'CMS (SaaS) website2',
  ]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Playbook' })).toBeHidden();

  // Folding a group hides its rows.
  await table.getByRole('button', { name: /^CMS \(SaaS\) website 2 projects/ }).click();
  await expect(rows).toHaveCount(0);
  await table.getByRole('button', { name: /^CMS \(SaaS\) website 2 projects/ }).click();

  // Grouped by state, then searched by client.
  await facet('Group by').click();
  await page
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
  await expect(facet('Platform')).toHaveText(/Optimizely/);
  await expect(facet('Group by')).toHaveText(/State/);
  await expect(table.getByLabel('Search projects')).toHaveValue('');
  await table.getByRole('button', { name: 'Clear filters' }).click();
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(9);
  await fitsWidth(page);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.clean();
});

test('a long project list makes the switcher search first, with Needs you and Recent, in flight only', async ({
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
        status: 'running',
        waitingCount: 0,
        demo: false,
        platform: { id: pid, name: pname },
      });
    // A finished project: the Dashboard's to show, never the switcher's.
    list.push({
      ...base,
      id: 'x-finished',
      name: 'Finished site',
      client: 'Finished Inc',
      initials: 'FI',
      status: 'completed',
      currentPhase: null,
      waitingCount: 0,
      demo: false,
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
  await expect(menu.getByText('Finished site')).toHaveCount(0);
  await expect(menu.getByRole('button', { name: /Dashboard/ })).toContainText(/finished/);

  const find = menu.getByLabel('Find a project');
  await expect(find).toBeFocused();
  await find.fill('finished');
  await expect(menu.getByRole('region', { name: 'Matches' })).toContainText(
    'Finished projects are on the Dashboard',
  );
  await find.fill('wayne');
  await expect(menu.getByRole('region', { name: 'Matches' }).getByRole('button')).toHaveText(
    /Wayne site/,
  );
  await find.press('Enter');
  await expect(page).toHaveURL(/\/p\/x-wayne/);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.errors.length = 0; // The padded project has no API behind it.
});

test('on a phone the filters stay compact: search, then the menus, nothing scrolls sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await padOverview(page);
  const run = await open(page, '/');
  const table = page.getByRole('region', { name: 'Projects', exact: true });
  await expect(table.getByLabel('Search projects')).toBeVisible();
  const platform = table.getByRole('button', { name: /^Platform/ });
  await platform.click();
  const list = page.getByRole('group', { name: 'Platform' });
  const box = await list.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await list.getByRole('button', { name: /Optimizely/ }).click();
  await expect(platform).toHaveText(/Optimizely/);
  // The search and the menus take a few lines, not a screen: the projects start close under them.
  const search = await table.getByLabel('Search projects').boundingBox();
  const first = await table.locator('tbody tr').first().boundingBox();
  expect(first!.y - search!.y).toBeLessThan(260);
  await fitsWidth(page);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.clean();
});

test('All projects opens the table on the projects still going, whatever view was picked last', async ({
  page,
}) => {
  // One finished project beside the running ones.
  await page.route(/\/portfolio\/overview$/, async (r) => {
    const res = await r.fetch();
    const o = await res.json();
    o.projects.push({
      ...o.projects[0],
      projectId: 'x-done',
      name: 'Finished site',
      initials: 'FS',
      status: 'completed',
      archived: true,
      yours: 0,
    });
    await r.fulfill({ response: res, json: o });
  });
  const run = await open(page, '/');
  const table = page.getByRole('region', { name: 'Projects', exact: true });
  const views = table.getByRole('group', { name: 'Show projects' });
  await views.getByRole('button', { name: /^All/ }).click();
  await expect(table.getByText('Finished site')).toBeVisible();

  // Into a project, then back through All projects: the table is on Active again.
  await page
    .getByRole('button', { name: /Switch project/ })
    .first()
    .click();
  const menu = page.getByRole('dialog', { name: 'Projects' });
  // The first row is the Dashboard; the next is a project.
  await menu.locator('[data-row]').nth(1).click();
  await expect(page).toHaveURL(/\/p\//);
  await page.getByRole('button', { name: 'All projects', exact: true }).first().click();
  await expect(page).not.toHaveURL(/\/p\//);
  await expect(views.getByRole('button', { name: /^Active/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(table.getByText('Finished site')).toHaveCount(0);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  run.clean();
});
