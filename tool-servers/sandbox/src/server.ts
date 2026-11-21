import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';
import { AGENT_BRANCH, INTEGRATION_BRANCH, rejected } from '@lw/tool-gateway';
import { authFlags, SCRUB } from './git-hygiene';

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
  /**
   * How the head builds, from the project's platform pack: scripts that generate files the
   * type-check needs (run when the app has them), the build script, and paths agents may not
   * write. Without one, SitecoreAI's starter recipe.
   */
  recipe?: BuildRecipe;
  /**
   * Optimizely only: the prefix the project's content types and display templates carry.
   * exec.optimizely-cli pushes nothing without it: the instance's content model is shared.
   */
  typePrefix?: string;
}

export interface BuildRecipe {
  generate: string[];
  build: string;
  readOnly: string[];
}

/** The SitecoreAI starter's recipe: the default for projects whose facts name none. */
export const SITECORE_RECIPE: BuildRecipe = {
  generate: ['sitecore-tools:generate-map', 'sitecore-tools:build'],
  build: 'next:build',
  readOnly: ['sitecore.json', 'nuget.config'],
};

const PLACEHOLDER_AUTHOR = { name: 'Launchworks', email: 'agents@launchworks.invalid' };
export const authorOf = (facts: WorkspaceFacts) => facts.author ?? PLACEHOLDER_AUTHOR;

export interface SandboxServerOptions {
  provider: BoxProvider;
  facts(projectId: string): Promise<WorkspaceFacts | null>;
  /** Variables the build needs (site, Context ID). Their values are redacted from output. */
  buildEnv(projectId: string): Promise<Record<string, string>>;
}

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
const ALWAYS_READ_ONLY = ['.github/', '.config/'];
/** A path agents may not write, given the platform's own read-only files. */
export const readOnly = (path: string, recipe: BuildRecipe) =>
  [...ALWAYS_READ_ONLY, ...recipe.readOnly].some((p) =>
    p.endsWith('/') ? path.startsWith(p) : path === p,
  );

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
const ListArgs = z.object({
  ref: z.string().regex(AGENT_BRANCH, 'an agent branch, launchworks/…').optional(),
  path: z.string().max(300).optional(),
});
const ReadArgs = z.object({
  ref: z.string().regex(AGENT_BRANCH, 'an agent branch, launchworks/…').optional(),
  paths: z.preprocess(
    (v) => (typeof v === 'string' ? [v] : v),
    z.array(z.string().min(1).max(300)).min(1).max(20),
  ),
});
/**
 * Models sometimes send the file list as JSON text, or one file as a bare object: read either as
 * the list it means rather than refusing the write (Paylocity: 19 refusals of "expected array").
 */
const asList = (v: unknown) => {
  let x = v;
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x);
    } catch {
      return v;
    }
  }
  return x && typeof x === 'object' && !Array.isArray(x) ? [x] : x;
};

const WriteArgs = z.object({
  files: z.preprocess(
    asList,
    z
      .array(
        z
          .object({
            path: z.string().min(1).max(300),
            /** UTF-8 text; null deletes the file. */
            content: z.string().max(MAX_FILE).nullable().optional(),
            /** Targeted changes to the file as it stands: each `old` occurs exactly once. */
            edits: z
              .array(z.object({ old: z.string().min(1), new: z.string() }))
              .min(1)
              .max(50)
              .optional(),
          })
          .refine((f) => (f.content !== undefined) !== (f.edits !== undefined), {
            message: 'give each file either content (null deletes it) or edits, not both',
          }),
      )
      .min(1)
      .max(50),
  ),
});
const OptimizelyCliArgs = z.object({
  /** `push-dry-run` validates the content model and sends nothing; `push` sends it to the CMS. */
  command: z.enum(['push-dry-run', 'push']),
});
/** Where the dry run writes the manifest, read back and removed: never committed. */
const OPTIMIZELY_MANIFEST = '.optimizely-manifest.json';
const CliArgs = z.object({
  command: z.enum(['generate-map', 'scaffold']),
  /** For scaffold: the component name, PascalCase. */
  name: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]{1,60}$/, 'PascalCase')
    .optional(),
});
/**
 * The Director's own fixes, made outside any task. Every integration merges it when it exists,
 * a rebuild included, so hand fixes never drop out; agents don't commit to it.
 */
