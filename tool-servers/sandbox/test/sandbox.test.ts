import { describe, expect, it } from 'vitest';
import {
  moduleIncludes,
  safePath,
  SandboxToolServer,
  SitecoreCliToolServer,
  within,
  type Box,
  type BoxProvider,
} from '../src';

/** A machine that keeps files in memory and answers the commands the servers run. */
function fakeBox(
  files: Record<string, string> = {},
  answers: (cmd: string, args: string[]) => { exitCode: number; output: string } | null = () =>
    null,
) {
  const runs: { cmd: string; args: string[]; env?: Record<string, string> }[] = [];
  const box: Box = {
    root: '/vercel/sandbox',
    async run(cmd, args, opts = {}) {
      runs.push({ cmd, args, env: opts.env });
      return answers(cmd, args) ?? { exitCode: 0, output: '' };
    },
    async read(path) {
      return path in files ? Buffer.from(files[path]!) : null;
    },
    async write(list) {
      for (const f of list) files[f.path] = f.content;
    },
  };
  const provider: BoxProvider = { open: async () => ({ box, created: false }) };
  return { box, provider, runs, files };
}

const ctx = {
  projectId: 'p1',
  token: 'ghs_secrettoken',
  role: 'component-engineer',
  taskId: 'port-hero',
};
const facts = async () => ({
  repo: 'icreon-launchworks/acme',
  branch: 'main',
  appPath: 'examples/basic-nextjs',
});

