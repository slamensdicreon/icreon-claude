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
  /**
   * Who agents' commits are by: the GitHub App's bot account, so GitHub and Vercel know the
   * author. Without one, commits carry a placeholder address Vercel refuses to deploy.
   */
  author?: { name: string; email: string };
}

const PLACEHOLDER_AUTHOR = { name: 'Launchworks', email: 'agents@launchworks.invalid' };
export const authorOf = (facts: WorkspaceFacts) => facts.author ?? PLACEHOLDER_AUTHOR;

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
  fresh: z.boolean().optional(),
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
/** Where accepted components come together; the editing host deploys it. */
export const INTEGRATION_BRANCH = 'launchworks/integration';
/**
 * The Director's own fixes, made outside any task. Every integration merges it when it exists,
 * a rebuild included, so hand fixes never drop out; agents don't commit to it.
 */
export const DIRECTOR_BRANCH = 'launchworks/director';
/** Files the build generates: a conflict in them is settled by generating them again. */
const GENERATED = /(^|\/)(\.sitecore\/component-map(\.client)?\.ts|package-lock\.json)$/;
const IntegrateArgs = z.object({
  branches: z
    .array(
      z
        .string()
        .regex(AGENT_BRANCH, 'agent branches, launchworks/…')
        .refine(
          (b) => b !== INTEGRATION_BRANCH,
          'the branches to bring in, not the integration branch',
        ),
    )
    .min(1)
    .max(80),
  /** Rebuild from the default branch with exactly these branches, leaving out any others. */
  fresh: z.boolean().optional(),
});
const CommitArgs = z.object({
  branch: z
    .string()
    .regex(AGENT_BRANCH, 'must start with launchworks/')
    .refine((b) => b !== DIRECTOR_BRANCH, `${DIRECTOR_BRANCH} holds the Director's own fixes`),
  message: z.string().min(1).max(2000),
});

