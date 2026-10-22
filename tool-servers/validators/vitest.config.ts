import { defineConfig } from 'vitest/config';

// Every test drives a real Chromium; under a parallel monorepo run they need room.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