describe('working copies', () => {
  it('integrates branches: merges each, skips missing ones, builds once, pushes', async () => {
    const fake = fakeBox(
      {
        'examples/basic-nextjs/node_modules/.package-lock.json': '{}',
        'examples/basic-nextjs/package.json': JSON.stringify({ scripts: { 'next:build': 'x' } }),
      },
      (cmd, args) =>
        cmd === 'git' && args[0] === 'rev-parse'
          ? { exitCode: 0, output: 'abc1234\n' }
          : cmd === 'git' && /port-gone|launchworks\/director/.test(args.at(-1) ?? '')
            ? { exitCode: 128, output: "fatal: couldn't find remote ref" }
            : null,
    );
    const s = new SandboxToolServer({ provider: fake.provider, facts, buildEnv: async () => ({}) });
    const r = await s.call(
      'git.integrate',
      { branches: ['launchworks/port-hero', 'launchworks/port-gone', 'launchworks/port-card'] },
      ctx,
    );
    expect(r).toMatchObject({
      code: 200,
      body: {
        commit: 'abc1234',
        integrated: ['launchworks/port-hero', 'launchworks/port-card'],
        missing: ['launchworks/port-gone'],
        regenerated: [],
      },
    });
    const git = fake.runs
      .filter((x) => x.cmd === 'git')
      .map((x) => x.args.filter((a) => !a.startsWith('http.extraHeader') && a !== '-c').join(' '));
    expect(git.filter((g) => g.startsWith('merge'))).toEqual([
      'merge --no-ff --no-edit -m Integrate launchworks/port-hero origin/launchworks/port-hero',
      'merge --no-ff --no-edit -m Integrate launchworks/port-card origin/launchworks/port-card',
    ]);
    expect(git.at(-2)).toBe('push origin HEAD:refs/heads/launchworks/integration');
    expect(fake.runs.filter((x) => x.cmd === 'npm' && x.args.includes('type-check'))).toHaveLength(
      1,
    );
    expect(
      await s.call('git.integrate', { branches: ['launchworks/integration'] }, ctx),
    ).toMatchObject({ code: 422 });
  });

  it('rebuilds the integration branch from the default branch, leaving out unlisted branches', async () => {
    const fake = fakeBox(
      { 'examples/basic-nextjs/node_modules/.package-lock.json': '{}' },
      (cmd, args) =>
        cmd === 'git' && args[0] === 'rev-parse' ? { exitCode: 0, output: 'def5678\n' } : null,
    );
    const s = new SandboxToolServer({ provider: fake.provider, facts, buildEnv: async () => ({}) });
    const r = await s.call(
      'git.integrate',
      { branches: ['launchworks/port-hero'], fresh: true },
      ctx,
    );
    expect(r.code).toBe(200);
    const git = fake.runs
      .filter((x) => x.cmd === 'git')
      .map((x) => x.args.filter((a) => !a.startsWith('http.extraHeader') && a !== '-c').join(' '));
    expect(git).toContain('checkout -q -B launchworks/integration origin/main');
    // A rebuild keeps the Director's own fixes.
    expect(git.filter((x) => x.startsWith('merge ')).at(-1)).toContain(
      'origin/launchworks/director',
    );
    expect(git).toContain(
      'push --force-with-lease=refs/heads/launchworks/integration:def5678 origin HEAD:refs/heads/launchworks/integration',
    );
  });

  it('starts again from what another integration pushed', async () => {
    let pushes = 0;
    const fake = fakeBox(
      { 'examples/basic-nextjs/node_modules/.package-lock.json': '{}' },
      (cmd, args) =>
        cmd === 'git' && args.includes('push')
          ? ++pushes === 1
            ? { exitCode: 1, output: ' ! [rejected] HEAD -> launchworks/integration (fetch first)' }
            : { exitCode: 0, output: '' }
          : null,
    );
    const s = new SandboxToolServer({ provider: fake.provider, facts, buildEnv: async () => ({}) });
    const r = await s.call('git.integrate', { branches: ['launchworks/port-hero'] }, ctx);
    expect(r.code).toBe(200);
    expect(pushes).toBe(2);
    // The branch and the Director's fixes, on each of the two attempts.
    expect(fake.runs.filter((x) => x.args[0] === 'merge')).toHaveLength(4);
  });

  it("says a refused push isn't a merge conflict, and why GitHub refused it", async () => {
    const refused = fakeBox(
      { 'examples/basic-nextjs/node_modules/.package-lock.json': '{}' },
      (cmd, args) =>
        cmd === 'git' && args.includes('push')
          ? {
              exitCode: 1,
              output: [
                ' ! [remote rejected] HEAD -> launchworks/integration (refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission)',
                "error: failed to push some refs to 'https://github.com/icreon-launchworks/ansco'",
              ].join('\n'),
            }
          : null,
    );
    const s = new SandboxToolServer({
      provider: refused.provider,
      facts,
      buildEnv: async () => ({}),
    });
    const r = await s.call(
      'git.integrate',
      { branches: ['launchworks/port-hero'], fresh: true },
      ctx,
    );
    expect(r.code).toBe(403);
    // The branch and the Director's fixes.
    expect(r.summary).toContain('All 2 branches merged with no conflict and built green');
    expect(r.summary).toContain('without `workflows` permission');
    expect(r.summary).toContain('needs the Workflows permission');
    // Refused, not raced: no second rebuild.
    expect(refused.runs.filter((x) => x.args.includes('push'))).toHaveLength(1);

    const busy = fakeBox(
      { 'examples/basic-nextjs/node_modules/.package-lock.json': '{}' },
      (cmd, args) =>
        cmd === 'git' && args.includes('push')
          ? { exitCode: 1, output: ' ! [rejected] HEAD -> launchworks/integration (stale info)' }
          : null,
    );
    const s2 = new SandboxToolServer({
      provider: busy.provider,
      facts,
      buildEnv: async () => ({}),
    });
    const r2 = await s2.call(
      'git.integrate',
      { branches: ['launchworks/port-hero'], fresh: true },
      ctx,
    );
    expect(r2.code).toBe(503);
    expect(r2.summary).toContain('integrate again once they finish');
    expect(busy.runs.filter((x) => x.args.includes('push'))).toHaveLength(3);
  });

  it('stops on a source conflict, and regenerates a conflicted component map', async () => {
    const conflict = (files: string) =>
      fakeBox({ 'examples/basic-nextjs/node_modules/.package-lock.json': '{}' }, (cmd, args) =>
        cmd === 'git' && args[0] === 'merge' && args[1] !== '--abort'
          ? { exitCode: 1, output: 'CONFLICT' }
          : cmd === 'git' && args[0] === 'diff'
            ? { exitCode: 0, output: files }
            : null,
      );
    const src = conflict('examples/basic-nextjs/src/Layout.tsx\n');
    const s1 = new SandboxToolServer({ provider: src.provider, facts, buildEnv: async () => ({}) });
    const r1 = await s1.call('git.integrate', { branches: ['launchworks/port-hero'] }, ctx);
    expect(r1).toMatchObject({
      code: 409,
      body: { conflicts: ['examples/basic-nextjs/src/Layout.tsx'] },
    });
    expect(src.runs.some((x) => x.args.join(' ') === 'merge --abort')).toBe(true);
    expect(src.runs.some((x) => x.args.includes('push'))).toBe(false);

    const map = conflict('examples/basic-nextjs/.sitecore/component-map.ts\n');
    const s2 = new SandboxToolServer({ provider: map.provider, facts, buildEnv: async () => ({}) });
    const r2 = await s2.call('git.integrate', { branches: ['launchworks/port-hero'] }, ctx);
    expect(r2).toMatchObject({
      code: 200,
      body: { regenerated: ['examples/basic-nextjs/.sitecore/component-map.ts'] },
    });
    expect(
      map.runs.some(
        (x) =>
          x.args.join(' ') ===
          'checkout --ours -- examples/basic-nextjs/.sitecore/component-map.ts',
      ),
    ).toBe(true);
  });

  it('generates .sitecore before type-check, as the starter build does', async () => {
    const scripts = {
      'sitecore-tools:generate-map': 'x',
      'sitecore-tools:build': 'x',
      'next:build': 'x',
      'type-check': 'x',
      build: 'x',
    };
    const fake = fakeBox(
      { 'examples/basic-nextjs/package.json': JSON.stringify({ scripts }) },
      (cmd, args) =>
        cmd === 'git' && args[0] === 'rev-parse' ? { exitCode: 0, output: 'abc1234\n' } : null,
    );
    const s = new SandboxToolServer({ provider: fake.provider, facts, buildEnv: async () => ({}) });
    const r = await s.call('exec.build', {}, ctx);
    expect(fake.runs.filter((x) => x.cmd === 'npm').map((x) => x.args[1])).toEqual([
      'sitecore-tools:generate-map',
      'sitecore-tools:build',
      'type-check',
      'next:build',
    ]);
    expect(r.summary).toBe(
      'Build green: type-check and build passed (nothing uncommitted, at abc1234)',
    );
  });

  it('refuses to write files git ignores, which would never be committed', async () => {
    const fake = fakeBox({}, (cmd, args) =>
      cmd === 'git' && args[0] === 'check-ignore'
        ? { exitCode: 0, output: 'examples/basic-nextjs/.sitecore/sites.json\n' }
        : null,
    );
    const s = new SandboxToolServer({ provider: fake.provider, facts, buildEnv: async () => ({}) });
    const r = await s.call(
      'fs.write',
      {
        files: [
          { path: 'examples/basic-nextjs/.sitecore/sites.json', content: '[]' },
          { path: 'examples/basic-nextjs/src/components/CardGrid.tsx', content: 'x' },
        ],
      },
      ctx,
    );
    expect(r.code).toBe(422);
    expect(r.summary).toMatch(/git ignores examples\/basic-nextjs\/.sitecore\/sites.json/);
    expect(fake.files['examples/basic-nextjs/src/components/CardGrid.tsx']).toBeUndefined();
  });

  it('installs with npm install when the lock file is behind package.json, and says to commit it', async () => {
    const fake = fakeBox({ 'examples/basic-nextjs/package-lock.json': '{}' }, (cmd, args) =>
      cmd === 'npm' && args[0] === 'ci'
        ? {
            exitCode: 1,
            output:
              'npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
          }
        : null,
    );
    const s = new SandboxToolServer({ provider: fake.provider, facts, buildEnv: async () => ({}) });
    const r = await s.call('workspace.open', {}, ctx);
    expect(r.code).toBe(200);
    expect(fake.runs.filter((x) => x.cmd === 'npm').map((x) => x.args[0])).toEqual([
      'ci',
      'install',
    ]);
    expect(r.summary).toMatch(
      /package-lock.json was out of date with package.json and was updated: commit it$/,
    );
  });

  it('names the install error when dependencies fail for another reason', async () => {
    const fake = fakeBox({}, (cmd) =>
      cmd === 'npm'
        ? { exitCode: 1, output: 'npm error code E404\nnpm error 404 Not Found - GET x' }
        : null,
    );
    const s = new SandboxToolServer({ provider: fake.provider, facts, buildEnv: async () => ({}) });
    const r = await s.call('workspace.open', {}, ctx);
    expect(r.code).toBe(500);
    expect(r.summary).toMatch(/failed to install: npm error code E404$/);
  });

  it('keep agents inside the repository and away from git internals and secrets', () => {
    expect(safePath('examples/basic-nextjs/src/Hero.tsx')).toBe(
      'examples/basic-nextjs/src/Hero.tsx',
    );
    expect(safePath('../etc/passwd')).toBeNull();
    expect(safePath('.git/config')).toBeNull();
    expect(safePath('a/.sitecore/user.json')).toBeNull();
    expect(safePath('examples/basic-nextjs/.env.local')).toBeNull();
  });

  it('refuse writes to CI and CLI settings, and redact secrets from what they return', async () => {
    const fake = fakeBox({
      'examples/basic-nextjs/out.txt': 'ctx-preview-123456 and ghs_secrettoken',
    });
    const s = new SandboxToolServer({
      provider: fake.provider,
      facts,
      buildEnv: async () => ({ SITECORE_EDGE_CONTEXT_ID: 'ctx-preview-123456' }),
    });
    const w = await s.call(
      'fs.write',
      { files: [{ path: '.github/workflows/x.yml', content: 'x' }] },
      ctx,
    );
    expect(w.code).toBe(422);
    const ok = await s.call(
      'fs.write',
      { files: [{ path: 'examples/basic-nextjs/src/Hero.tsx', content: 'export {}' }] },
      ctx,
    );
    expect(ok.code).toBe(200);
    const r = await s.call('fs.read', { paths: 'examples/basic-nextjs/out.txt' }, ctx);
    expect(JSON.stringify(r.body)).toBe(
      JSON.stringify({
        files: [{ path: 'examples/basic-nextjs/out.txt', content: '[redacted] and [redacted]' }],
      }),
    );
  });

  it('build with the project variables, and commit only to agent branches with a one-off token header', async () => {
    const fake = fakeBox({}, (cmd, args) =>
      cmd === 'git' && args[0] === 'diff'
        ? { exitCode: 0, output: 'examples/basic-nextjs/src/Hero.tsx\n' }
        : null,
    );
    const s = new SandboxToolServer({
      provider: fake.provider,
      facts,
      buildEnv: async () => ({ NEXT_PUBLIC_DEFAULT_SITE_NAME: 'acme' }),
    });
    const b = await s.call('exec.build', {}, ctx);
    expect(b.body).toMatchObject({ green: true });
    expect(fake.runs.find((r) => r.args.join(' ') === 'run build')!.env).toMatchObject({
      NEXT_PUBLIC_DEFAULT_SITE_NAME: 'acme',
    });
    expect((await s.call('git.commit', { branch: 'main', message: 'x' }, ctx)).code).toBe(422);
    const c = await s.call('git.commit', { branch: 'launchworks/hero', message: 'Port Hero' }, ctx);
    expect(c.code).toBe(200);
    const push = fake.runs.find((r) => r.args.includes('push'))!;
    expect(push.args).toContain('HEAD:refs/heads/launchworks/hero');
    expect(push.args[1]).toMatch(/^http\.extraHeader=AUTHORIZATION: basic /);
    expect(
      fake.runs.some(
        (r) => r.args.join(' ').includes('remote set-url') && r.args.join(' ').includes('ghs_'),
      ),
    ).toBe(false);
  });
});