export class SandboxToolServer implements ToolServer {
  readonly name = 'sandbox';
  /** Builds, installs and serialization run long: up to 30 minutes for one step. */
  readonly timeoutMs = 45 * 60_000;
  readonly catalog: OperationCatalog = {
    'git.integrate': {
      description: `Bring accepted agent branches (launchworks/design-system, launchworks/port-…) into ${INTEGRATION_BRANCH}, which the editing host deploys: starts from the integration branch as pushed (or the default branch the first time), merges each branch in order, settles conflicts in generated files (the component map, package-lock.json) by generating them again, builds once, and pushes only if the build is green. Branches that don't exist are skipped and listed; one already merged changes nothing. The Director's fixes (${DIRECTOR_BRANCH}) are always merged last when that branch exists. A conflict in source files stops it before anything is pushed, naming the branch and files: integrate again without that branch. If another integration pushes first, it starts again from that, up to three times.`,
      inputSchema: {
        type: 'object',
        properties: {
          branches: { type: 'array', items: { type: 'string' } },
          fresh: {
            type: 'boolean',
            description:
              'Rebuild from the default branch with exactly these branches, leaving out any not listed (a cancelled component, say). Replaces the integration branch only if no one pushed to it meanwhile.',
          },
        },
        required: ['branches'],
        additionalProperties: false,
      },
      mutates: true,
    },
    'workspace.open': {
      description:
        "Open this task's working copy of the build repository, on your agent branch (launchworks/…; created from the default branch if new), and install dependencies. Call it first; it is reused for the rest of the task. A working copy kept from an earlier run is brought up to date with the branch on GitHub, and the summary names any uncommitted files it holds. `fresh: true` discards everything uncommitted and starts again from the branch as pushed: use it when the build fails in files you never changed. Commit before you finish: an unused working copy expires after 45 minutes.",
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' }, fresh: { type: 'boolean' } },
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
        "Commit every change in the working copy and push it to your agent branch (launchworks/…). Returns the commit SHA. Build first: commit work that builds. Commits an earlier push left behind are pushed too, and if the branch moved on GitHub your commits are replayed on top of it. Don't work around a failed push with another tool: the branch would then differ from this working copy.",
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
    }
    // Set on every call, so a working copy made before the author was known commits as it now.
    await run('git', ['config', 'user.name', authorOf(facts).name]);
    await run('git', ['config', 'user.email', authorOf(facts).email]);
    const auth = ['-c', `http.extraHeader=${basic(ctx.token)}`];

    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const count = async (range: string) =>
      Number((await run('git', ['rev-list', '--count', range])).output.trim()) || 0;

    /**
     * Brings the working copy up to the branch as just fetched (FETCH_HEAD): fast-forwards when it
     * is only behind, and replays its own commits on top when both moved (a commit whose change is
     * already on GitHub drops out). Says what it did, or why it couldn't.
     */
    const catchUp = async (): Promise<string> => {
      const behind = await count('HEAD..FETCH_HEAD');
      if (!behind) return '';
      const ahead = await count('FETCH_HEAD..HEAD');
      if (!ahead) {
        const ff = await run('git', ['merge', '--ff-only', '-q', 'FETCH_HEAD']);
        return ff.exitCode === 0
          ? `brought up to date with ${plural(behind, 'commit')} pushed since`
          : `${plural(behind, 'commit')} behind GitHub and couldn't catch up (${lastError(ff.output)}): open it with fresh: true`;
      }
      const replayed = await run('git', ['rebase', '--autostash', 'FETCH_HEAD']);
      if (replayed.exitCode === 0)
        return `replayed its own commits on the ${plural(behind, 'commit')} pushed since`;
      await run('git', ['rebase', '--abort']);
      return `differs from the branch on GitHub (${plural(ahead, 'local commit')}, ${plural(behind, 'pushed commit')}) and couldn't replay them: open it with fresh: true`;
    };

    /** Installs dependencies when the working copy has none. */
    const install = async () => {
      if (!created && (await box.read(`${facts.appPath}/node_modules/.package-lock.json`)))
        return { result: null, lockUpdated: false };
      const lock = await box.read(`${facts.appPath}/package-lock.json`);
      const npm = (verb: string) =>
        run('npm', [verb, '--no-audit', '--no-fund'], { cwd: app, timeoutMs: 15 * 60_000 });
      let result = await npm(lock ? 'ci' : 'install');
      let lockUpdated = false;
      // Sitecore's starter has shipped a lock file behind its package.json, which npm ci
      // refuses. npm install brings the lock file up to date; the agent commits it.
      if (lock && result.exitCode !== 0 && /EUSAGE|in sync/.test(result.output)) {
        result = await npm('install');
        lockUpdated = result.exitCode === 0;
      }
      return { result, lockUpdated };
    };

    /** The starter's build: generate .sitecore, type-check, then build. */
    const build = async () => {
      const env = { ...(await this.opts.buildEnv(ctx.projectId)), CI: '1' };
      const npm = (script: string, minutes: number) =>
        run('npm', ['run', script], { cwd: app, env, timeoutMs: minutes * 60_000 });
      // The starter generates .sitecore/ (sites, import maps, metadata) during its build, and
      // its type-check needs those files: generate first, so a clean checkout type-checks.
      const pkg = await box.read(`${facts.appPath}/package.json`);
      const has = new Set(
        Object.keys(
          (pkg ? (JSON.parse(pkg.toString('utf8')) as { scripts?: object }) : {}).scripts ?? {},
        ),
      );
      const staged = ['sitecore-tools:generate-map', 'sitecore-tools:build', 'next:build'].every(
        (x) => has.has(x),
      );
      let generated: { exitCode: number; output: string } | null = null;
      if (staged) {
        generated = await npm('sitecore-tools:generate-map', 5);
        if (generated.exitCode === 0) generated = await npm('sitecore-tools:build', 10);
      }
      const types =
        !generated || generated.exitCode === 0
          ? await npm('type-check', 10)
          : { exitCode: generated.exitCode, output: generated.output };
      // Every build reads the content as it is now. A page fetched by an earlier build in this
      // working copy (before it had a layout, or while it was being edited) otherwise fails every
      // later build, for nothing the branch changed.
      if (types.exitCode === 0) await run('rm', ['-rf', `${app}/.next/cache/fetch-cache`]);
      const built = types.exitCode === 0 ? await npm(staged ? 'next:build' : 'build', 20) : null;
      const green = types.exitCode === 0 && built?.exitCode === 0;
      const why =
        generated && generated.exitCode
          ? 'generating .sitecore failed'
          : types.exitCode
            ? 'type-check failed'
            : `build failed: ${firstFailure(built?.output ?? '')}`;
      return { green, types, built, why };
    };

    switch (op) {
      case 'workspace.open': {
        const a = OpenArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        const current = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).output.trim();
        const ref = a.data.ref ?? (AGENT_BRANCH.test(current) ? current : undefined);
        const fetched = ref ? await run('git', [...auth, 'fetch', 'origin', ref]) : null;
        let synced = '';
        if (ref && current !== ref) {
          await run(
            'git',
            fetched?.exitCode === 0
              ? ['checkout', '-B', ref, 'FETCH_HEAD']
              : ['checkout', '-B', ref],
          );
        } else if (fetched?.exitCode === 0 && !a.data.fresh) {
          // Kept from an earlier run: the branch may have moved on GitHub since.
          synced = await catchUp();
        }
        if (a.data.fresh) {
          await run('git', [
            'reset',
            '-q',
            '--hard',
            fetched?.exitCode === 0 ? 'FETCH_HEAD' : 'HEAD',
          ]);
          await run('git', ['clean', '-fdq']);
          await run('rm', ['-rf', `${app}/.next`]);
          synced = 'started fresh from the branch as pushed';
        }
        const { result: installed, lockUpdated } = await install();
        const head = await run('git', ['log', '-1', '--format=%h %s']);
        const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
        const dirty = (await run('git', ['status', '--porcelain'])).output
          .split('\n')
          .map((l) => l.slice(3).trim())
          .filter(Boolean);
        return {
          code: installed && installed.exitCode !== 0 ? 500 : 200,
          body: {
            branch: branch.output.trim(),
            head: head.output.trim(),
            app: facts.appPath,
            uncommitted: dirty,
            install: installed
              ? { exitCode: installed.exitCode, output: installed.output }
              : 'reused',
          },
          summary: `Working copy on ${branch.output.trim()} (${head.output.trim().slice(0, 60)})${synced ? `; ${synced}` : ''}${dirty.length ? `; uncommitted: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''}` : ''}${installed ? `, dependencies ${installed.exitCode === 0 ? 'installed' : `failed to install: ${lastError(installed.output)}`}` : ''}${lockUpdated ? `; ${facts.appPath}/package-lock.json was out of date with package.json and was updated: commit it` : ''}`,
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
        // A file git ignores is never committed: the work would live only in this machine.
        const ignored = (
          await run('git', ['check-ignore', '--', ...a.data.files.map((f) => safePath(f.path)!)])
        ).output
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        if (ignored.length)
          return bad(
            `Not written: git ignores ${ignored.join(', ')}, so it would never be committed. Files under .sitecore/ (other than the component maps) are generated by the build; change the source they come from instead.`,
          );
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
      case 'git.integrate': {
        const a = IntegrateArgs.safeParse(args);
        if (!a.success) return bad(a.error.issues[0]!.message);
        const wanted = [...new Set(a.data.branches)];
        // The working copy is a shallow clone: a merge needs the shared history.
        await run('git', [...auth, 'fetch', '-q', '--unshallow', 'origin']);
        const base = await run('git', [...auth, 'fetch', 'origin', facts.branch]);
        if (base.exitCode !== 0)
          return bad(`Couldn't fetch ${facts.branch}: ${lastError(base.output)}`, 502);
        const branches: string[] = [];
        const missing: string[] = [];
        for (const b of wanted) {
          const got = await run('git', [
            ...auth,
            'fetch',
            'origin',
            `+refs/heads/${b}:refs/remotes/origin/${b}`,
          ]);
          (got.exitCode === 0 ? branches : missing).push(b);
        }
        if (!branches.length)
          return bad(`None of these branches exist: ${missing.join(', ')}`, 404);
        if (!branches.includes(DIRECTOR_BRANCH)) {
          const got = await run('git', [
            ...auth,
            'fetch',
            'origin',
            `+refs/heads/${DIRECTOR_BRANCH}:refs/remotes/origin/${DIRECTOR_BRANCH}`,
          ]);
          if (got.exitCode === 0) branches.push(DIRECTOR_BRANCH);
        }
        // No lock: integrations run side by side, and the push says when another got there first.
        const regenerated = new Set<string>();
        for (let attempt = 1; ; attempt++) {
          const has = await run('git', [...auth, 'fetch', 'origin', INTEGRATION_BRANCH]);
          // What the integration branch was: a rebuild replaces it only if it's still that.
          const lease =
            has.exitCode === 0 ? (await run('git', ['rev-parse', 'FETCH_HEAD'])).output.trim() : '';
          // Start from the integration branch as pushed, or from the default branch the first time
          // (and for a rebuild).
          await run('git', ['reset', '--hard', '-q']);
          await run('git', ['clean', '-fdq', '-e', 'node_modules']);
          const from =
            has.exitCode === 0 && !a.data.fresh ? 'FETCH_HEAD' : `origin/${facts.branch}`;
          const start = await run('git', ['checkout', '-q', '-B', INTEGRATION_BRANCH, from]);
          if (start.exitCode !== 0)
            return bad(`Couldn't start from ${from}: ${lastError(start.output)}`);
          regenerated.clear();
          for (const branch of branches) {
            const merge = await run('git', [
              'merge',
              '--no-ff',
              '--no-edit',
              '-m',
              `Integrate ${branch}`,
              `origin/${branch}`,
            ]);
            if (merge.exitCode === 0) continue;
            const conflicted = (await run('git', ['diff', '--name-only', '--diff-filter=U'])).output
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean);
            const source = conflicted.filter((f) => !GENERATED.test(f));
            if (!conflicted.length || source.length) {
              await run('git', ['merge', '--abort']);
              return {
                code: 409,
                body: {
                  branch,
                  conflicts: source.length ? source : conflicted,
                  output: merge.output,
                },
                summary: source.length
                  ? `${branch} conflicts with ${INTEGRATION_BRANCH} in ${source.join(', ')}: nothing pushed`
                  : `Merging ${branch} failed: ${lastError(merge.output)}`,
              };
            }
            // Generated files: keep the integration branch's for now, generate them after the build.
            await run('git', ['checkout', '--ours', '--', ...conflicted]);
            await run('git', ['add', '--', ...conflicted]);
            const done = await run('git', ['commit', '-q', '--no-edit']);
            if (done.exitCode !== 0)
              return bad(`Couldn't finish merging ${branch}: ${lastError(done.output)}`, 500);
            for (const f of conflicted) regenerated.add(f);
          }
          const { result: installed } = await install();
          if (
            [...regenerated].some((f) => f.endsWith('package-lock.json')) ||
            (installed && installed.exitCode !== 0)
          ) {
            const again = await run('npm', ['install', '--no-audit', '--no-fund'], {
              cwd: app,
              timeoutMs: 15 * 60_000,
            });
            if (again.exitCode !== 0)
              return bad(`Dependencies failed to install: ${lastError(again.output)}`, 500);
          }
          const { green, types, built, why } = await build();
          if (!green) {
            return {
              code: 422,
              body: {
                branches,
                typeCheck: { exitCode: types.exitCode, output: types.exitCode ? types.output : '' },
                build: built ? { exitCode: built.exitCode, output: built.output } : 'skipped',
              },
              summary: `Build red after merging ${branches.join(', ')} (${why}): nothing pushed`,
            };
          }
          // The build regenerates the tracked component maps and the lockfile: keep them with the merge.
          const changed = (await run('git', ['status', '--porcelain'])).output.trim();
          if (changed) {
            await run('git', ['add', '-A']);
            await run('git', ['commit', '-q', '-m', 'Generated files after integrating']);
          }
          const push = await run(
            'git',
            [
              ...auth,
              'push',
              ...(a.data.fresh && lease
                ? [`--force-with-lease=refs/heads/${INTEGRATION_BRANCH}:${lease}`]
                : []),
              'origin',
              `HEAD:refs/heads/${INTEGRATION_BRANCH}`,
            ],
            { timeoutMs: 120_000 },
          );
          if (push.exitCode === 0) break;
          // Every merge went in and the build is green: only the push failed. Say so, so it isn't
          // taken for a merge conflict (409).
          const merged = `All ${branches.length} branches merged with no conflict and built green, but`;
          if (!raced(push.output)) {
            const why = pushRefusal(push.output);
            return {
              code: 403,
              body: { error: push.output, reason: why },
              summary: `${merged} GitHub refused the push to ${INTEGRATION_BRANCH}: ${why}${/workflow/i.test(why) ? ' (the GitHub App needs the Workflows permission to change .github/workflows)' : ''}. Nothing pushed.`,
            };
          }
          // Another component's integration pushed first: start again from what it pushed.
          if (attempt === 3)
            return {
              code: 503,
              body: { error: push.output, reason: pushRefusal(push.output) },
              summary: `${merged} other integrations pushed ${INTEGRATION_BRANCH} while this one built, three times. Nothing pushed: integrate again once they finish.`,
            };
        }
        const sha = (await run('git', ['rev-parse', '--short=7', 'HEAD'])).output.trim();
        const skipped = missing.length ? `; skipped ${missing.join(', ')} (not found)` : '';
        const regen = regenerated.size ? `; regenerated ${[...regenerated].join(', ')}` : '';
        return {
          code: 200,
          body: {
            integrated: branches,
            missing,
            integration: INTEGRATION_BRANCH,
            commit: sha,
            regenerated: [...regenerated],
          },
          summary: `Integrated ${branches.length} branch${branches.length === 1 ? '' : 'es'} into ${INTEGRATION_BRANCH} (${sha}), build green, pushed${skipped}${regen}`,
        };
      }
      case 'exec.build': {
        const { green, types, built, why } = await build();
        // What was built: the commit, and whether anything was uncommitted. Acceptance reads it.
        const dirty = (await run('git', ['status', '--porcelain'])).output.trim();
        const head = (await run('git', ['rev-parse', '--short=7', 'HEAD'])).output.trim();
        return {
          code: 200,
          body: {
            green,
            commit: head,
            uncommitted: dirty ? dirty.split('\n').length : 0,
            typeCheck: { exitCode: types.exitCode, output: types.exitCode ? types.output : '' },
            build: built ? { exitCode: built.exitCode, output: built.output } : 'skipped',
          },
          summary: green
            ? `Build green: type-check and build passed (${dirty ? 'uncommitted changes' : `nothing uncommitted, at ${head}`})`
            : `Build red: ${why}`,
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
        const { branch } = a.data;
        await run('git', ['add', '-A']);
        const staged = await run('git', ['diff', '--cached', '--name-only']);
        const paths = staged.output.split('\n').filter(Boolean);
        const blocked = paths.filter((p) => !safePath(p) || READ_ONLY.test(p));
        if (blocked.length) {
          await run('git', ['reset', '-q']);
          return bad(`Refused: ${blocked.join(', ')} can't be committed from here.`);
        }
        if (paths.length) {
          const c = await run('git', ['commit', '-q', '-m', a.data.message]);
          if (c.exitCode !== 0)
            return { code: 500, body: { error: c.output }, summary: 'Commit failed' };
        } else {
          // Nothing new, but a push that failed earlier leaves its commit here: push that.
          const fetched = await run('git', [...auth, 'fetch', 'origin', branch]);
          if (fetched.exitCode !== 0) return bad('Nothing to commit.');
          if (!(await count('FETCH_HEAD..HEAD'))) {
            if (await count('HEAD..FETCH_HEAD')) return bad('Nothing to commit.');
            // The branch already holds exactly this working copy: say so, with the commit.
            const sha = (await run('git', ['rev-parse', 'HEAD'])).output.trim();
            return {
              code: 200,
              body: { branch, commit: sha, files: 0 },
              summary: `Nothing new to commit: ${branch} already has this working copy (${sha.slice(0, 7)})`,
            };
          }
        }
        const push = () =>
          run('git', [...auth, 'push', 'origin', `HEAD:refs/heads/${branch}`], {
            timeoutMs: 120_000,
          });
        let pushed = await push();
        let replayed = '';
        if (pushed.exitCode !== 0 && raced(pushed.output)) {
          // The branch moved on GitHub (another run, or a commit made with another tool): replay
          // this working copy's commits on top of it and push again.
          const fetched = await run('git', [...auth, 'fetch', 'origin', branch]);
          if (fetched.exitCode === 0) {
            replayed = await catchUp();
            pushed = await push();
          }
        }
        const sha = (await run('git', ['rev-parse', 'HEAD'])).output.trim();
        if (pushed.exitCode !== 0)
          return {
            code: 502,
            body: { error: pushed.output, commit: sha },
            summary: `Push to ${branch} failed (${pushRefusal(pushed.output)}); committed here as ${sha.slice(0, 7)}${replayed ? `, then ${replayed}` : ''}. Call git.commit again to push it`,
          };
        return {
          code: 200,
          body: { branch, commit: sha, files: paths.length },
          summary: paths.length
            ? `Committed ${plural(paths.length, 'file')} to ${branch} (${sha.slice(0, 7)})`
            : `Pushed what an earlier push left behind to ${branch} (${sha.slice(0, 7)})`,
        };
      }
      default:
        return { code: 404, body: { error: `Unknown operation ${op}` } };
    }
  }
}

