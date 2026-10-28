import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';
import { authorOf, basic, sandboxName, type BoxProvider, type WorkspaceFacts } from './server';

/**
 * The Sitecore CLI, for serialization only: pull the project's own items from its environment
 * into the build repository, and validate them. Never push: a shared collection holds other
 * teams' sites. It runs in a machine of its own where no agent-written code runs, signs in with
 * the environment client only for the command, and checks first that the CLI settings are the
 * starter's and that every module stays inside the paths the project owns.
 */

export interface CliFacts extends WorkspaceFacts {
  cmHost: string;
  /** Item paths the project owns; every module include must sit inside one. */
  ownedPaths: string[];
}

export interface CliServerOptions {
  provider: BoxProvider;
  facts(projectId: string): Promise<CliFacts | null>;
  /** The environment automation client, from the vault. */
  client(projectId: string): Promise<{ clientId: string; clientSecret: string } | null>;
}

const AGENT_BRANCH = /^launchworks\/[A-Za-z0-9._/-]{1,100}$/;
const DOTNET = '/tmp/dotnet';
const MAX_OUTPUT = 6_000;

const PullArgs = z.object({
  branch: z.string().regex(AGENT_BRANCH, 'must start with launchworks/'),
  message: z.string().min(1).max(2000).default('Serialize the project’s items'),
});
const ValidateArgs = z.object({
  branch: z.string().regex(AGENT_BRANCH, 'must start with launchworks/').optional(),
});

/** Is this item path inside one of the owned roots (case-insensitive, as Sitecore paths are)? */
export function within(path: string, roots: string[]): boolean {
  const p = path.toLowerCase().replace(/\/+$/, '');
  return roots.some((r) => {
    const root = r.toLowerCase().replace(/\/+$/, '');
    return p === root || p.startsWith(`${root}/`);
  });
}

/** Every include path in a module file. */
export function moduleIncludes(json: string): string[] {
  const m = JSON.parse(json) as {
    items?: { includes?: { path?: string; rules?: { path?: string }[] }[] };
  };
  return (m.items?.includes ?? []).map((i) => i.path ?? '').filter(Boolean);
}

export class SitecoreCliToolServer implements ToolServer {
  readonly name = 'sitecore-cli';
  readonly catalog: OperationCatalog = {
    'ser.pull': {
      description:
        "Pull the project's own items from its SitecoreAI environment into the build repository's serialization modules (authoring/items), on your agent branch, and commit them. Every module include must sit inside the project's own paths. There is no push: definitions are created through the Authoring API.",
      inputSchema: {
        type: 'object',
        properties: { branch: { type: 'string' }, message: { type: 'string' } },
        required: ['branch'],
        additionalProperties: false,
      },
      mutates: true,
    },
    'ser.validate': {
      description:
        'Validate the serialized items on a branch (default: the default branch) with the Sitecore CLI. Returns its findings.',
      inputSchema: {
        type: 'object',
        properties: { branch: { type: 'string' } },
        additionalProperties: false,
      },
      mutates: false,
    },
  };

  constructor(private readonly opts: CliServerOptions) {}

  target(projectId: string) {
    return `sitecore-cli:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const facts = await this.opts.facts(ctx.projectId);
    if (!facts) return bad('This project has no build repository or SitecoreAI target yet.', 409);
    const client = await this.opts.client(ctx.projectId);
    if (!client)
      return bad('The SitecoreAI environment client is not stored for this project.', 409);
    const a =
      op === 'ser.pull'
        ? PullArgs.safeParse(args)
        : op === 'ser.validate'
          ? ValidateArgs.safeParse(args)
          : null;
    if (!a) return { code: 404, body: { error: `Unknown operation ${op}` } };
    if (!a.success) return bad(a.error.issues[0]!.message);
    const branch = (a.data as { branch?: string }).branch;

    const { box, created } = await this.opts.provider.open(
      `${sandboxName(ctx.projectId, ctx.taskId)}-cli`.slice(0, 63),
      { repoUrl: `https://github.com/${facts.repo}.git`, token: ctx.token },
    );
    const redact = (s: string) =>
      [client.clientSecret, client.clientId, ctx.token].reduce(
        (o, v) => o.split(v).join('[redacted]'),
        s,
      );
    // The machine's own PATH stays (git lives in /opt/git/bin); .NET is called by its full path.
    const env = {
      DOTNET_ROOT: DOTNET,
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    };
    const run = async (
      cmd: string,
      argv: string[],
      o: { timeoutMs?: number; sudo?: boolean } = {},
    ) => {
      const r = await box.run(cmd, argv, { cwd: box.root, env, ...o });
      return { exitCode: r.exitCode, output: redact(r.output).slice(-MAX_OUTPUT) };
    };
    const auth = ['-c', `http.extraHeader=${basic(ctx.token)}`];

    if (created)
      await run('git', ['remote', 'set-url', 'origin', `https://github.com/${facts.repo}.git`]);
    await run('git', [...auth, 'fetch', 'origin', facts.branch]);
    if (branch) {
      const f = await run('git', [...auth, 'fetch', 'origin', branch]);
      await run(
        'git',
        f.exitCode === 0
          ? ['checkout', '-B', branch, 'FETCH_HEAD']
          : ['checkout', '-B', branch, `origin/${facts.branch}`],
      );
    } else {
      await run('git', ['checkout', '-B', facts.branch, `origin/${facts.branch}`]);
    }

    // 1. The CLI's own settings are the starter's: they decide what runs with our credentials.
    const drift = await run('git', [
      'diff',
      '--name-only',
      `origin/${facts.branch}`,
      '--',
      'sitecore.json',
      'nuget.config',
      '.config',
    ]);
    if (drift.output.trim())
      return bad(
        `Refused: ${drift.output.trim().split('\n').join(', ')} differ from the default branch.`,
      );

