import { defineConfig } from 'vitest/config';

/**
 * The platform pack tests load the whole playbook catalog, every archived version included. Each
 * archive adds to that: on a busy CI runner three ran past vitest's 5 s default (PR #28, with
 * 0.16.0 and 0.2.6 newly archived) while taking under a second locally. Each test still has a limit.
 */
export default defineConfig({
  test: { testTimeout: 20_000, hookTimeout: 20_000 },
});
