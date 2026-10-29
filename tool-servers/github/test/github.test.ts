import { describe, expect, it } from 'vitest';
import { GithubToolServer } from '../src';

function fakeGithub() {
  const refs = new Map([['main', 'c0']]);
  const calls: string[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace('/repos/acme/site', '');
    calls.push(`${method} ${p}`);
    if (new Headers(init?.headers).get('authorization') !== 'token ghs_x') return json(401, {});
    if (p === '') return json(200, { default_branch: 'main', size: 1234, private: true });
    if (p === '/git/trees/main')
      return json(200, {
        truncated: false,
        tree: [
          { path: 'src', type: 'tree' },
          { path: 'src/Hero.tsx', type: 'blob', size: 40 },
          { path: 'node_modules/x.js', type: 'blob', size: 1 },
        ],
      });
    if (p === '/git/trees/big')
      return json(200, {
        truncated: false,
        tree: [
          { path: 'README.md', type: 'blob', size: 5 },
          ...Array.from({ length: 400 }, (_, i) => ({
            path: `items/${i % 2 ? 'site' : 'media'}/page-${i}/item.yml`,
            type: 'blob',
            size: 10,
          })),
        ],
      });
    if (p === '/contents/src')
      return json(200, [
        { path: 'src/Hero.tsx', type: 'file' },
        { path: 'src/lib', type: 'dir' },
      ]);
    if (p === '/contents/src/Hero.tsx')
      return json(200, {
        type: 'file',
        size: 40,
        encoding: 'base64',
        content: Buffer.from('export const Hero = () => null;').toString('base64'),
      });
    let m = /^\/git\/ref\/heads\/(.+)$/.exec(p);
    if (m) {
      const sha = refs.get(decodeURIComponent(m[1]!));
      return sha ? json(200, { object: { sha } }) : json(404, { message: 'Not Found' });
    }
    if (p === '/git/refs' && method === 'POST') {
      const b = JSON.parse(String(init!.body));
      refs.set(b.ref.replace('refs/heads/', ''), b.sha);
      return json(201, { object: { sha: b.sha } });
    }
    if (/^\/git\/commits\/c\d$/.test(p)) return json(200, { tree: { sha: 't0' } });
    if (p === '/git/trees' && method === 'POST') return json(201, { sha: 't1' });
    if (p === '/git/commits' && method === 'POST')
      return json(201, { sha: 'c1', html_url: 'https://github.com/acme/site/commit/c1' });
    m = /^\/compare\/(.+)\.\.\.(.+)$/.exec(p);
    if (m) {
      const [base, head] = [refs.get(decodeURIComponent(m[1]!)), m[2]!];
      // a… ← b… ← c… is the only history; anything else has diverged.
      const order = ['a', 'b', 'c'].map((x) => x.repeat(40));
      const [i, j] = [order.indexOf(base ?? ''), order.indexOf(head)];
      const status = i === j ? 'identical' : i >= 0 && j > i ? 'ahead' : 'diverged';
      return json(200, { status, ahead_by: Math.max(0, j - i) });
    }
    m = /^\/git\/refs\/heads\/(.+)$/.exec(p);
    if (m && method === 'PATCH') {
      refs.set(decodeURIComponent(m[1]!), JSON.parse(String(init!.body)).sha);
      return json(200, {});
    }
    return json(404, {});
  }) as typeof globalThis.fetch;
  return { fetch, refs, calls };
}

const ctx = { projectId: 'p', token: 'ghs_x', role: 'repo-analyst', taskId: 't' };

