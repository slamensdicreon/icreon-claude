import type { ProjectState } from '@lw/domain';
import type { SecretVault } from '@lw/events';
import type { CredentialProvider } from '@lw/tool-gateway';
import type { GithubApp } from './github-app';
import { sitecoreToken, type VerifyConfig } from './sitecore';

/** A credential a project needs but doesn't have, or one the service refused. */
export class CredentialError extends Error {}

export interface VaultCredentialsDeps {
  /** The project's read model: its credential references and intake facts. */
  project(projectId: string): Promise<ProjectState | undefined>;
  vault: SecretVault;
  github?: GithubApp | null;
  sitecore: VerifyConfig;
}

/** Which project credential backs each Sitecore tool server. */
const SITECORE: Record<string, string> = {
  'sitecore-authoring': 'sitecore-environment',
  'sitecore-deploy': 'sitecore-organization',
};

/**
 * Credentials for tool calls, minted at the moment of the call from what the project sealed at
 * intake. Agents never see them; the gateway passes them to the tool server and redacts them
 * from anything recorded.
 *
 * - github: an installation token of the Launchworks GitHub App, limited to the project's one
 *   source repository, valid an hour.
 * - build-repo: the same, on our organization's installation, limited to the build repository.
 * - sitecore-authoring / sitecore-deploy: an OAuth token for the project's environment or
 *   organization automation client.
 * - Everything else needs no external credential.
 */
export class VaultCredentials implements CredentialProvider {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly deps: VaultCredentialsDeps) {}

  async tokenFor(projectId: string, server: string): Promise<string> {
    if (server === 'github') return this.github(projectId);
    if (server === 'build-repo') return this.buildRepo(projectId);
    if (SITECORE[server]) return this.sitecore(projectId, SITECORE[server]);
    return 'no-external-credential';
  }

  private async github(projectId: string): Promise<string> {
    const s = await this.deps.project(projectId);
    const repo = s?.intake?.repo;
    if (!repo) throw new CredentialError('This project has no source repository.');
    if (!this.deps.github) throw new CredentialError('The Launchworks GitHub App is not set up.');
    const m = /^github-app:installation\/(\d+)$/.exec(s.credentials.github?.reference ?? '');
    if (!m) {
      throw new CredentialError(
        `The GitHub App isn't installed on ${repo} yet. Install it, then use Check again on GitHub in Settings.`,
      );
    }
    return this.deps.github.installationToken(Number(m[1]), [repo.split('/')[1]!]);
  }

  /** An installation token on our organization, limited to the project's build repository. */
  private async buildRepo(projectId: string): Promise<string> {
    const b = (await this.deps.project(projectId))?.buildRepo;
    if (!b) {
      throw new CredentialError(
        'This project has no build repository yet. Create it in Settings, under Build repository.',
      );
    }
    if (!this.deps.github) throw new CredentialError('The Launchworks GitHub App is not set up.');
    return this.deps.github.installationToken(b.installationId, [b.repo.split('/')[1]!]);
  }

  private async sitecore(projectId: string, credentialId: string): Promise<string> {
    const key = `${projectId}:${credentialId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - Date.now() > 2 * 60_000) return cached.token;
    const s = await this.deps.project(projectId);
    const c = s?.credentials[credentialId];
    if (!c?.reference) {
      throw new CredentialError(
        `${c?.system ?? credentialId} hasn't been provided for this project.`,
      );
    }
    const secret = JSON.parse(await this.deps.vault.open(c.reference)) as {
      clientId: string;
      clientSecret: string;
    };
    const r = await sitecoreToken(this.deps.sitecore, secret.clientId, secret.clientSecret);
    if (!('token' in r)) throw new CredentialError(`${c.system}: ${r.detail}`);
    const expiresAt = r.expiresAt ? Date.parse(r.expiresAt) : Date.now() + 10 * 60_000;
    this.cache.set(key, { token: r.token, expiresAt });
    return r.token;
  }
}
