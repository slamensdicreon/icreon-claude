import { expect, test } from '@playwright/test';
import { API, open, PROJECT } from './helpers';

const KIT = 'Where should sample kit requests go?';

/** The sample kit card, raised fresh (or still open from an earlier test). */
async function raiseKit(request: import('@playwright/test').APIRequestContext) {
  await request.post(`${API}/projects/${PROJECT}/scenarios/kit`, { data: {} });
}

/** Brings the kit card forward in Bliss when others wait beside it (a dot per card). */
async function focusKit(page: import('@playwright/test').Page) {
  const dot = page.getByRole('button', { name: KIT });
  if (await dot.count()) await dot.click();
}

test('Bliss shows one calm card: the question, its answers, and only what the chosen answer needs', async ({
  page,
}) => {
  await raiseKit(page.request);
  // Answer nothing for real: the request is what the card is responsible for.
  await page.route('**/escalations/E-09/resolve', (r) => r.fulfill({ json: { accepted: true } }));
  const run = await open(page, `/p/${PROJECT}/inbox`, { mode: 'bliss' });
  await focusKit(page);

  const card = page.getByRole('region', { name: KIT });
  await expect(card.getByRole('radio')).toHaveCount(3);
  // Calm until an answer is chosen: no fields, no send button.
  await expect(card.getByRole('textbox')).toHaveCount(0);
  await expect(card.getByRole('button', { name: /^Send/ })).toHaveCount(0);

  // The answer that needs something more asks for it; the note travels with the answer.
  await card.getByRole('radio', { name: /Ansell's system/ }).click();
  await card
    .getByLabel('Who at Ansell IT should we ask for the address?')
    .fill('The web team lead');
  await card.getByRole('button', { name: 'Add a note' }).click();
  await card.getByRole('textbox', { name: /A note for/ }).fill('I will introduce them today.');
  const sent = page.waitForRequest((r) => r.url().endsWith('/escalations/E-09/resolve'));
  await card.getByRole('button', { name: /^Send/ }).click();
  const body = (await sent).postDataJSON();
  expect(body.optionId).toBe('A');
  expect(body.notes).toContain('Who at Ansell IT should we ask for the address? The web team lead');
  expect(body.notes).toContain('I will introduce them today.');
  run.clean();
});

test('"Write my own" needs words before it sends, and sends them to Cypher', async ({ page }) => {
  await raiseKit(page.request);
  await page.route(`**/projects/${PROJECT}/messages`, (r) =>
    r.request().method() === 'POST' ? r.fulfill({ json: { accepted: true } }) : r.continue(),
  );
  const run = await open(page, `/p/${PROJECT}/inbox`, { mode: 'bliss' });
  await focusKit(page);
  const card = page.getByRole('region', { name: KIT });

  await card.getByRole('button', { name: 'Write my own' }).click();
  const send = card.getByRole('button', { name: 'Send to Cypher' });
  await expect(send).toBeDisabled();
  await card.getByRole('textbox').fill('Email them to the samples inbox until IT is ready.');
  await expect(send).toBeEnabled();
  const sent = page.waitForRequest((r) => r.url().endsWith(`/projects/${PROJECT}/messages`));
  await send.click();
  const body = (await sent).postDataJSON();
  expect(body).toMatchObject({ about: 'E-09', body: expect.stringContaining('samples inbox') });
  await expect(page.getByText('Sent to Cypher')).toBeVisible();
  run.clean();
});

test('Everything opens a card as a brief, and a gate sent back requires notes', async ({
  page,
}) => {
  await page.request.post(`${API}/projects/${PROJECT}/scenarios/pilot`, { data: {} });
  const run = await open(page, `/p/${PROJECT}/inbox`);
  await page
    .getByRole('button', { name: /Are the first three homepage sections right/ })
    .first()
    .click();
  await expect(page.getByText("What's going on").first()).toBeVisible();
  await page.getByText('Ask for changes').first().click();
  const sendBack = page.getByRole('button', { name: 'Send back', exact: true });
  await expect(sendBack).toBeDisabled();
  await page.getByLabel('What needs to change?').fill('The hero headline is too long on phones.');
  await expect(sendBack).toBeEnabled();
  run.clean();
});