export const DIRECTOR_BRANCH = 'launchworks/director';
/** The design system task's branch: tokens and the shared ui/ files every component uses. */
export const DESIGN_SYSTEM_BRANCH = 'launchworks/design-system';
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
      description: `Open this task's working copy of the build repository, on your agent branch (launchworks/…; if new, created from the design system's branch, ${DESIGN_SYSTEM_BRANCH}, once that exists, else from the default branch), and install dependencies. Call it first; it is reused for the rest of the task. A working copy kept from an earlier run is brought up to date with the branch on GitHub, and the summary names any uncommitted files it holds. \`fresh: true\` discards everything uncommitted and starts again from the branch as pushed: use it when the build fails in files you never changed. Commit before you finish: an unused working copy expires after 45 minutes.`,
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' }, fresh: { type: 'boolean' } },
        additionalProperties: false,
      },
      mutates: false,
    },
    'fs.list': {
      description:
        'List files in the working copy (without node_modules and .git), optionally under `path`. With `ref`, list what another agent branch has on GitHub instead.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string' }, path: { type: 'string' } },
        additionalProperties: false,
      },
      mutates: false,
      untrusted: true,
    },
    'fs.read': {
      description: `Read up to 20 files from the working copy, by repository-relative path. With \`ref\`, read them as another agent branch has them on GitHub instead (${INTEGRATION_BRANCH} for the shared ui/ files as integrated, ${DESIGN_SYSTEM_BRANCH} for the design system), without changing the working copy.`,
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          paths: { type: 'array', items: { type: 'string' } },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      mutates: false,
      untrusted: true,
    },
    'fs.write': {
      description:
        "Write up to 50 files in the working copy: content writes the whole file (UTF-8 text; null deletes it), edits changes only the given parts of an existing file. Prefer edits for a file that holds accepted work (a shared component with many variants): rewriting it whole from memory drops what you did not retype. A component's main file is never deleted: edit it. CI, dependency-tool and Sitecore CLI settings (.github, .config, nuget.config, sitecore.json) stay as the starter has them.",
      inputSchema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: ['string', 'null'] },
                edits: {
                  type: 'array',
                  description:
                    'Change part of an existing file instead of writing it whole: each old text must occur exactly once in the file as it stands, and is replaced by new.',
                  items: {
                    type: 'object',
                    properties: { old: { type: 'string' }, new: { type: 'string' } },
                    required: ['old', 'new'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['path'],
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
    'exec.optimizely-cli': {
      description:
        "Run Optimizely's CLI on the app's content model (optimizely.config.mjs). `push-dry-run` builds the manifest and sends nothing: it lists the content types and display templates the repository defines. `push` sends them to the CMS, additively and never with --force; it refuses a model with any key outside the project's prefix, because content types are shared by every application on the instance.",
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string', enum: ['push-dry-run', 'push'] } },
        required: ['command'],
        additionalProperties: false,
      },
      mutates: true,
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
      return rejected(
        'This project has no build repository yet. Create it in Settings first.',
        409,
      );
    }
    const { box, created } = await this.opts.provider.open(sandboxName(ctx.projectId, ctx.taskId), {
      repoUrl: `https://github.com/${facts.repo}.git`,
      token: ctx.token,
    });
    // Resolved once per call: the build runs with the values its output is redacted for.
    const buildEnv = await this.opts.buildEnv(ctx.projectId);
    const secrets = Object.values(buildEnv).filter((v) => v.length >= 6);
    const redact = (s: string) =>
      [...secrets, ctx.token].reduce((out, v) => out.split(v).join('[redacted]'), s);
    const app = `${box.root}/${facts.appPath}`;
    const recipe = facts.recipe ?? SITECORE_RECIPE;
    const run = async (
      cmd: string,
      a: string[],
      o: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
    ) => {
      // A command that carries the token first clears anything a build planted in .git.
      if (cmd === 'git' && a.some((x) => x.startsWith('http.extraHeader=')))
        await box.run('sh', ['-c', SCRUB, 'scrub', `https://github.com/${facts.repo}.git`], {
          cwd: box.root,
        });
      const r = await box.run(cmd, a, { cwd: box.root, ...o });
      return { exitCode: r.exitCode, output: redact(r.output).slice(-MAX_OUTPUT) };
    };
    if (created) {
      // The clone's credentials don't stay in the machine.
      await run('git', ['remote', 'set-url', 'origin', `https://github.com/${facts.repo}.git`]);
    }
    // Set before every operation that can commit, so a working copy made before the author was
    // known commits as it now. Reads and builds make no commits and skip it.
    const setIdentity = async () => {
      await run('git', ['config', 'user.name', authorOf(facts).name]);
      await run('git', ['config', 'user.email', authorOf(facts).email]);
    };
    const auth = authFlags(basic(ctx.token));

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
      const env = { ...buildEnv, CI: '1' };
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
      // The recipe's staged build applies when the app has every script it names; an older
      // starter with a plain `build` builds that way.
      const staged =
        recipe.generate.length > 0 && [...recipe.generate, recipe.build].every((x) => has.has(x));
      let generated: { exitCode: number; output: string } | null = null;
      if (staged) {
        for (const script of recipe.generate) {
          generated = await npm(script, 10);
          if (generated.exitCode !== 0) break;
        }
      }
      // A starter without a type-check script (Optimizely's scaffold has none) is checked by its
      // build alone, which type-checks too: a missing script is not a red build.
      const types =
        generated && generated.exitCode !== 0
          ? { exitCode: generated.exitCode, output: generated.output }
          : has.has('type-check')
            ? await npm('type-check', 10)
            : { exitCode: 0, output: '' };
      // Every build reads the content as it is now. A page fetched by an earlier build in this
      // working copy (before it had a layout, or while it was being edited) otherwise fails every
      // later build, for nothing the branch changed.
      if (types.exitCode === 0) await run('rm', ['-rf', `${app}/.next/cache/fetch-cache`]);
      const built =
        types.exitCode === 0
          ? await npm(staged || has.has(recipe.build) ? recipe.build : 'build', 20)
          : null;
      const green = types.exitCode === 0 && built?.exitCode === 0;
      const why =
        generated && generated.exitCode
          ? `${recipe.generate.join(' then ')} failed`
          : types.exitCode
            ? 'type-check failed'
            : `build failed: ${firstFailure(built?.output ?? '')}`;
      return { green, types, built, why, typeChecked: has.has('type-check') };
    };

    switch (op) {
      case 'workspace.open': {
        await setIdentity();
        const a = OpenArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
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
        // New work starts from the accepted design system when there is one, not from the bare
        // starter: every component then has the tokens and the shared ui/ files as accepted,
        // byte for byte, without reading another branch. Only a working copy with nothing of
        // its own yet: a branch just made here, or a machine just cloned.
        const isNew = ref ? current !== ref && fetched?.exitCode !== 0 : created;
        if (isNew && ref !== DESIGN_SYSTEM_BRANCH) {
          const shared = await run('git', [...auth, 'fetch', 'origin', DESIGN_SYSTEM_BRANCH]);
          if (shared.exitCode === 0) {
            await run('git', ['reset', '-q', '--hard', 'FETCH_HEAD']);
            synced = `started from ${DESIGN_SYSTEM_BRANCH}`;
          }
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
        if (!a.success) return rejected(a.error.issues[0]!.message);
        const under = a.data.path ? safePath(a.data.path) : '.';
        if (!under) return rejected(`${a.data.path} is outside the repository.`);
        if (a.data.ref) {
          const ref = a.data.ref;
          const fetched = await run('git', [...auth, 'fetch', 'origin', ref]);
          if (fetched.exitCode !== 0)
            return { code: 404, body: { ref }, summary: `No branch ${ref} on GitHub yet` };
          const tree = await run('git', [
            'ls-tree',
            '-r',
            '--name-only',
            'FETCH_HEAD',
            '--',
            under,
          ]);
          const files = tree.output.split('\n').filter(Boolean).slice(0, 3000);
          return {
            code: tree.exitCode === 0 ? 200 : 404,
            body: { ref, files },
            summary: `${files.length} files on ${ref}${a.data.path ? ` under ${a.data.path}` : ''}`,
          };
        }
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
        if (!a.success) return rejected(a.error.issues[0]!.message);
        if (a.data.ref) {
          const ref = a.data.ref;
          const fetched = await run('git', [...auth, 'fetch', 'origin', ref]);
          if (fetched.exitCode !== 0)
            return { code: 404, body: { ref }, summary: `No branch ${ref} on GitHub yet` };
          // One at a time: each reads the same fetched commit.
          const at = [];
          for (const p of a.data.paths) {
            const path = safePath(p);
            if (!path) at.push({ path: p, error: 'not readable' });
            else {
              const shown = await run('git', ['show', `FETCH_HEAD:${path}`]);
              at.push(
                shown.exitCode !== 0
                  ? { path, error: 'not found' }
                  : shown.output.length > MAX_FILE
                    ? { path, error: `too large (${shown.output.length} bytes)` }
                    : { path, content: redact(shown.output) },
              );
            }
          }
          return {
            code: 200,
            body: { ref, files: at },
            summary: `Read ${at.filter((f) => 'content' in f).length} of ${at.length} files as ${ref} has them`,
          };
        }
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
        if (!a.success) return rejected(a.error.issues[0]!.message);
        const refused = a.data.files.filter((f) => {
          const path = safePath(f.path);
          return !path || readOnly(path, recipe);
        });
        if (refused.length)
          return rejected(`Not writable: ${refused.map((f) => f.path).join(', ')}.`);
        // A file git ignores is never committed: the work would live only in this machine.
        const ignored = (
          await run('git', ['check-ignore', '--', ...a.data.files.map((f) => safePath(f.path)!)])
        ).output
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        if (ignored.length)
          return rejected(
            `Not written: git ignores ${ignored.join(', ')}, so it would never be committed. The build generates such files (.sitecore/ other than the component maps; an Optimizely head's registry.generated.ts, from the component folders); change the source they come from instead.`,
          );
        // A component's main file holds every variant the Lead accepted; deleted and rewritten
        // from memory, it lost them (Cabot's Callout, Rich Text and Hero Carousel, round after
        // round). It is edited, never deleted.
        const mainFiles = a.data.files
          .filter((f) => f.content === null && isComponentMain(safePath(f.path)!))
          .map((f) => f.path);
        if (mainFiles.length)
          return rejected(
            `Not deleted: ${mainFiles.join(', ')} is a component's main file, which holds its accepted variants. Change it with edits (or write it whole), never delete it.`,
          );
        // Targeted edits, applied to the file as it stands: all or nothing.
        const edited: { path: string; content: string }[] = [];
        for (const f of a.data.files.filter((x) => x.edits)) {
          const path = safePath(f.path)!;
          const buf = await box.read(path);
          if (!buf)
            return rejected(`Not written: ${f.path} doesn't exist; give its content instead.`);
          let text = buf.toString('utf8');
          for (const [i, e] of f.edits!.entries()) {
            const at = text.indexOf(e.old);
            if (at < 0 || text.indexOf(e.old, at + 1) >= 0)
              return rejected(
                `Nothing written: edit ${i + 1} of ${f.path} ${at < 0 ? "doesn't match the file as it stands" : 'matches more than once'}. Read the file and copy old exactly, with enough context to be unique.`,
              );
            text = text.slice(0, at) + e.new + text.slice(at + e.old.length);
          }
          edited.push({ path, content: text });
        }
        const writes = [
          ...a.data.files
            .filter((f) => typeof f.content === 'string')
            .map((f) => ({ path: safePath(f.path)!, content: f.content! })),
          ...edited,
        ];
        if (writes.length) await box.write(writes);
        const deletes = a.data.files
          .filter((f) => f.content === null)
          .map((f) => safePath(f.path)!);
        if (deletes.length) await run('rm', ['-f', '--', ...deletes]);
        return {
          code: 200,
          body: { written: writes.length, deleted: deletes.length },
          summary: `Wrote ${writes.length}${edited.length ? ` (${edited.length} by edits)` : ''} and deleted ${deletes.length} file${a.data.files.length === 1 ? '' : 's'}`,
        };
      }
      case 'git.integrate': {
        await setIdentity();
        const a = IntegrateArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        const wanted = [...new Set(a.data.branches)];
        // The working copy is a shallow clone: a merge needs the shared history.
        await run('git', [...auth, 'fetch', '-q', '--unshallow', 'origin']);
        const base = await run('git', [...auth, 'fetch', 'origin', facts.branch]);
        if (base.exitCode !== 0)
          return rejected(`Couldn't fetch ${facts.branch}: ${lastError(base.output)}`, 502);
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
          return rejected(`None of these branches exist: ${missing.join(', ')}`, 404);
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
            return rejected(`Couldn't start from ${from}: ${lastError(start.output)}`);
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
              return rejected(`Couldn't finish merging ${branch}: ${lastError(done.output)}`, 500);
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
              return rejected(`Dependencies failed to install: ${lastError(again.output)}`, 500);
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
        const { green, types, built, why, typeChecked } = await build();
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
            ? `Build green: ${typeChecked ? 'type-check and build' : 'build'} passed (${dirty ? 'uncommitted changes' : `nothing uncommitted, at ${head}`})`
            : `Build red: ${why}`,
        };
      }
      case 'exec.optimizely-cli': {
        const a = OptimizelyCliArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        const prefix = facts.typePrefix;
        if (!prefix) return rejected('This project has no Optimizely content type prefix.');
        const cli = (extra: string[]) =>
          run(
            'npx',
            [
              '--no-install',
              'optimizely-cms-cli',
              'config',
              'push',
              'optimizely.config.mjs',
              ...extra,
            ],
            { cwd: app, env: buildEnv, timeoutMs: 5 * 60_000 },
          );
        // Always a dry run first: what the repository defines, before anything is sent.
        const dry = await cli(['--dryRun', '--output', OPTIMIZELY_MANIFEST]);
        const written = await box.read(`${facts.appPath}/${OPTIMIZELY_MANIFEST}`);
        await run('rm', ['-f', OPTIMIZELY_MANIFEST], { cwd: app });
        if (dry.exitCode !== 0 || !written)
          return {
            code: 500,
            body: { exitCode: dry.exitCode, output: dry.output },
            summary: `optimizely-cms-cli config push --dryRun: ${dry.exitCode === 0 ? 'wrote no manifest' : `exit ${dry.exitCode}`}`,
          };
        let manifest: Record<string, { key?: string }[] | undefined>;
        try {
          manifest = JSON.parse(written.toString('utf8')) as typeof manifest;
        } catch {
          return {
            code: 500,
            body: { output: dry.output },
            summary: 'The CLI wrote a manifest that is not JSON',
          };
        }
        const keys = (list: string) => (manifest[list] ?? []).map((x) => String(x.key ?? ''));
        const contentTypes = keys('contentTypes');
        const displayTemplates = keys('displayTemplates');
        const propertyGroups = keys('propertyGroups');
        const foreign = [...contentTypes, ...displayTemplates].filter((k) => !k.startsWith(prefix));
        if (foreign.length)
          return rejected(
            `These keys don't start with the project's prefix ${prefix}: ${foreign.join(', ')}. Content types and display templates are shared by every application on the instance; rename them (${prefix}Hero, ${prefix}HeroDefault).`,
          );
        if (propertyGroups.length)
          return rejected(
            `optimizely.config.mjs defines property groups (${propertyGroups.join(', ')}). They are instance-wide and have no prefix: leave them out and order properties with sortOrder.`,
          );
        if (!contentTypes.length)
          return rejected(
            'The content model is empty: optimizely.config.mjs found no content types. Check its components glob matches the *.model.ts files.',
          );
        // What the CMS refuses and the CLI's dry run lets through, said here in the model's words.
        const faults = modelFaults(manifest);
        if (faults.length) return rejected(faults.join(' '));
        const found = { contentTypes, displayTemplates };
        if (a.data.command === 'push-dry-run')
          return {
            code: 200,
            body: { ...found, sent: false },
            summary: `Content model valid: ${contentTypes.length} content types, ${displayTemplates.length} display templates (dry run, nothing sent)`,
          };
        // Scoped to the keys just checked: a scoped push leaves locales and applications alone.
        const pushed = await cli(['--only', [...contentTypes, ...displayTemplates].join(',')]);
        return {
          code: pushed.exitCode === 0 ? 200 : 500,
          body: {
            ...found,
            sent: pushed.exitCode === 0,
            exitCode: pushed.exitCode,
            output: pushed.output,
          },
          summary:
            pushed.exitCode === 0
              ? `Pushed ${contentTypes.length} content types and ${displayTemplates.length} display templates to the CMS`
              : `The CMS refused the push: ${pushFailure(pushed.output)}`,
        };
      }
      case 'exec.content-sdk-cli': {
        const a = CliArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        if (a.data.command === 'scaffold' && !a.data.name)
          return rejected('scaffold needs a name.');
        const cliArgs =
          a.data.command === 'generate-map'
            ? ['project', 'component', 'generate-map']
            : ['project', 'component', 'scaffold', a.data.name!];
        const r = await run('npx', ['--no-install', 'sitecore-tools', ...cliArgs], {
          cwd: app,
          env: buildEnv,
          timeoutMs: 5 * 60_000,
        });
        return {
          code: r.exitCode === 0 ? 200 : 500,
          body: { exitCode: r.exitCode, output: r.output },
          summary: `sitecore-tools ${cliArgs.slice(1).join(' ')}: ${r.exitCode === 0 ? 'done' : `exit ${r.exitCode}`}`,
        };
      }
      case 'git.commit': {
        await setIdentity();
        const a = CommitArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        const { branch } = a.data;
        await run('git', ['add', '-A']);
        const staged = await run('git', ['diff', '--cached', '--name-only']);
        const paths = staged.output.split('\n').filter(Boolean);
        const blocked = paths.filter((p) => !safePath(p) || readOnly(p, recipe));
        if (blocked.length) {
          await run('git', ['reset', '-q']);
          return rejected(`Refused: ${blocked.join(', ')} can't be committed from here.`);
        }
        if (paths.length) {
          const c = await run('git', ['commit', '-q', '-m', a.data.message]);
          if (c.exitCode !== 0)
            return { code: 500, body: { error: c.output }, summary: 'Commit failed' };
        } else {
          // Nothing new, but a push that failed earlier leaves its commit here: push that.
          const fetched = await run('git', [...auth, 'fetch', 'origin', branch]);
          if (fetched.exitCode !== 0) return rejected('Nothing to commit.');
          if (!(await count('FETCH_HEAD..HEAD'))) {
            if (await count('HEAD..FETCH_HEAD')) return rejected('Nothing to commit.');
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

const named = (keys: string[], most = 4) =>
  `${keys.slice(0, most).join(', ')}${keys.length > most ? ` and ${keys.length - most} more` : ''}`;

/**
 * What the CMS refuses in a content model that the CLI's dry run lets through, each said so the
 * model files can be put right: the SDK's types don't catch a misnamed property option, and the
 * CMS answers a push with the first one only.
 */
export function modelFaults(manifest: unknown): string[] {
  const m = (manifest ?? {}) as {
    contentTypes?: { key?: string; properties?: Record<string, unknown> }[];
    displayTemplates?: { key?: string; settings?: Record<string, { choices?: object }> }[];
  };
  const misnamed: string[] = [];
  for (const t of m.contentTypes ?? [])
    for (const [name, property] of Object.entries(t.properties ?? {})) {
      const p = (property ?? {}) as Record<string, unknown>;
      const items = (p.items ?? {}) as Record<string, unknown>;
      if (['required', 'localized'].some((f) => f in p || f in items))
        misnamed.push(`${t.key}.${name}`);
    }
  const short: string[] = [];
  for (const t of m.displayTemplates ?? [])
    for (const [name, setting] of Object.entries(t.settings ?? {}))
      for (const choice of Object.keys(setting?.choices ?? {}))
        if (choice.length < 2) short.push(`${t.key}.${name} "${choice}"`);
  return [
    ...(misnamed.length
      ? [
          `${misnamed.length === 1 ? 'A property uses' : `${misnamed.length} properties use`} \`required\` or \`localized\` (${named(misnamed)}). The CMS calls them \`isRequired\` and \`isLocalized\` and refuses the whole push otherwise: rename them in the *.model.ts files.`,
        ]
      : []),
    ...(short.length
      ? [
          `A display setting's choice key needs at least two characters (${named(short)}): rename it (\`cols3\` for \`3\`) and read the new key in the component.`,
        ]
      : []),
  ];
}

/** Why the CMS refused a push, from the CLI's output: its error lines, without colours or labels. */
export function pushFailure(output: string): string {
  const lines = output
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const at = lines.findIndex((l) => /^Error \d+:|^Errors:$/.test(l));
  const said = (at < 0 ? lines.slice(-3) : lines.slice(at))
    .filter((l) => !/^Errors:$|^- ERROR \d+$/.test(l))
    .map((l) => l.replace(/^\[(DETAIL|FIELD)\]\s*/, '').replace(/^- /, ''))
    .join(' ');
  const imported = lines
    .filter((l) => /Successfully imported/.test(l))
    .map((l) => l.replace(/^- /, ''));
  return `${said || 'the CLI gave no reason'}${imported.length ? ` What it did take: ${imported.join(' ')}` : ''}`.slice(
    0,
    340,
  );
}

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

/**
 * A component's main file: the file in a component's folder named for the folder
 * (components/hero-carousel/HeroCarousel.tsx, components/callout/Callout.tsx), its module CSS too.
 */
export function isComponentMain(path: string): boolean {
  const m =
    /(?:^|\/)components\/(?:[^/]+\/)*([^/]+)\/([^/]+?)(?:\.module)?\.(?:tsx|jsx|ts|js|css|scss)$/i.exec(
      path,
    );
  if (!m) return false;
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(m[1]!) === norm(m[2]!);
}
