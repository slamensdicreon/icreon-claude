import { Sandbox } from '@vercel/sandbox';
import type { Box, BoxProvider } from './server';

/**
 * Machines on Vercel Sandbox, in our team. One per task, found again by name; one that stopped
 * after 45 idle minutes resumes with its files. Each has 4 vCPUs and 8 GB, enough for a Next.js
 * build.
 */
export class VercelBoxProvider implements BoxProvider {
  constructor(
    private readonly credentials: { token: string; teamId: string; projectId: string },
    private readonly opts: { timeoutMs?: number; vcpus?: number } = {},
  ) {}

  async open(name: string, init: { repoUrl: string; token: string }) {
    let created = false;
    const params = {
      name,
      ...this.credentials,
      source: {
        type: 'git' as const,
        url: init.repoUrl,
        username: 'x-access-token',
        password: init.token,
        depth: 50,
      },
      runtime: 'node24' as const,
      resources: { vcpus: this.opts.vcpus ?? 4 },
      timeout: this.opts.timeoutMs ?? 45 * 60_000,
      tags: { app: 'launchworks' },
      // Persistent: a sandbox stopped after its idle timeout resumes with its working copy.
      resume: true,
      onCreate: async () => void (created = true),
    };
    const open = async () => {
      const sandbox = await Sandbox.getOrCreate(params);
      // A session that failed (its first clone, say) can't resume: start the sandbox over.
      if (sandbox.status === 'failed' || sandbox.status === 'aborted') {
        await sandbox.delete();
        return Sandbox.getOrCreate(params);
      }
      return sandbox;
    };
    // A clone has failed once and worked seconds later on the same repository and token.
    const sandbox = await open().catch(async () => {
      await new Promise((r) => setTimeout(r, 3_000));
      return open();
    });
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
