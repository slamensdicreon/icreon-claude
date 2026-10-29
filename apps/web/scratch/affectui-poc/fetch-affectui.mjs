// Fetches affectUI items from the registry into ./vendor (git-ignored), with Icreon's access key.
// Usage: AFFECTUI_API_KEY=… node scratch/affectui-poc/fetch-affectui.mjs [slug …]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const key = process.env.AFFECTUI_API_KEY ?? process.env.AFFECTUI_TOKEN;
if (!key) {
  console.error('Set AFFECTUI_API_KEY (the Pro access key) first.');
  process.exit(1);
}
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : ['approval-card'];
const out = join(dirname(fileURLToPath(import.meta.url)), 'vendor');
await mkdir(out, { recursive: true });

for (const slug of slugs) {
  const res = await fetch(`https://www.affectui.com/r/${slug}.json`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(`${slug}: ${res.status} ${res.statusText}`);
    process.exitCode = 1;
    continue;
  }
  const item = await res.json();
  for (const file of item.files ?? []) {
    const path = join(out, file.path.split('/').pop());
    await writeFile(path, file.content);
    console.log(`${slug} → ${path}`);
  }
}
