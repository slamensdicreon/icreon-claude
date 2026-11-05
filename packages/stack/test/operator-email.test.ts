import { expect, it } from 'vitest';
import { notifyAll, operatorSweep, type OperatorNotice } from '../src/operator';
import { operatorEmail, recipients, resendNotifier } from '../src/operator-email';

const APP = 'https://launchworks.example';

const attention: OperatorNotice = {
  projectId: 'prj-1',
  project: 'Ervin Cable',
  kind: 'attention',
  title: 'Two decisions wait on you',
  body: 'Ervin Cable: Migrate About: team section?; Port <Footer> & links. The Leads couldn’t settle them; their work waits until you answer.',
  needs: [
    { escalationId: 'a', type: 'decision', title: 'Migrate About: team section?' },
    { escalationId: 'b', type: 'access', title: 'Port <Footer> & links' },
  ],
};

const stalled: OperatorNotice = {
  projectId: 'prj-1',
  project: 'Ervin Cable',
  kind: 'stalled',
  title: 'Nothing has moved',
  body: 'Ervin Cable: nothing has happened for 45 minutes, with two tasks left. Open Diagnostics in the project to see which.',
};

it('brands an attention notice: wordmark, project, title, the cards, a button to the Inbox', () => {
  const m = operatorEmail(attention, `${APP}/`);
  expect(m.subject).toBe('Ervin Cable: Two decisions wait on you');
  // The eye is embedded, not fetched; the word is text, legible with images blocked.
  expect(m.html).toContain('src="cid:cypher-eye"');
  expect(m.html).not.toContain('/email/cypher-wordmark.png');
  expect(m.html).toContain('>cypher<');
  expect(m.inline).toEqual([
    expect.objectContaining({ content_id: 'cypher-eye', filename: 'cypher-eye.png' }),
  ]);
  expect(m.html).toContain('fonts.googleapis.com/css2?family=Plus+Jakarta+Sans');
  expect(m.html).toContain("'Plus Jakarta Sans', 'Helvetica Neue'");
  expect(m.html).toContain('#e8553d'); // coral: it's the Director's
  expect(m.html).toContain('>Yours<');
  expect(m.html).toContain('Cypher&nbsp;&middot;&nbsp;Operator');
  expect(m.html).toContain(`href="${APP}/p/prj-1/inbox"`);
  expect(m.html).toContain('Answer in Cypher');
  // The cards, escaped, each with its type.
  expect(m.html).toContain('Port &lt;Footer&gt; &amp; links');
  expect(m.html).not.toContain('<Footer>');
  expect(m.html).toContain('>Access<');
  // The sentence under the title doesn't repeat the cards the list shows.
  expect(m.html).toContain(
    'The Leads couldn&#39;t settle these; their work waits until you answer.',
  );
  expect(m.text).toContain('- Decision: Migrate About: team section?');
  expect(m.text).toContain(`Answer in Cypher: ${APP}/p/prj-1/inbox`);
  expect(m.html).not.toMatch(/Launchworks|Icreon/);
  expect(m.text).not.toMatch(/Launchworks|Icreon/);
});

it('shows a stall without the project prefix, and links to the project', () => {
  const m = operatorEmail(stalled, APP);
  expect(m.html).toContain('Stalled');
  expect(m.html).toContain('>Nothing has happened for 45 minutes, with two tasks left.');
  expect(m.html).toContain(`href="${APP}/p/prj-1"`);
  expect(m.html).toContain('#9a6b00'); // gold: it waits
});

it('without an app URL: the lockup still (embedded eye, text word), no links, no web fonts', () => {
  const m = operatorEmail(stalled, null);
  expect(m.html).not.toMatch(/<img[^>]+src="https?:/);
  expect(m.html).toContain('src="cid:cypher-eye"');
  expect(m.html).not.toContain('href=');
  expect(m.html).not.toContain('@font-face');
  expect(m.html).not.toContain('@import');
  expect(m.html).toContain('>cypher<');
});

it('marks a test and shows its body as written', () => {
  const m = operatorEmail(
    { ...attention, title: 'The Operator can reach you', body: 'Ervin Cable: when a card waits.' },
    APP,
    { test: true },
  );
  expect(m.subject).toBe('[Test] Ervin Cable: The Operator can reach you');
  expect(m.html).toContain('>Test<');
  expect(m.html).toContain('When a card waits.');
});

it('sends through Resend, and says why when Resend refuses', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = resendNotifier({
    apiKey: 're_test',
    to: ['director@example.com'],
    from: 'Operator <ops@example.com>',
    appUrl: APP,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
    }) as typeof fetch,
  });
  expect(await ok(attention)).toEqual({ id: 'em_1' });
  expect(calls[0]!.url).toBe('https://api.resend.com/emails');
  expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
  const sent = JSON.parse(String(calls[0]!.init.body));
  expect(sent).toMatchObject({
    from: 'Operator <ops@example.com>',
    to: ['director@example.com'],
    subject: 'Ervin Cable: Two decisions wait on you',
  });
  expect(sent.html).toContain('<!doctype html>');
  expect(sent.text).toContain('Ervin Cable: Two decisions wait on you');

  const refused = resendNotifier({
    apiKey: 're_test',
    to: ['director@example.com'],
    from: 'Operator <ops@unverified.example>',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ message: 'The unverified.example domain is not verified.' }), {
        status: 403,
      })) as unknown as typeof fetch,
  });
  await expect(refused(stalled)).rejects.toThrow(
    'Resend refused the email (403): The unverified.example domain is not verified.',
  );
});

it('reads recipients from a list, and notifies every channel even when one fails', async () => {
  expect(recipients(' a@x.com, b@y.org;c@z.io  not-an-email ')).toEqual([
    'a@x.com',
    'b@y.org',
    'c@z.io',
  ]);
  expect(recipients(undefined)).toEqual([]);
  expect(notifyAll([])).toBeUndefined();

  const got: string[] = [];
  const both = notifyAll([
    async () => {
      throw new Error('Resend refused the email (403): not verified');
    },
    async (n) => void got.push(n.title),
  ])!;
  await expect(both(stalled)).rejects.toThrow('not verified');
  expect(got).toEqual(['Nothing has moved']);

  // The sweep reports a notice it couldn't send instead of dropping it silently.
  const logged: string[] = [];
  await operatorSweep({
    projections: {
      catchUpAll: async () => {},
      all: () => [
        {
          projectId: 'p1',
          name: 'Ervin Cable',
          mode: 'live',
          status: 'running',
          startedAt: '2026-11-04T10:00:00.000Z',
          tasks: { t: { taskId: 't', state: 'planned' } },
          escalations: {},
          conversation: [],
          latest: [{ ts: '2026-11-04T10:00:00.000Z' }],
        },
      ],
    } as never,
    store: { append: async () => {} } as never,
    notify: both,
    log: (message, err) => void logged.push(`${message}: ${(err as Error).message}`),
    now: () => new Date('2026-11-04T11:00:00.000Z'),
  });
  expect(logged).toEqual([
    'Operator notice for p1 not sent: Resend refused the email (403): not verified',
  ]);
});
