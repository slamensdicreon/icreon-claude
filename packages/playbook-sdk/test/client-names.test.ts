import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Every licensed organization's agents read the playbooks and the platform packs, so neither may
 * name a client. A lesson learned on a client's project is written without the name ("on an
 * earlier site…"). Add each client here when their project starts.
 *
 * Archived versions (`playbooks/.versions`) are left as they were: only the projects pinned to
 * them, which predate other organizations, still read them.
 */
const CLIENTS = [
  'Ansco',
  'anscollc',
  'Ansell',
  'BLDR',
  'Dycom',
  'Ervin Cable',
  'Icreon',
  'Lambert',
  'Lamberts',
  "Lambert's",
  'Microsoft',
  'Paylocity',
  'TASB',
];

/** What agents read: every playbook, and every platform pack except its tests. */
const SCANNED = ['playbooks', 'platforms'];
const SKIP = new Set(['.versions', 'node_modules', 'test', 'dist']);
const TEXT = /\.(md|ya?ml|json|ts|txt|html)$/;

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else if (TEXT.test(entry.name)) out.push(path);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAMED = new RegExp(`\\b(${CLIENTS.map(escape).join('|')})\\b`, 'i');

describe('playbooks and platform packs', () => {
  it('name no client', async () => {
    const found: string[] = [];
    for (const dir of SCANNED)
      for (const file of await files(join(ROOT, dir))) {
        const lines = (await readFile(file, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          const m = NAMED.exec(line);
          if (m) found.push(`${relative(ROOT, file)}:${i + 1} names ${m[1]}`);
        });
      }
    expect(found).toEqual([]);
  });

  it('catches a client named in a prompt', () => {
    expect(NAMED.test("Paylocity's header showed only an icon")).toBe(true);
    expect(NAMED.test('--host dycom-ansco-associates-sitecoreai-v2')).toBe(true);
    expect(NAMED.test('on an earlier site the header showed only an icon')).toBe(false);
  });
});