/** A git header carrying the token for one command, never written to the repository's config. */
/** The line of command output that says what went wrong, for a step's summary. */
/**
 * A push refused only because the branch moved meanwhile: integrating again settles it. Two
 * pushes landing at once come back from GitHub as `[remote rejected] … (cannot lock ref …)`.
 */
const raced = (output: string) =>
  /\[rejected\][^\n]*\((?:fetch first|non-fast-forward|stale info)\)/.test(output) ||
  /\[remote rejected\][^\n]*\((?:cannot lock ref|failed to update ref)/.test(output);

/** Why git refused a push: its `! [rejected] … (reason)` line and what the remote said. */
const pushRefusal = (output: string) => {
  const lines = output.split('\n').map((l) => l.trim());
  const bang = lines.find((l) => /^!\s*\[/.test(l));
  const remote = lines
    .filter((l) => /^remote:\s*\S/.test(l))
    .map((l) => l.replace(/^remote:\s*/, ''))
    .slice(0, 3);
  return [bang, ...remote].filter(Boolean).join(' ') || lastError(output);
};

/** The line that says why a build failed: the page that failed to prerender, else the first error. */
const firstFailure = (output: string) =>
  /Error occurred prerendering page "[^"\n]*"/.exec(output)?.[0] ?? lastError(output);

const lastError = (output: string) =>
  (
    output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /error|ERR!/i.test(l) && l.length > 12)
      .at(0) ?? 'see the output'
  ).slice(0, 200);

export const basic = (token: string) =>
  `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

const bad = (error: string, code = 422): ToolResult => ({ code, body: { error }, summary: error });
