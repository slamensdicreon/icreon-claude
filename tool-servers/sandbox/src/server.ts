import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';

/**
 * A working copy of the build repository for one task, in an isolated machine: agents read and
 * write files, run the build and the Content SDK CLI, and commit to their own branch. There is no
 * free-form shell. Secrets the build needs are redacted from everything returned, and the
 * repository token is used for a push and never left in the machine.
 */

/** One isolated machine with the build repository checked out at `root`. */
export interface Box {
  root: string;
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; sudo?: boolean },
  ): Promise<{ exitCode: number; output: string }>;
  read(path: string): Promise<Buffer | null>;
  write(files: { path: string; content: string }[]): Promise<void>;
}

export interface BoxProvider {
  /** The task's machine, created and cloned on first use. */
  open(
    name: string,
    init: { repoUrl: string; token: string },
  ): Promise<{ box: Box; created: boolean }>;
}

export interface WorkspaceFacts {
  /** "owner/name" of the build repository, its default branch, and the app's folder. */
  repo: string;
  branch: string;
  appPath: string;
}

export interface SandboxServerOptions {
  provider: BoxProvider;
  facts(projectId: string): Promise<WorkspaceFacts | null>;
  /** Variables the build needs (site, Context ID). Their values are redacted from output. */
  buildEnv(projectId: string): Promise<Record<string, string>>;
}

const AGENT_BRANCH = /^launchworks\/[A-Za-z0-9._/-]{1,100}$/;
const MAX_OUTPUT = 8_000;
const MAX_FILE = 300_000;

/** Paths an agent may read and write: inside the repository, never its git internals or secrets. */
export function safePath(p: string): string | null {
  const clean = p.replace(/^\.?\/+/, '');
  if (!clean || clean.includes('\0') || clean.split('/').some((s) => s === '..' || s === ''))
    return null;
  if (/^(\.git|node_modules)(\/|$)/.test(clean)) return null;
  if (/(^|\/)\.sitecore\/user\.json$/.test(clean) || /(^|\/)\.env(\.|$)/.test(clean)) return null;
  return clean;
}

/** CI and dependency settings stay as the starter has them: they run with our credentials. */
const READ_ONLY = /^(\.github\/|\.config\/|nuget\.config$|sitecore\.json$)/;

