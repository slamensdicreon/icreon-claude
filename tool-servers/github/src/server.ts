import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';

/** The project's repository, from intake. Agents never choose which repository they reach. */
export interface RepoFacts {
  /** "owner/name" */
  repo: string;
  /** The client's branch the work starts from. */
  branch: string;
}

export interface GithubServerOptions {
  /** `github` for the client's source repository; `build-repo` for the one we build in. */
  name?: string;
  facts(projectId: string): Promise<RepoFacts | null>;
  /** Offer branch.commit. Off for the source repository: the site is built in the build repo. */
  commits?: boolean;
  /** What a call says when the project has no such repository yet. */
  missing?: string;
  fetch?: typeof fetch;
  api?: string;
}

/** Agents only ever push to their own branches; the client's branches are read-only. */
export const AGENT_BRANCH_PREFIX = 'launchworks/';
const MAX_FILE_BYTES = 200_000;
const MAX_TREE_ENTRIES = 4_000;

const TreeArgs = z.object({
  path: z.string().max(500).optional(),
  ref: z.string().max(200).optional(),
});
const ReadArgs = z.object({
  // One path is accepted as a string too.
  paths: z.preprocess(
    (v) => (typeof v === 'string' ? [v] : v),
    z.array(z.string().min(1).max(500)).min(1).max(20),
  ),
  ref: z.string().max(200).optional(),
});
const SearchArgs = z.object({ query: z.string().min(2).max(200) });
const CommitArgs = z.object({
  branch: z
    .string()
    .regex(/^launchworks\/[A-Za-z0-9._/-]{1,100}$/, `must start with ${AGENT_BRANCH_PREFIX}`),
  message: z.string().min(1).max(2000),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        /** UTF-8 text; null deletes the file. */
        content: z.string().max(1_000_000).nullable(),
      }),
    )
    .min(1)
    .max(100),
});

const bad = (message: string): ToolResult => ({
  code: 422,
  body: { error: message },
  summary: message,
});

/**
 * The client's repository through the Launchworks GitHub App. Every call carries an installation
 * token limited to this one repository. Reads are wrapped as untrusted by the gateway; writes go
 * only to `launchworks/*` branches, created from the project's branch on first commit.
 */
