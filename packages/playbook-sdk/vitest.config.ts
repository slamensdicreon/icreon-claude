import { defineConfig } from 'vitest/config';

/**
 * The catalog tests load every playbook and every archived version projects are pinned to. Each
 * archive adds to that: on a busy CI runner one ran past vitest's 5 s default (PR #22, with 0.14.0
 * and 0.2.4 newly archived) while taking under a second locally. Each test still has a limit.
 */
export default defineConfig({
  test: { testTimeout: 20_000, hookTimeout: 20_000 },
});