export const sandboxName = (projectId: string, taskId: string) =>
  `lw-${projectId}-${taskId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');

const OpenArgs = z.object({
  ref: z.string().regex(AGENT_BRANCH, 'an agent branch, launchworks/…').optional(),
});
const ListArgs = z.object({ path: z.string().max(300).optional() });
const ReadArgs = z.object({
  paths: z.preprocess(
    (v) => (typeof v === 'string' ? [v] : v),
    z.array(z.string().min(1).max(300)).min(1).max(20),
  ),
});
const WriteArgs = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        /** UTF-8 text; null deletes the file. */
        content: z.string().max(MAX_FILE).nullable(),
      }),
    )
    .min(1)
    .max(50),
});
const CliArgs = z.object({
  command: z.enum(['generate-map', 'scaffold']),
  /** For scaffold: the component name, PascalCase. */
  name: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]{1,60}$/, 'PascalCase')
    .optional(),
});
const CommitArgs = z.object({
  branch: z.string().regex(AGENT_BRANCH, 'must start with launchworks/'),
  message: z.string().min(1).max(2000),
});

export class SandboxToolServer implements ToolServer {
  readonly name = 'sandbox';
  readonly catalog: OperationCatalog = {
    'workspace.open': {
      description:
        "Open this task's working copy of the build repository, on your agent branch (launchworks/…; created from the default branch if new), and install dependencies. Call it first; it is reused for the rest of the task. Commit before you finish: an unused working copy expires after 45 minutes.",
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        additionalProperties: false,
      },
      mutates: false,
    },
    'fs.list': {
      description:
        'List files in the working copy (without node_modules and .git), optionally under `path`.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        additionalProperties: false,
      },
      mutates: false,
      untrusted: true,
    },
    'fs.read': {
      description: 'Read up to 20 files from the working copy, by repository-relative path.',
      inputSchema: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } },
        required: ['paths'],
        additionalProperties: false,
      },
      mutates: false,
      untrusted: true,
    },
    'fs.write': {
      description:
        'Write up to 50 files in the working copy (UTF-8 text; content null deletes). CI, dependency-tool and Sitecore CLI settings (.github, .config, nuget.config, sitecore.json) stay as the starter has them.',
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: ['string', 'null'] } },
              required: ['path', 'content'],
              additionalProperties: false,
            },
          },
        },
        required: ['files'],
        additionalProperties: false,
      },
      mutates: true,
    },
    'exec.build': {
      description:
        "Type-check and build the app (the starter's own scripts: component map, Content SDK build, next build). Returns the exit codes and the end of the output.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
    'exec.content-sdk-cli': {
      description:
        'Run the Content SDK CLI in the app: `generate-map` regenerates the component map (never edit it by hand); `scaffold` with `name` creates a new component.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', enum: ['generate-map', 'scaffold'] },
          name: { type: 'string' },
        },
        required: ['command'],
        additionalProperties: false,
      },
      mutates: true,
    },
    'git.commit': {
      description:
        'Commit every change in the working copy and push it to your agent branch (launchworks/…). Returns the commit SHA. Build first: commit work that builds.',
      inputSchema: {
        type: 'object',
        properties: { branch: { type: 'string' }, message: { type: 'string' } },
        required: ['branch', 'message'],
        additionalProperties: false,
      },
      mutates: true,
    },
  };

  constructor(private readonly opts: SandboxServerOptions) {}

  target(projectId: string) {
    return `sandbox:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const facts = await this.opts.facts(ctx.projectId);
    if (!facts) {
      return bad('This project has no build repository yet. Create it in Settings first.', 409);
    }
    const { box, created } = await this.opts.provider.open(sandboxName(ctx.projectId, ctx.taskId), {
      repoUrl: `https://github.com/${facts.repo}.git`,
      token: ctx.token,
    });
    const secrets = Object.values(await this.opts.buildEnv(ctx.projectId)).filter(
      (v) => v.length >= 6,
    );
    const redact = (s: string) =>
      [...secrets, ctx.token].reduce((out, v) => out.split(v).join('[redacted]'), s);
    const app = `${box.root}/${facts.appPath}`;
    const run = async (
      cmd: string,
      a: string[],
      o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
    ) => {
      const r = await box.run(cmd, a, { cwd: box.root, ...o });
      return { exitCode: r.exitCode, output: redact(r.output).slice(-MAX_OUTPUT) };
    };
    if (created) {
      // The clone's credentials don't stay in the machine.
      await run('git', ['remote', 'set-url', 'origin', `https://github.com/${facts.repo}.git`]);
      await run('git', ['config', 'user.name', 'Launchworks']);
      await run('git', ['config', 'user.email', 'agents@launchworks.invalid']);
    }

    switch (op) {
      case 'workspace.open': {
        const a = OpenArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        if (a.data.ref) {
          const current = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
          if (current.output.trim() !== a.data.ref) {
            const fetched = await run('git', [
              '-c',
              `http.extraHeader=${basic(ctx.token)}`,
              'fetch',
              'origin',
              a.data.ref,
            ]);
            await run(
              'git',
              fetched.exitCode === 0
                ? ['checkout', '-B', a.data.ref, 'FETCH_HEAD']
                : ['checkout', '-B', a.data.ref],
            );
          }
        }
        let install: { exitCode: number; output: string } | null = null;
        if (created || !(await box.read(`${facts.appPath}/node_modules/.package-lock.json`))) {
          const lock = await box.read(`${facts.appPath}/package-lock.json`);
          install = await run('npm', [lock ? 'ci' : 'install', '--no-audit', '--no-fund'], {
            cwd: app,
            timeoutMs: 15 * 60_000,
          });
        }
        const head = await run('git', ['log', '-1', '--format=%h %s']);
        const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
        return {
          code: install && install.exitCode !== 0 ? 500 : 200,
          body: {
            branch: branch.output.trim(),
            head: head.output.trim(),
            app: facts.appPath,
            install: install ? { exitCode: install.exitCode, output: install.output } : 'reused',
          },
          summary: `Working copy on ${branch.output.trim()} (${head.output.trim().slice(0, 60)})${install ? `, dependencies ${install.exitCode === 0 ? 'installed' : 'failed to install'}` : ''}`,
        };
      }
      case 'fs.list': {
        const a = ListArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        const under = a.data.path ? safePath(a.data.path) : '.';
        if (!under) return bad(`${a.data.path} is outside the repository.`);
        const r = await run('find', [
          under,
          '-type',
          'f',
          '-not',
          '-path',
          '*/node_modules/*',
          '-not',
          '-path',
          './.git/*',
          '-not',
          '-path',
          '*/.next/*',
        ]);
        const files = r.output
          .split('\n')
          .map((f) => f.replace(/^\.\//, ''))
          .filter(Boolean)
          .slice(0, 3000);
        return {
          code: r.exitCode === 0 ? 200 : 404,
          body: { files },
          summary: `${files.length} files${a.data.path ? ` under ${a.data.path}` : ''}`,
        };
      }
      case 'fs.read': {
        const a = ReadArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        const files = await Promise.all(
          a.data.paths.map(async (p) => {
            const path = safePath(p);
            if (!path) return { path: p, error: 'not readable' };
            const buf = await box.read(path);
            if (!buf) return { path, error: 'not found' };
            if (buf.length > MAX_FILE) return { path, error: `too large (${buf.length} bytes)` };
            if (buf.includes(0)) return { path, error: 'binary' };
            return { path, content: redact(buf.toString('utf8')) };
          }),
        );
        return {
          code: 200,
          body: { files },
          summary: `Read ${files.filter((f) => 'content' in f).length} of ${files.length} files`,
        };
      }
      case 'fs.write': {
        const a = WriteArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        const refused = a.data.files.filter((f) => {
          const path = safePath(f.path);
          return !path || READ_ONLY.test(path);
        });
        if (refused.length) return bad(`Not writable: ${refused.map((f) => f.path).join(', ')}.`);
        const writes = a.data.files.filter((f) => f.content !== null);
        if (writes.length)
          await box.write(writes.map((f) => ({ path: safePath(f.path)!, content: f.content! })));
        const deletes = a.data.files
          .filter((f) => f.content === null)
          .map((f) => safePath(f.path)!);
        if (deletes.length) await run('rm', ['-f', '--', ...deletes]);
        return {
          code: 200,
          body: { written: writes.length, deleted: deletes.length },
          summary: `Wrote ${writes.length} and deleted ${deletes.length} file${a.data.files.length === 1 ? '' : 's'}`,
        };
      }
      case 'exec.build': {
        const env = { ...(await this.opts.buildEnv(ctx.projectId)), CI: '1' };
        const types = await run('npm', ['run', 'type-check'], {
          cwd: app,
          env,
          timeoutMs: 10 * 60_000,
        });
        const build =
          types.exitCode === 0
            ? await run('npm', ['run', 'build'], { cwd: app, env, timeoutMs: 20 * 60_000 })
            : null;
        const green = types.exitCode === 0 && build?.exitCode === 0;
        return {
          code: 200,
          body: {
            green,
            typeCheck: { exitCode: types.exitCode, output: types.exitCode ? types.output : '' },
            build: build ? { exitCode: build.exitCode, output: build.output } : 'skipped',
          },
          summary: green
            ? 'Build green: type-check and build passed'
            : `Build red: ${types.exitCode ? 'type-check failed' : 'build failed'}`,
        };
      }
      case 'exec.content-sdk-cli': {
        const a = CliArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        if (a.data.command === 'scaffold' && !a.data.name) return bad('scaffold needs a name.');
        const cliArgs =
          a.data.command === 'generate-map'
            ? ['project', 'component', 'generate-map']
            : ['project', 'component', 'scaffold', a.data.name!];
        const r = await run('npx', ['--no-install', 'sitecore-tools', ...cliArgs], {
          cwd: app,
          env: await this.opts.buildEnv(ctx.projectId),
          timeoutMs: 5 * 60_000,
        });
        return {
          code: r.exitCode === 0 ? 200 : 500,
          body: { exitCode: r.exitCode, output: r.output },
          summary: `sitecore-tools ${cliArgs.slice(1).join(' ')}: ${r.exitCode === 0 ? 'done' : `exit ${r.exitCode}`}`,
        };
      }
      case 'git.commit': {
        const a = CommitArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        await run('git', ['add', '-A']);
        const staged = await run('git', ['diff', '--cached', '--name-only']);
        const paths = staged.output.split('\n').filter(Boolean);
        if (!paths.length) return bad('Nothing to commit.');
        const blocked = paths.filter((p) => !safePath(p) || READ_ONLY.test(p));
        if (blocked.length) {
          await run('git', ['reset', '-q']);
          return bad(`Refused: ${blocked.join(', ')} can't be committed from here.`);
        }
        const c = await run('git', ['commit', '-q', '-m', a.data.message]);
        if (c.exitCode !== 0)
          return { code: 500, body: { error: c.output }, summary: 'Commit failed' };
        const push = await run(
          'git',
          [
            '-c',
            `http.extraHeader=${basic(ctx.token)}`,
            'push',
            'origin',
            `HEAD:refs/heads/${a.data.branch}`,
          ],
          { timeoutMs: 120_000 },
        );
        const sha = (await run('git', ['rev-parse', 'HEAD'])).output.trim();
        if (push.exitCode !== 0)
          return {
            code: 502,
            body: { error: push.output },
            summary: `Push to ${a.data.branch} failed`,
          };
        return {
          code: 200,
          body: { branch: a.data.branch, commit: sha, files: paths.length },
          summary: `Committed ${paths.length} file${paths.length === 1 ? '' : 's'} to ${a.data.branch} (${sha.slice(0, 7)})`,
        };
      }
      default:
        return { code: 404, body: { error: `Unknown operation ${op}` } };
    }
  }
}

/** A git header carrying the token for one command, never written to the repository's config. */
export const basic = (token: string) =>
  `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

const bad = (error: string, code = 422): ToolResult => ({ code, body: { error }, summary: error });
