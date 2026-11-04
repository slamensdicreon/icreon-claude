import { plan } from '@lw/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { directorBot, launch, startHarness, stopHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

it('passes a release the Director approved in advance without a card, and records the approval', async () => {
  const asked: string[] = [];
  const p = await launch(h, {
    // The Director approved code deploys in advance; publishing still comes to them.
    standingApproval: async ({ release }) => (asked.push(release), release === 'deploy-code'),
  });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();
  const s = p.state()!;

  expect(
    Object.values(s.escalations)
      .filter((x) => x.title.startsWith('Approve release'))
      .map((x) => x.title),
  ).toEqual([expect.stringMatching(/Publish to Experience Edge/)]);
  const approvals = s.decisions.filter((d) => d.answer === 'Approved in advance');
  expect(approvals.map((d) => d.scopeKey).sort()).toEqual([
    'release:approve-deploy-code',
    'release:approve-prepare-hosting',
    'release:approve-switch-editing-host',
  ]);
  expect(approvals.find((d) => d.scopeKey === 'release:approve-deploy-code')!.rationale).toMatch(
    /approved this kind of release in advance \(Settings, Standing approvals\)/,
  );
  // The playbook's own standing releases don't ask the setting; the others do, by template.
  expect([...new Set(asked)].sort()).toEqual(['deploy-code', 'publish-edge']);
  expect(plan(s).tasks.find((t) => t.taskId === 'deploy-code')!.state).toBe('done');
}, 180_000);
