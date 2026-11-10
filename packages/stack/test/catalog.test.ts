import { fileURLToPath } from 'node:url';
import { loadFixtures } from '@lw/orchestrator';
import { compilePlan } from '@lw/plan';
import { loadCatalog } from '@lw/playbook-sdk';
import { expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../playbooks', import.meta.url));

/**
 * A project's workflow compiles its plan first thing: a plan that doesn't compile stalls every
 * project on that playbook at its first step. Every version the catalog serves must compile,
 * before a Blueprint exists and with its example Blueprint.
 */
it('compiles every playbook version the catalog serves', async () => {
  const catalog = await loadCatalog(ROOT);
  const failures: string[] = [];
  for (const entry of catalog.values())
    for (const { playbook, dir } of [entry, ...(entry.older ?? [])]) {
      const name = `${playbook.manifest.id} ${playbook.manifest.version}`;
      const { blueprint } = await loadFixtures(dir);
      for (const [label, bp] of [
        ['no Blueprint', null],
        ['the example Blueprint', blueprint],
      ] as const) {
        try {
          expect(compilePlan(playbook, bp).tasks.length).toBeGreaterThan(0);
        } catch (err) {
          failures.push(`${name} with ${label}: ${(err as Error).message}`);
        }
      }
    }
  expect(failures).toEqual([]);
  // Every archived version is compiled too; each new version makes this longer.
}, 60_000);
