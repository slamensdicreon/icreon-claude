import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/**
 * In production the web app and the API share one domain: vercel.json sends each API path prefix
 * to the API service and everything else to the web app. A route whose prefix isn't listed answers
 * 405 from the web app (the Review proposals button did, from PR #9 until this test).
 */
it('routes every API path prefix to the API service in vercel.json', () => {
  const root = join(__dirname, '..', '..', '..');
  // Every file that registers routes.
  const source = ['app.ts', 'people.ts', 'admin.ts', 'licenses.ts', 'handoff.ts']
    .map((f) => readFileSync(join(root, 'apps/control-api/src', f), 'utf8'))
    .join('\n');
  const prefixes = new Set(
    [
      ...source.matchAll(
        /app\.(?:get|post|put|delete|patch)(?:<[^>]*>)?\(\s*'\/([a-z0-9-]+)[^']*'/g,
      ),
    ].map((m) => m[1]!),
  );
  expect(prefixes.size).toBeGreaterThan(10);
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as {
    services?: Record<string, { rewrites?: unknown }>;
    rewrites?: { source: string; destination: unknown }[];
  };
  const routed = (vercel.rewrites ?? [])
    .filter((r) => JSON.stringify(r.destination).includes('"api"'))
    .map((r) => r.source);
  const missing = [...prefixes].filter(
    (p) => !routed.includes(`/${p}`) && !routed.includes(`/${p}/(.*)`),
  );
  expect(missing).toEqual([]);
});
