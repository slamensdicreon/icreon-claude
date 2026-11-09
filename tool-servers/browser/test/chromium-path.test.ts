import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { headlessShellPath } from '../src/guarded';

const saved = process.env.PLAYWRIGHT_BROWSERS_PATH;
afterEach(() => {
  if (saved === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = saved;
});

// The worker image installs only Playwright's headless shell; Lighthouse needs its path.
it("finds Playwright's headless shell, the newest first", async () => {
  const root = await mkdtemp(join(tmpdir(), 'pw-'));
  for (const rev of ['1200', '1243']) {
    const dir = join(root, `chromium_headless_shell-${rev}`, 'chrome-headless-shell-linux64');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chrome-headless-shell'), '#!/bin/sh\n');
    await chmod(join(dir, 'chrome-headless-shell'), 0o755);
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = root;
  expect(headlessShellPath()).toBe(
    join(
      root,
      'chromium_headless_shell-1243',
      'chrome-headless-shell-linux64',
      'chrome-headless-shell',
    ),
  );
});