describe('GithubToolServer', () => {
  it('lists and reads the project repository only', async () => {
    const gh = fakeGithub();
    const server = new GithubToolServer({
      facts: async () => ({ repo: 'acme/site', branch: 'main' }),
      fetch: gh.fetch,
    });
    const tree = await server.call('tree.read', {}, ctx);
    expect(tree.body).toMatchObject({
      defaultBranch: 'main',
      fileCount: 1,
      entries: ['src/ dir', 'src/Hero.tsx 40'],
    });
    // Thousands of paths cost an agent its budget: a big listing comes back by folder.
    const big = await server.call('tree.read', { ref: 'big' }, ctx);
    expect(big.body).not.toHaveProperty('entries');
    expect(big.body).toMatchObject({
      fileCount: 401,
      folders: ['README.md', 'items/media/ 200 files', 'items/site/ 200 files'],
      hint: expect.stringContaining('narrower path'),
    });
    const read = await server.call('repo.read', { paths: ['src/Hero.tsx', 'missing.ts'] }, ctx);
    expect(read.body).toMatchObject({
      files: [
        { path: 'src/Hero.tsx', content: 'export const Hero = () => null;' },
        { path: 'missing.ts', error: 'not found' },
      ],
    });
    expect(read.summary).toBe('Read 1 of 2 files from acme/site (missing.ts: not found)');

    // A list run together in one string is split; a folder says what is in it.
    const loose = await server.call('repo.read', { paths: 'src/Hero.tsx, src\n' }, ctx);
    expect(loose.body).toMatchObject({
      files: [
        { path: 'src/Hero.tsx', content: 'export const Hero = () => null;' },
        { path: 'src', error: 'is a folder, not a file', contains: ['src/Hero.tsx', 'src/lib/'] },
      ],
    });
    expect(loose.summary).toBe('Read 1 of 2 files from acme/site (src: is a folder, not a file)');
  });

  it('commits to a new launchworks branch from the project branch, never to others', async () => {
    const gh = fakeGithub();
    const server = new GithubToolServer({
      facts: async () => ({ repo: 'acme/site', branch: 'main' }),
      fetch: gh.fetch,
    });
    const files = [{ path: 'sitecore.json', content: '{}' }];
    expect(
      (await server.call('branch.commit', { branch: 'main', message: 'x', files }, ctx)).code,
    ).toBe(422);
    const r = await server.call(
      'branch.commit',
      { branch: 'launchworks/foundation', message: 'Add sitecore.json', files },
      ctx,
    );
    expect(r).toMatchObject({ code: 200, body: { created: true, commit: 'c1' } });
    expect(gh.refs.get('launchworks/foundation')).toBe('c1');
    expect(gh.refs.get('main')).toBe('c0');
  });

  it('offers no commits on the source repository, and names a missing build repository', async () => {
    const gh = fakeGithub();
    const source = new GithubToolServer({
      facts: async () => ({ repo: 'acme/site', branch: 'main' }),
      commits: false,
      fetch: gh.fetch,
    });
    expect(Object.keys(source.catalog)).not.toContain('branch.commit');
    expect(
      await source.call('branch.commit', { branch: 'launchworks/x', message: 'm', files: [] }, ctx),
    ).toMatchObject({ code: 404 });

    const build = new GithubToolServer({
      name: 'build-repo',
      facts: async () => null,
      missing: 'No build repository yet.',
      fetch: gh.fetch,
    });
    expect(build.name).toBe('build-repo');
    expect(build.catalog).toHaveProperty('branch.commit');
    expect(await build.call('tree.read', {}, ctx)).toMatchObject({
      code: 409,
      body: { error: 'No build repository yet.' },
    });
  });

  it('promotes the reviewed integration commit to main by fast-forward only', async () => {
    const gh = fakeGithub();
    const build = new GithubToolServer({
      name: 'build-repo',
      facts: async () => ({ repo: 'acme/site', branch: 'main' }),
      fetch: gh.fetch,
    });
    const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(40));
    expect(build.catalog['branch.promote']).toMatchObject({ releases: true, mutates: true });
    gh.refs.set('main', a!);
    gh.refs.set('launchworks/integration', c!);

    // Integration moved since the review: nothing changes.
    expect(await build.call('branch.promote', { commit: b!.slice(0, 7) }, ctx)).toMatchObject({
      code: 409,
      summary: expect.stringContaining('moved'),
    });
    expect(gh.refs.get('main')).toBe(a);

    const ok = await build.call('branch.promote', { commit: c!.slice(0, 7) }, ctx);
    expect(ok).toMatchObject({ code: 200, body: { branch: 'main', commit: c, ahead: 2 } });
    expect(gh.refs.get('main')).toBe(c);
    expect(await build.call('branch.promote', { commit: c!.slice(0, 7) }, ctx)).toMatchObject({
      code: 200,
      body: { ahead: 0 },
    });

    // A main with work the integration branch lacks is never overwritten.
    gh.refs.set('main', 'd'.repeat(40));
    expect(await build.call('branch.promote', { commit: c!.slice(0, 7) }, ctx)).toMatchObject({
      code: 409,
      summary: expect.stringContaining('diverged'),
    });
    expect(gh.refs.get('main')).toBe('d'.repeat(40));
  });
});
