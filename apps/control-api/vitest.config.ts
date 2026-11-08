import { defineConfig } from 'vitest/config';

/**
 * These tests build the whole API on the real playbook catalog (every playbook and every archived
 * version projects are pinned to). On a busy CI runner the first test in a file, which also pays
 * for module loading, ran past vitest's 5 s default (cypher and intake, PRs #14 and #15) while
 * taking under a second locally. Each test still has a limit; it is just one that fits the work.
 */
export default defineConfig({
  test: { testTimeout: 20_000, hookTimeout: 20_000 },
});
