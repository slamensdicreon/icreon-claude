import { expect, type Page } from '@playwright/test';

export const API = 'http://localhost:4000';
export const PROJECT = 'prj-ansell';

/** Opens a page in a mode and theme, failing the test on any page error or console error. */
export async function open(
  page: Page,
  path: string,
  {
    mode = 'everything',
    theme = 'light',
  }: { mode?: 'bliss' | 'everything'; theme?: 'light' | 'dark' } = {},
) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // A missing image from a stored document is the document's, not the app's.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  await page.request.put(`${API}/me/preferences`, { data: { mode: {} } });
  await page.addInitScript(
    ([m, t]) => {
      localStorage.setItem('lw-theme', t!);
      localStorage.setItem('cypher.mode', JSON.stringify({ app: m }));
    },
    [mode, theme],
  );
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  return {
    errors,
    /** Call at the end: nothing went wrong on the page. */
    clean: () => expect(errors, errors.join('\n')).toEqual([]),
  };
}

/** No sideways scroll at the current width. */
export async function fitsWidth(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(wide, 'the page scrolls sideways').toBe(false);
}