describe('the Sitecore CLI', () => {
  const owned = ['/sitecore/content/Brands/ansco', '/sitecore/templates/Project/Brands/ansco'];

  it("checks module includes against the project's own paths", () => {
    expect(within('/sitecore/content/Brands/ansco/Home', owned)).toBe(true);
    expect(within('/sitecore/content/brands/ANSCO', owned)).toBe(true);
    expect(within('/sitecore/content/Brands/new-brand', owned)).toBe(false);
    expect(within('/sitecore/content/Brands', owned)).toBe(false);
    expect(
      moduleIncludes(
        JSON.stringify({ items: { includes: [{ name: 'a', path: '/sitecore/content/Brands' }] } }),
      ),
    ).toEqual(['/sitecore/content/Brands']);
  });

  const cli = (files: Record<string, string>, drift = '') => {
    const fake = fakeBox(files, (cmd, args) => {
      if (
        cmd === 'git' &&
        args[0] === 'diff' &&
        args[1] === '--name-only' &&
        args[2]?.startsWith('origin/')
      )
        return { exitCode: 0, output: drift };
      if (cmd === 'find')
        return {
          exitCode: 0,
          output: Object.keys(files)
            .filter((f) => f.endsWith('.module.json'))
            .join('\n'),
        };
      return null;
    });
    const server = new SitecoreCliToolServer({
      provider: fake.provider,
      facts: async () => ({
        ...(await facts()),
        cmHost: 'xmc-acme.sitecorecloud.io',
        ownedPaths: owned,
      }),
      client: async () => ({ clientId: 'env-id', clientSecret: 'env-secret-value' }),
    });
    return { server, fake };
  };

  it("refuses a module that reaches another team's site, before signing in", async () => {
    const { server, fake } = cli({
      'authoring/items/brands.module.json': JSON.stringify({
        items: { includes: [{ name: 'all', path: '/sitecore/content/Brands' }] },
      }),
    });
    const r = await server.call('ser.pull', { branch: 'launchworks/ser' }, ctx);
    expect(r.code).toBe(422);
    expect(r.summary).toMatch(/outside the project's paths/);
    expect(fake.runs.some((x) => x.args.includes('login'))).toBe(false);
  });

  it('refuses changed CLI settings', async () => {
    const { server } = cli({}, 'nuget.config\n');
    const r = await server.call('ser.validate', {}, ctx);
    expect(r.summary).toMatch(/nuget.config differ/);
  });

  it('pulls only inside owned paths, signs out afterwards, and never shows the client secret', async () => {
    const { server, fake } = cli({
      'authoring/items/ansco.module.json': JSON.stringify({
        items: { includes: [{ name: 'site', path: '/sitecore/content/Brands/ansco' }] },
      }),
    });
    const r = await server.call('ser.pull', { branch: 'launchworks/ser' }, ctx);
    expect(r.code).toBe(200);
    expect(fake.runs.some((x) => x.args.join(' ').includes('ser pull'))).toBe(true);
    expect(fake.runs.at(-1)!.args).toEqual(['-f', '.sitecore/user.json']);
    expect(JSON.stringify(r)).not.toContain('env-secret-value');
  });
});
