import { describe, expect, it } from 'vitest';
import { CredentialError, VaultCredentials } from '../src';

const vault = { seal: async () => 'ref', open: async () => '{}' } as never;
const credentials = (intake: Record<string, unknown> | null, github?: string) =>
  new VaultCredentials({
    project: async () =>
      ({
        intake,
        credentials: github ? { github: { reference: github } } : {},
      }) as never,
    vault,
    github: { installationToken: async () => 'ghs_token' } as never,
  });

describe('VaultCredentials for the source repository', () => {
  it('needs no credential on a project with no source repository: it is not an access problem', async () => {
    await expect(credentials({ platform: 'sitecoreai' }).tokenFor('p1', 'github')).resolves.toBe(
      'no-external-credential',
    );
  });

  it("refuses when the project has a repository the GitHub App isn't installed on", async () => {
    await expect(
      credentials({ platform: 'sitecoreai', repo: 'acme/site' }).tokenFor('p1', 'github'),
    ).rejects.toBeInstanceOf(CredentialError);
  });

  it('mints an installation token when the app is installed', async () => {
    await expect(
      credentials(
        { platform: 'sitecoreai', repo: 'acme/site' },
        'github-app:installation/42',
      ).tokenFor('p1', 'github'),
    ).resolves.toBe('ghs_token');
  });
});
