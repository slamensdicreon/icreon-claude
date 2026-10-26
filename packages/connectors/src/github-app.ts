import { createSign, randomBytes } from 'node:crypto';
import { CommandError } from '@lw/domain';
import type { IntegrationStore, SecretVault } from '@lw/events';
import type { BuildRepo } from '@lw/contracts';
import type { VerifyResult } from './sitecore';

/** Sitecore's starter, and the Next.js app inside it that becomes the site. */
/** The one commit Launchworks adds to a fresh starter: see ensureNoGitDeploys. */
export const NO_GIT_DEPLOYS_MESSAGE =
  'Deploy through Launchworks only: no automatic Vercel deployments on commits';

export const STARTER = {
  owner: 'Sitecore',
  repo: 'xmcloud-starter-js',
  appPath: 'examples/basic-nextjs',
};

/**
 * The Launchworks GitHub App: how agents reach client repositories. It is created with GitHub's
 * manifest flow (the operator confirms on github.com; GitHub hands the keys straight to this
 * server), installed by each client on just their repository, and used through short-lived
 * installation tokens scoped to one repository.
 */

/** What is stored about the app. Secrets are vault references. */
export interface GithubAppConfig {
  appId: number;
  slug: string;
  name: string;
  clientId: string;
  owner: string;
  htmlUrl: string;
  privateKeyRef: string;
  clientSecretRef: string;
  webhookSecretRef: string | null;
  createdAt: string;
}

export interface GithubAppStatus {
  connected: boolean;
  app: {
    name: string;
    slug: string;
    owner: string;
    htmlUrl: string;
    installUrl: string;
    permissions: Record<string, string>;
  } | null;
  installations: { account: string; repositories: 'all' | 'selected' }[];
}

export interface GithubDeps {
  integrations: IntegrationStore;
  vault: SecretVault;
  /** This API's public URL: GitHub redirects back to it. */
  publicUrl: string;
  /** The Control Center's URL, where the operator lands afterwards. */
  appUrl: string;
  /** The account the app is created under. */
  owner: { kind: 'user' } | { kind: 'org'; org: string };
  fetch?: typeof fetch;
  api?: string;
  web?: string;
}

/**
 * What agents may do in a client repository: read the code, push to their own branch, open pull
 * requests, and read CI results. Administration is used only in our own organization, to create
 * each project's build repository; clients install the app on single repositories, where it
 * changes no settings. Nothing else (no issues, no workflow files).
 */
export const APP_PERMISSIONS: Record<string, 'read' | 'write'> = {
  administration: 'write',
  metadata: 'read',
  contents: 'write',
  pull_requests: 'write',
  checks: 'read',
  statuses: 'read',
  actions: 'read',
};

const KEY = 'github.app';
const PENDING = 'github.app.pending';
const SYSTEM = '__system__';

export class GithubApp {
  private readonly fetch: typeof fetch;
  private readonly api: string;
  private readonly web: string;

  constructor(private readonly deps: GithubDeps) {
    this.fetch = deps.fetch ?? ((...a) => fetch(...a));
    this.api = deps.api ?? 'https://api.github.com';
    this.web = deps.web ?? 'https://github.com';
  }

  /** The Control Center's URL: where the operator lands after GitHub. */
  get appUrl(): string {
    return this.deps.appUrl;
  }

  async config(): Promise<GithubAppConfig | null> {
    return this.deps.integrations.get<GithubAppConfig>(KEY);
  }