    // 2. Every module stays inside the project's own paths.
    const found = await run('find', [
      'authoring',
      '-name',
      '*.module.json',
      '-not',
      '-path',
      '*/node_modules/*',
    ]);
    const modules = found.output.split('\n').filter(Boolean);
    const outside: string[] = [];
    for (const m of modules) {
      const buf = await box.read(m);
      if (!buf) continue;
      try {
        for (const p of moduleIncludes(buf.toString('utf8')))
          if (!within(p, facts.ownedPaths)) outside.push(`${m}: ${p}`);
      } catch {
        outside.push(`${m}: not valid JSON`);
      }
    }
    if (outside.length)
      return bad(
        `Refused: module includes outside the project's paths (${outside.slice(0, 5).join('; ')}). Owned: ${facts.ownedPaths.join('; ')}.`,
      );
    if (!modules.length && op === 'ser.pull')
      return bad(
        'No serialization modules (authoring/**/*.module.json) to pull into. Add one for the project first.',
      );

    // 3. The CLI, installed on first use, signed in for this command only.
    const has = await run('test', ['-x', `${DOTNET}/dotnet`]);
    if (has.exitCode !== 0) {
      await run('dnf', ['install', '-y', '-q', 'libicu'], { sudo: true, timeoutMs: 300_000 });
      await run('curl', [
        '-sSL',
        'https://dot.net/v1/dotnet-install.sh',
        '-o',
        '/tmp/dotnet-install.sh',
      ]);
      const inst = await run(
        'bash',
        ['/tmp/dotnet-install.sh', '--channel', '8.0', '--install-dir', DOTNET],
        { timeoutMs: 600_000 },
      );
      if (inst.exitCode !== 0) return fail('installing .NET', inst);
    }
    const restore = await run(`${DOTNET}/dotnet`, ['tool', 'restore'], { timeoutMs: 600_000 });
    if (restore.exitCode !== 0) return fail('restoring the Sitecore CLI', restore);
    try {
      const login = await run(
        `${DOTNET}/dotnet`,
        [
          'sitecore',
          'cloud',
          'login',
          '--client-credentials',
          'true',
          '--client-id',
          client.clientId,
          '--client-secret',
          client.clientSecret,
          '--allow-write',
          'true',
        ],
        { timeoutMs: 180_000 },
      );
      if (login.exitCode !== 0) return fail('signing in', login);
      const connect = await run(
        `${DOTNET}/dotnet`,
        [
          'sitecore',
          'connect',
          '--ref',
          'xmcloud',
          '--cm',
          `https://${facts.cmHost}`,
          '--allow-write',
          'true',
          '-n',
          'default',
        ],
        { timeoutMs: 180_000 },
      );
      if (connect.exitCode !== 0) return fail('connecting to the environment', connect);

      if (op === 'ser.validate') {
        const v = await run(`${DOTNET}/dotnet`, ['sitecore', 'ser', 'validate', '-n', 'default'], {
          timeoutMs: 900_000,
        });
        return {
          code: 200,
          // The end of the output is where the CLI says what is wrong; the start is progress.
          body: { valid: v.exitCode === 0, output: v.output.slice(-6000) },
          summary:
            v.exitCode === 0
              ? `Serialization valid (${modules.length} modules)`
              : `Serialization has problems (exit ${v.exitCode}): ${tail(v.output)}`,
        };
      }

      const pull = await run(`${DOTNET}/dotnet`, ['sitecore', 'ser', 'pull', '-n', 'default'], {
        timeoutMs: 1_800_000,
      });
      if (pull.exitCode !== 0) return fail('pulling items', pull);
      // Only serialized items are committed from here.
      await run('git', ['add', '--', 'authoring']);
      const staged = (await run('git', ['diff', '--cached', '--name-only'])).output
        .split('\n')
        .filter(Boolean);
      if (!staged.length)
        return {
          code: 200,
          body: { changed: 0, output: pull.output },
          summary: 'Pulled: nothing changed',
        };
      await run('git', [
        '-c',
        `user.name=${authorOf(facts).name}`,
        '-c',
        `user.email=${authorOf(facts).email}`,
        'commit',
        '-q',
        '-m',
        (a.data as { message: string }).message,
      ]);
      const push = await run('git', [...auth, 'push', 'origin', `HEAD:refs/heads/${branch}`], {
        timeoutMs: 120_000,
      });
      if (push.exitCode !== 0) return fail(`pushing to ${branch}`, push);
      const sha = (await run('git', ['rev-parse', 'HEAD'])).output.trim();
      return {
        code: 200,
        body: { changed: staged.length, commit: sha, branch },
        summary: `Pulled ${staged.length} item file${staged.length === 1 ? '' : 's'} into ${branch} (${sha.slice(0, 7)})`,
      };
    } finally {
      // The CLI's token never outlives the command.
      await run('rm', ['-f', '.sitecore/user.json']);
    }
  }
}

/** The last few lines a command printed, in one line: enough to say why it failed. */
const tail = (output: string) =>
  output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ')
    .slice(-400) || 'no output';

const bad = (error: string, code = 422): ToolResult => ({ code, body: { error }, summary: error });
const fail = (doing: string, r: { exitCode: number; output: string }): ToolResult => ({
  code: 500,
  body: { error: `The Sitecore CLI failed ${doing} (exit ${r.exitCode}).`, output: r.output },
  summary: `Sitecore CLI failed ${doing}`,
});
