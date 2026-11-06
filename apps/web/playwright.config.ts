import { defineConfig, devices } from '@playwright/test';

/*
 * The web app end to end, against the Control API's simulator: two demo projects plus Ansell,
 * moving fast. Both servers start here (or are reused locally). PW_EXECUTABLE points at a
 * Chromium of a different revision where one is preinstalled (a dev container); CI installs the
 * matching one.
 */
const executablePath = process.env.PW_EXECUTABLE;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
    colorScheme: 'light',
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @lw/control-api start',
      cwd: '../..',
      url: 'http://localhost:4000/health',
      env: { SIM_PROJECTS: '2', SIM_SPEED: '5' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm exec vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