  /**
   * The form the Control Center posts to GitHub: where to, and the manifest. The state is kept
   * for an hour (as long as GitHub's code lives) and checked on the way back.
   */
  async manifest(name: string): Promise<{ action: string; manifest: string }> {
    if (await this.config()) {
      throw new CommandError(409, 'already_connected', 'The GitHub App is already set up.');
    }
    const state = randomBytes(24).toString('base64url');
    await this.deps.integrations.put(PENDING, {
      state,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const base = this.deps.publicUrl.replace(/\/$/, '');
    const manifest = {
      name: name.trim().slice(0, 34) || 'Launchworks',
      url: this.deps.appUrl,
      description:
        'Launchworks agents read a client repository, work on their own branch and open pull requests for review.',
      // Installable by client accounts on their own repositories; not listed anywhere.
      public: true,
      redirect_url: `${base}/integrations/github/callback`,
      setup_url: `${base}/integrations/github/installed`,
      setup_on_update: true,
      request_oauth_on_install: false,
      default_permissions: APP_PERMISSIONS,
      default_events: [],
    };
    const path =
      this.deps.owner.kind === 'org'
        ? `/organizations/${encodeURIComponent(this.deps.owner.org)}/settings/apps/new`
        : '/settings/apps/new';
    return {
      action: `${this.web}${path}?state=${encodeURIComponent(state)}`,
      manifest: JSON.stringify(manifest),
    };
  }

  /** GitHub's redirect after the operator confirms: trade the code for the app's keys. */
  async complete(code: string, state: string): Promise<GithubAppConfig> {
    const pending = await this.deps.integrations.get<{ state: string; expiresAt: string }>(PENDING);
    if (!pending || pending.state !== state || Date.parse(pending.expiresAt) < Date.now()) {
      throw new CommandError(
        400,
        'bad_state',
        'This GitHub App setup link has expired or was not started here. Start again from Settings.',
      );
    }
    const res = await this.fetch(
      `${this.api}/app-manifests/${encodeURIComponent(code)}/conversions`,
      {
        method: 'POST',
        headers: this.headers(),
      },
    );
    if (res.status !== 201) {
      throw new CommandError(
        422,
        'manifest_failed',
        `GitHub did not hand over the app's keys (${res.status}). The code lasts an hour: start again from Settings.`,
      );
    }
    const b = (await res.json()) as {
      id: number;
      slug: string;
      name: string;
      client_id: string;
      client_secret: string;
      webhook_secret: string | null;
      pem: string;
      html_url: string;
      owner: { login: string };
    };
    const { vault } = this.deps;
    const config: GithubAppConfig = {
      appId: b.id,
      slug: b.slug,
      name: b.name,
      clientId: b.client_id,
      owner: b.owner.login,
      htmlUrl: b.html_url,
      privateKeyRef: (await vault.seal(SYSTEM, 'github.app.private_key', b.pem)).reference,
      clientSecretRef: (await vault.seal(SYSTEM, 'github.app.client_secret', b.client_secret))
        .reference,
      webhookSecretRef: b.webhook_secret
        ? (await vault.seal(SYSTEM, 'github.app.webhook_secret', b.webhook_secret)).reference
        : null,
      createdAt: new Date().toISOString(),
    };
    await this.deps.integrations.put(KEY, config);
    await this.deps.integrations.delete(PENDING);
    return config;
  }

  async status(): Promise<GithubAppStatus> {
    const c = await this.config();
    if (!c) return { connected: false, app: null, installations: [] };
    const r = await this.call('GET', '/app/installations?per_page=100', await this.jwt(c));
    const installations =
      r.status === 200
        ? (
            r.body as { account: { login: string }; repository_selection: 'all' | 'selected' }[]
          ).map((i) => ({ account: i.account.login, repositories: i.repository_selection }))
        : [];
    return {
      connected: true,
      app: {
        name: c.name,
        slug: c.slug,
        owner: c.owner,
        htmlUrl: c.htmlUrl,
        installUrl: this.installUrl(c),
        permissions: APP_PERMISSIONS,
      },
      installations,
    };
  }

  installUrl(c: Pick<GithubAppConfig, 'slug'>): string {
    return `${this.web}/apps/${c.slug}/installations/new`;
  }

  /**
   * Can agents reach this repository and branch? Finds the app's installation on the repository,
   * takes a token limited to that one repository, and reads the repository and the branch.
   */
  async checkRepo(
    repo: string,
    branch: string,
  ): Promise<VerifyResult & { installationId?: number }> {
    const c = await this.config();
    if (!c) {
      return {
        ok: false,
        detail:
          'The Launchworks GitHub App is not set up yet. Create it in Settings, then check again.',
      };
    }
    const [owner, name] = repo.split('/');
    const jwt = await this.jwt(c);
    const inst = await this.call('GET', `/repos/${owner}/${name}/installation`, jwt);
    if (inst.status === 404) {
      return {
        ok: false,
        detail: `The app is not installed on ${repo}. Send the repository owner the install link: ${this.installUrl(c)}`,
      };
    }
    if (inst.status !== 200) {
      return { ok: false, detail: `GitHub answered ${inst.status} looking up the app on ${repo}.` };
    }
    const installationId = (inst.body as { id: number }).id;
    const tok = await this.call('POST', `/app/installations/${installationId}/access_tokens`, jwt, {
      repositories: [name],
    });
    if (tok.status !== 201) {
      return {
        ok: false,
        detail: `The app is installed on ${owner}, but not given access to ${name}. Add the repository to the installation.`,
      };
    }
    const token = `token ${(tok.body as { token: string }).token}`;
    const r = await this.call('GET', `/repos/${owner}/${name}`, token);
    if (r.status !== 200)
      return { ok: false, detail: `GitHub answered ${r.status} reading ${repo}.` };
    const info = r.body as { private: boolean; default_branch: string };
    const br = await this.call(
      'GET',
      `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`,
      token,
    );
    if (br.status === 404) {
      return {
        ok: false,
        detail: `${repo} has no branch "${branch}". Its default branch is ${info.default_branch}.`,
        installationId,
      };
    }
    if (br.status !== 200)
      return { ok: false, detail: `GitHub answered ${br.status} reading ${branch}.` };
    return {
      ok: true,
      detail: `Access to ${repo} (${info.private ? 'private' : 'public'}) through the GitHub App. Branch ${branch} found.`,
      installationId,
    };
  }

  /**
   * The project's build repository in our organization, created from Sitecore's starter. Safe to
   * repeat: an existing repository of that name is checked and reused, never overwritten. GitHub
   * fills a generated repository in the background, so it counts as ready only once the starter's
   * app can be read back.
   */
  async createBuildRepo(org: string, name: string, description: string): Promise<BuildRepo> {
    const c = await this.config();
    if (!c) {
      throw new CommandError(
        409,
        'github_not_connected',
        'Set up the GitHub App in Settings first.',
      );
    }
    const inst = await this.call(
      'GET',
      `/orgs/${encodeURIComponent(org)}/installation`,
      await this.jwt(c),
    );
    if (inst.status === 404) {
      throw new CommandError(
        409,
        'not_installed',
        `The GitHub App isn't installed on the ${org} organization. Install it there with "All repositories": ${this.installUrl(c)}`,
      );
    }
    if (inst.status !== 200) {
      throw new CommandError(
        503,
        'github_error',
        `GitHub answered ${inst.status} looking up the app on ${org}.`,
      );
    }
    const i = inst.body as {
      id: number;
      repository_selection: 'all' | 'selected';
      permissions: Record<string, string>;
    };
    if (i.permissions.administration !== 'write') {
      throw new CommandError(
        409,
        'missing_permission',
        `The app needs Administration: Read and write to create repositories in ${org}. Add it in the app's settings, then accept the new permission on the ${org} installation.`,
      );
    }
    if (i.repository_selection !== 'all') {
      throw new CommandError(
        409,
        'selected_repositories',
        `The app is installed on ${org} for selected repositories only, so new repositories won't be reachable. Change the installation to "All repositories".`,
      );
    }
    const token = `token ${await this.installationToken(i.id)}`;
    const full = `${org}/${name}`;
    let repo = await this.call('GET', `/repos/${full}`, token);
    let created = false;
    if (repo.status === 404) {
      const gen = await this.call(
        'POST',
        `/repos/${STARTER.owner}/${STARTER.repo}/generate`,
        token,
        {
          owner: org,
          name,
          description,
          private: true,
          include_all_branches: false,
        },
      );
      if (gen.status !== 201) {
        const message = (gen.body as { message?: string } | null)?.message;
        throw new CommandError(
          503,
          'github_error',
          `GitHub answered ${gen.status} creating ${full} from ${STARTER.owner}/${STARTER.repo}${message ? `: ${message}` : ''}.`,
        );
      }
      repo = gen;
      created = true;
    } else if (repo.status !== 200) {
      throw new CommandError(
        503,
        'github_error',
        `GitHub answered ${repo.status} reading ${full}.`,
      );
    }
    const info = repo.body as { default_branch?: string; html_url: string; private: boolean };
    if (!created && !info.private) {
      throw new CommandError(
        409,
        'repo_public',
        `${full} exists and is public. Choose another name.`,
      );
    }
    // Executed is not verified: wait until the starter's app is really there.
    const probe = `/repos/${full}/contents/${STARTER.appPath}/package.json`;
    for (let attempt = 0; ; attempt++) {
      const r = await this.call('GET', probe, token);
      if (r.status === 200) break;
      if (!created) {
        throw new CommandError(
          409,
          'not_a_starter',
          `${full} already exists and isn't built from ${STARTER.owner}/${STARTER.repo} (no ${STARTER.appPath}). Choose another name.`,
        );
      }
      if (attempt >= 14) {
        throw new CommandError(
          503,
          'not_ready',
          `${full} was created, but GitHub hasn't filled it yet. Try again in a minute.`,
        );
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    // An existing repository is reused only while it is still the untouched starter (a retry
    // after GitHub was slow to fill it), never with an earlier run's work in it.
    if (!created) {
      const branch = info.default_branch ?? 'main';
      const [branches, commits] = await Promise.all([
        this.call('GET', `/repos/${full}/branches?per_page=10`, token),
        this.call(
          'GET',
          `/repos/${full}/commits?sha=${encodeURIComponent(branch)}&per_page=3`,
          token,
        ),
      ]);
      const others = ((branches.body as { name: string }[] | null) ?? [])
        .map((b) => b.name)
        .filter((b) => b !== branch);
      // The starter's commit, and at most Launchworks' own vercel.json commit.
      const history = ((commits.body as { commit?: { message?: string } }[] | null) ?? []).filter(
        (c) => c.commit?.message !== NO_GIT_DEPLOYS_MESSAGE,
      );
      if (
        branches.status !== 200 ||
        commits.status !== 200 ||
        others.length ||
        history.length > 1
      ) {
        throw new CommandError(
          409,
          'repo_used',
          `${full} already has work in it${others.length ? ` (branches ${others.join(', ')})` : ''}, so it isn't a fresh starter. Choose another name.`,
        );
      }
    }
    await this.ensureNoGitDeploys({
      repo: full,
      branch: info.default_branch ?? 'main',
      installationId: i.id,
      appPath: STARTER.appPath,
    });
    return {
      repo: full,
      branch: info.default_branch ?? 'main',
      installationId: i.id,
      url: info.html_url,
      template: `${STARTER.owner}/${STARTER.repo}`,
      appPath: STARTER.appPath,
    };
  }

  /**
   * The build repository's vercel.json turns off Vercel's automatic deployments on commits.
   * Deployments go through Launchworks' hosting tools (the API), as approved releases; Vercel's
   * own Git deployments of agents' commits are refused anyway (the commit author isn't a team
   * member) and notify the team each time. Idempotent; the client can turn them back on.
   */
  async ensureNoGitDeploys(repo: {
    repo: string;
    branch: string;
    installationId: number;
    appPath: string;
  }): Promise<'added' | 'present'> {
    const token = `token ${await this.installationToken(repo.installationId, [repo.repo.split('/')[1]!])}`;
    const path = `${repo.appPath}/vercel.json`;
    const url = `/repos/${repo.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    const r = await this.call('GET', `${url}?ref=${encodeURIComponent(repo.branch)}`, token);
    let config: Record<string, unknown> = {};
    let sha: string | undefined;
    if (r.status === 200) {
      const f = r.body as { content?: string; sha: string };
      sha = f.sha;
      try {
        config = JSON.parse(Buffer.from(f.content ?? '', 'base64').toString('utf8')) as Record<
          string,
          unknown
        >;
      } catch {
        throw new CommandError(409, 'bad_vercel_json', `${repo.repo}/${path} isn't valid JSON.`);
      }
      if ((config.git as { deploymentEnabled?: unknown } | undefined)?.deploymentEnabled === false)
        return 'present';
    } else if (r.status !== 404) {
      throw new CommandError(503, 'github_error', `GitHub answered ${r.status} reading ${path}.`);
    }
    const next = {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      ...config,
      git: { ...(config.git as object | undefined), deploymentEnabled: false },
    };
    const put = await this.call('PUT', url, token, {
      message: NO_GIT_DEPLOYS_MESSAGE,
      content: Buffer.from(`${JSON.stringify(next, null, 2)}\n`).toString('base64'),
      branch: repo.branch,
      ...(sha ? { sha } : {}),
    });
    if (put.status !== 200 && put.status !== 201)
      throw new CommandError(503, 'github_error', `GitHub answered ${put.status} writing ${path}.`);
    return 'added';
  }

  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  /**
   * An installation token limited to the given repositories of that installation, valid about an
   * hour. Reused until five minutes before it expires. This is what agents' tool calls carry.
   */
  async installationToken(installationId: number, repositories?: string[]): Promise<string> {
    const key = `${installationId}:${repositories ? [...repositories].sort().join(',') : '*'}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const c = await this.config();
    if (!c) throw new Error('The Launchworks GitHub App is not set up. Create it in Settings.');
    const r = await this.call(
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      await this.jwt(c),
      repositories ? { repositories } : {},
    );
    if (r.status !== 201) {
      throw new Error(
        `GitHub refused a token for installation ${installationId} (${r.status}). Check the app is still installed${repositories ? ` on ${repositories.join(', ')}` : ''}.`,
      );
    }
    const body = r.body as { token: string; expires_at: string };
    this.tokens.set(key, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  /** A JWT for the app itself, valid ten minutes (backdated a minute for clock drift). */
  private async jwt(c: GithubAppConfig): Promise<string> {
    const pem = await this.deps.vault.open(c.privateKeyRef);
    const now = Math.floor(Date.now() / 1000);
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: c.clientId })}`;
    const signature = createSign('RSA-SHA256').update(body).sign(pem).toString('base64url');
    return `Bearer ${body}.${signature}`;
  }

  private headers(): Record<string, string> {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'launchworks',
    };
  }

  private async call(method: string, path: string, authorization: string, body?: unknown) {
    const res = await this.fetch(`${this.api}${path}`, {
      method,
      headers: {
        ...this.headers(),
        authorization,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed };
  }
}