export class GithubToolServer implements ToolServer {
  readonly name: string;
  readonly catalog: OperationCatalog;
  private static readonly CATALOG: OperationCatalog = {
    'tree.read': {
      description:
        'List the repository: default branch, size, and every file path with its size (directories as "dir"). Optional `path` limits it to a folder; `ref` reads another branch or commit.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, ref: { type: 'string' } },
        additionalProperties: false,
      },
      mutates: false,
      untrusted: true,
    },
    'repo.read': {
      description:
        'Read up to 20 files (UTF-8 text, up to 200 KB each) at the project branch, or at `ref`. Use paths from tree.read.',
      inputSchema: {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
          ref: { type: 'string' },
        },
        required: ['paths'],
        additionalProperties: false,
      },
      mutates: false,
      untrusted: true,
    },
    'code.search': {
      description:
        'Search the repository code (GitHub code search on the default branch): returns matching file paths and fragments. Example queries: "getServerSideProps", "fetch(\'/api", "useSession".',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
      mutates: false,
      untrusted: true,
    },
    'branch.commit': {
      description:
        'Commit files to an agent branch (name must start with "launchworks/"), creating it from the project branch if it does not exist. Each file is UTF-8 text; content null deletes it. Returns the commit SHA and URL.',
      inputSchema: {
        type: 'object',
        properties: {
          branch: { type: 'string' },
          message: { type: 'string' },
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
        required: ['branch', 'message', 'files'],
        additionalProperties: false,
      },
      mutates: true,
    },
  };

  private readonly fetch: typeof fetch;
  private readonly api: string;

  constructor(private readonly opts: GithubServerOptions) {
    this.name = opts.name ?? 'github';
    this.catalog = Object.fromEntries(
      Object.entries(GithubToolServer.CATALOG).filter(
        ([op]) => op !== 'branch.commit' || opts.commits !== false,
      ),
    );
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.api = opts.api ?? 'https://api.github.com';
  }

  target(projectId: string) {
    return `${this.name}:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const facts = await this.opts.facts(ctx.projectId);
    if (!facts) {
      const error = this.opts.missing ?? 'This project has no source repository.';
      return { code: 409, body: { error }, summary: error };
    }
    if (!(op in this.catalog)) return { code: 404, body: { error: `Unknown operation ${op}` } };
    const gh = (method: string, path: string, body?: unknown) =>
      this.request(method, `/repos/${facts.repo}${path}`, ctx.token, body);
    switch (op) {
      case 'tree.read':
        return this.tree(facts, TreeArgs.safeParse(args), gh);
      case 'repo.read':
        return this.read(facts, ReadArgs.safeParse(args), gh);
      case 'code.search':
        return this.search(facts, SearchArgs.safeParse(args), ctx.token);
      case 'branch.commit':
        return this.commit(facts, CommitArgs.safeParse(args), gh);
      default:
        return { code: 404, body: { error: `Unknown operation ${op}` } };
    }
  }

  private async tree(
    facts: RepoFacts,
    a: z.ZodSafeParseResult<z.infer<typeof TreeArgs>>,
    gh: Gh,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const info = await gh('GET', '');
    if (info.status !== 200) return fail(info, `reading ${facts.repo}`);
    const repo = info.body as { default_branch: string; size: number; private: boolean };
    const ref = a.data.ref ?? facts.branch;
    const t = await gh('GET', `/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    if (t.status !== 200) return fail(t, `listing ${ref}`);
    const c = await gh('GET', `/commits/${encodeURIComponent(ref)}`);
    const commit = c.status === 200 ? (c.body as { sha: string }).sha : null;
    const body = t.body as {
      truncated: boolean;
      tree: { path: string; type: 'blob' | 'tree'; size?: number }[];
    };
    const prefix = a.data.path ? a.data.path.replace(/^\/|\/$/g, '') + '/' : '';
    const entries = body.tree
      .filter((e) => !prefix || e.path.startsWith(prefix))
      .filter((e) => !/(^|\/)(node_modules|\.git|\.next)(\/|$)/.test(e.path));
    const files = entries.filter((e) => e.type === 'blob');
    return {
      code: 200,
      body: {
        repository: facts.repo,
        ref,
        commit,
        defaultBranch: repo.default_branch,
        private: repo.private,
        sizeKb: repo.size,
        fileCount: files.length,
        truncated: body.truncated || entries.length > MAX_TREE_ENTRIES,
        entries: entries
          .slice(0, MAX_TREE_ENTRIES)
          .map((e) => (e.type === 'tree' ? `${e.path}/ dir` : `${e.path} ${e.size ?? 0}`)),
      },
      summary: `Listed ${files.length} files in ${facts.repo}${prefix ? `/${prefix}` : ''} at ${ref}`,
    };
  }

  private async read(
    facts: RepoFacts,
    a: z.ZodSafeParseResult<z.infer<typeof ReadArgs>>,
    gh: Gh,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const ref = a.data.ref ?? facts.branch;
    const files = await Promise.all(
      a.data.paths.map(async (path) => {
        const clean = path.replace(/^\/+/, '');
        const r = await gh(
          'GET',
          `/contents/${clean.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
        );
        if (r.status === 404) return { path: clean, error: 'not found' };
        if (r.status !== 200) return { path: clean, error: `GitHub answered ${r.status}` };
        const f = r.body as { type: string; size: number; encoding?: string; content?: string };
        if (Array.isArray(r.body)) return { path: clean, error: 'is a directory' };
        if (f.size > MAX_FILE_BYTES) return { path: clean, error: `too large (${f.size} bytes)` };
        if (f.encoding !== 'base64' || f.content === undefined)
          return { path: clean, error: 'no inline content' };
        const bytes = Buffer.from(f.content, 'base64');
        if (bytes.includes(0)) return { path: clean, error: `binary (${f.size} bytes)` };
        return { path: clean, content: bytes.toString('utf8') };
      }),
    );
    const ok = files.filter((f) => 'content' in f).length;
    return {
      code: 200,
      body: { ref, files },
      summary: `Read ${ok} of ${files.length} file${files.length === 1 ? '' : 's'} from ${facts.repo}`,
    };
  }

  private async search(
    facts: RepoFacts,
    a: z.ZodSafeParseResult<z.infer<typeof SearchArgs>>,
    token: string,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const q = encodeURIComponent(`${a.data.query} repo:${facts.repo}`);
    const r = await this.request('GET', `/search/code?q=${q}&per_page=50`, token, undefined, {
      accept: 'application/vnd.github.text-match+json',
    });
    if (r.status !== 200) return fail(r, 'searching code');
    const body = r.body as {
      total_count: number;
      items: { path: string; text_matches?: { fragment: string }[] }[];
    };
    return {
      code: 200,
      body: {
        total: body.total_count,
        matches: body.items.map((i) => ({
          path: i.path,
          fragments: (i.text_matches ?? []).map((m) => m.fragment).slice(0, 3),
        })),
      },
      summary: `Code search "${a.data.query}": ${body.total_count} match${body.total_count === 1 ? '' : 'es'}`,
    };
  }

  private async commit(
    facts: RepoFacts,
    a: z.ZodSafeParseResult<z.infer<typeof CommitArgs>>,
    gh: Gh,
  ): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const { branch, message, files } = a.data;
    // Where the branch is now, or where it starts from.
    let head = await gh('GET', `/git/ref/heads/${encodeURIComponent(branch)}`);
    let created = false;
    if (head.status === 404) {
      const base = await gh('GET', `/git/ref/heads/${encodeURIComponent(facts.branch)}`);
      if (base.status !== 200) return fail(base, `reading ${facts.branch}`);
      const sha = (base.body as { object: { sha: string } }).object.sha;
      const make = await gh('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
      if (make.status !== 201) return fail(make, `creating ${branch}`);
      head = make;
      created = true;
    } else if (head.status !== 200) {
      return fail(head, `reading ${branch}`);
    }
    const parent = (head.body as { object: { sha: string } }).object.sha;
    const parentCommit = await gh('GET', `/git/commits/${parent}`);
    if (parentCommit.status !== 200) return fail(parentCommit, 'reading the branch head');
    const baseTree = (parentCommit.body as { tree: { sha: string } }).tree.sha;
    const tree = await gh('POST', '/git/trees', {
      base_tree: baseTree,
      tree: files.map((f) => ({
        path: f.path.replace(/^\/+/, ''),
        mode: '100644',
        type: 'blob',
        ...(f.content === null ? { sha: null } : { content: f.content }),
      })),
    });
    if (tree.status !== 201) return fail(tree, 'writing the tree');
    const commit = await gh('POST', '/git/commits', {
      message,
      tree: (tree.body as { sha: string }).sha,
      parents: [parent],
    });
    if (commit.status !== 201) return fail(commit, 'creating the commit');
    const c = commit.body as { sha: string; html_url: string };
    const move = await gh('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, {
      sha: c.sha,
      force: false,
    });
    if (move.status !== 200) return fail(move, `moving ${branch}`);
    return {
      code: 200,
      body: { branch, created, commit: c.sha, url: c.html_url, files: files.length },
      summary: `Committed ${files.length} file${files.length === 1 ? '' : 's'} to ${branch} (${c.sha.slice(0, 7)})`,
    };
  }

  private async request(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    const res = await this.fetch(`${this.api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'launchworks',
        authorization: `token ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }
}

type Gh = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: unknown }>;

function fail(r: { status: number; body: unknown }, doing: string): ToolResult {
  const message = (r.body as { message?: string } | null)?.message;
  return {
    code: r.status,
    body: { error: `GitHub answered ${r.status} ${doing}${message ? `: ${message}` : ''}` },
  };
}
