// Keeps the current version of a playbook for the projects pinned to it: copies
// playbooks/<id> to playbooks/.versions/<id>/<version>. Run it before bumping the version.
//   node scripts/archive-playbook.mjs sitecoreai-migration
import { cp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const id = process.argv[2];
if (!id) {
  console.error('Usage: node scripts/archive-playbook.mjs <playbook-id>');
  process.exit(1);
}
const root = new URL('../playbooks/', import.meta.url).pathname;
const from = join(root, id);
const manifest = await readFile(join(from, 'playbook.yaml'), 'utf8');
const version = manifest.match(/^version:\s*['"]?([\w.-]+)['"]?\s*$/m)?.[1];
if (!version) {
  console.error(`No version in ${from}/playbook.yaml`);
  process.exit(1);
}
const to = join(root, '.versions', id, version);
if (await stat(to).catch(() => null)) {
  console.error(`${id} ${version} is already archived at ${to}; bump the version first.`);
  process.exit(1);
}
await cp(from, to, { recursive: true });
console.log(`Archived ${id} ${version} at playbooks/.versions/${id}/${version}`);
