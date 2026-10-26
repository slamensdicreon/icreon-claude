import { Sandbox } from '@vercel/sandbox';
import type { Box, BoxProvider } from './server';

/**
 * Machines on Vercel Sandbox, in our team. One per task, found again by name while it lives
 * (45 minutes after its last use), each with 4 vCPUs and 8 GB, enough for a Next.js build.
 */
export class VercelBoxProvider implements BoxProvider {
  constructor(
    private readonly credentials: { token: string; teamId: string; projectId: string },
    private readonly opts: { timeoutMs?: number; vcpus?: number } = {},
  ) {}

  async open(name: string, init: { repoUrl: string; token: string }) {
    let created = false;
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.get({ name, ...this.credentials });
      if (sandbox.status !== 'running') throw new Error(sandbox.status);
    } catch {
      const create = () =>
        Sandbox.create({
          name,
          ...this.credentials,
          source: {
            type: 'git',
            url: init.repoUrl,
            username: 'x-access-token',
            password: init.token,
            depth: 50,
          },
          runtime: 'node24',
          resources: { vcpus: this.opts.vcpus ?? 4 },
          timeout: this.opts.timeoutMs ?? 45 * 60_000,
          tags: { app: 'launchworks' },
        });
      // A clone has failed once and worked seconds later on the same repository and token.
      sandbox = await create().catch(async () => {
        await new Promise((r) => setTimeout(r, 3_000));
        return create();
      });
      created = true;
    }
    return { box: boxOf(sandbox), created };
  }
}

function boxOf(sandbox: Sandbox): Box {
  return {
    root: '/vercel/sandbox',
    async run(cmd, args, opts = {}) {
      const done = await sandbox.runCommand({
        cmd,
        args,
        cwd: opts.cwd,
        env: opts.env,
        sudo: opts.sudo,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      return { exitCode: done.exitCode, output: await done.output('both') };
    },
    async read(path) {
      return sandbox.readFileToBuffer({ path, cwd: '/vercel/sandbox' });
    },
    async write(files) {
      await sandbox.writeFiles(
        files.map((f) => ({ path: `/vercel/sandbox/${f.path}`, content: f.content })),
      );
    },
  };
}
