import type { BuildRepo } from '@lw/contracts';
import { createProjectState, type ProjectState } from '@lw/domain';
import {
  InMemoryEventStore,
  MemoryIntegrationStore,
  MemoryTombstoneStore,
  MemoryVault,
} from '@lw/events';
import { describe, expect, it } from 'vitest';
import { deletionReadiness, purgeProject, type PurgeDeps } from '../src/purge';

const repo = (name: string): BuildRepo => ({
  repo: `lw-build/${name}`,
  branch: 'main',
  installationId: 77,
  url: `https://github.com/lw-build/${name}`,
  template: 'Sitecore/xmcloud-starter-js',
  appPath: 'examples/basic-nextjs',
});

/** An archived project scheduled for deletion, with a repo, a hosting project and a connection. */
const project = (id: string, over: Partial<ProjectState> = {}): ProjectState => ({
  ...createProjectState(id),
  name: id,
  client: 'Globex',
  status: 'archived',
  deletion: { due: '2026-12-07T12:00:00.000Z', requestedBy: 'steve', purging: false },
  buildRepo: repo(`${id}-site`),
  hosting: { provider: 'vercel', project: `${id}-website`, url: null },
  intake: { platform: 'sitecoreai', repo: null, branch: null, target: {}, connectionId: 'c1' },
  ...over,
});

function deps(projects: ProjectState[], github: 'ok' | 'refused' | 'none' = 'ok') {
  const deletedRepos: string[] = [];
  const deletedHosting: string[] = [];
  const integrations = new MemoryIntegrationStore();
  const vault = new MemoryVault();
  const d: PurgeDeps = {
    store: new InMemoryEventStore(),
    tombstones: new MemoryTombstoneStore(),
    integrations,
    vault,
    buildOrg: 'lw-build',
    github:
      github === 'none'
        ? null
        : {
            deleteBuildRepo: async (_org, r) => {
              if (github === 'refused')
                return { outcome: 'refused', detail: 'GitHub refused to delete it.' };
              deletedRepos.push(r.repo);
              return { outcome: 'deleted', detail: `${r.repo} deleted.` };
            },
          },
    hosting: {
      deleteProject: async (name) => {
        deletedHosting.push(name);
        return { outcome: 'deleted', detail: `${name} deleted.` };
      },
    },
    projects: () => projects,
  };
  return { d, deletedRepos, deletedHosting, integrations, vault };
}

describe('purging what we created outside our stores', () => {
  it('deletes the repo, the hosting project and an unused saved connection', async () => {
    const gone = project('prj-gone');
    const t = deps([gone]);
    await t.integrations.put('connection:c1', { name: 'Globex tenant' });
    await t.vault.seal('connection:c1', 'sitecore-environment', 'secret');
    const tomb = await purgeProject(t.d, gone, 'vercel-cron');
    expect(t.deletedRepos).toEqual(['lw-build/prj-gone-site']);
    expect(t.deletedHosting).toEqual(['prj-gone-website']);
    expect(await t.integrations.get('connection:c1')).toBeNull();
    expect(await t.vault.deleteProject('connection:c1')).toBe(0);
    expect(tomb.steps.repository?.result).toMatchObject({ outcome: 'deleted' });
    expect(tomb.steps.connection?.result).toMatchObject({ outcome: 'deleted' });
    expect(tomb.finishedAt).toBeTruthy();
  });

  it('leaves what another project still uses, and records a refusal without stopping', async () => {
    const gone = project('prj-gone');
    const stays = project('prj-stays', {
      status: 'running',
      deletion: null,
      hosting: { provider: 'vercel', project: 'prj-gone-website', url: null },
    });
    const t = deps([gone, stays], 'refused');
    await t.integrations.put('connection:c1', { name: 'Globex tenant' });
    const tomb = await purgeProject(t.d, gone, 'vercel-cron');
    expect(tomb.steps.repository?.result).toMatchObject({ outcome: 'refused' });
    expect(tomb.steps.hosting?.result).toMatchObject({
      outcome: 'skipped',
      detail: expect.stringContaining('prj-stays'),
    });
    expect(tomb.steps.connection?.result).toMatchObject({ outcome: 'skipped' });
    expect(t.deletedHosting).toEqual([]);
    expect(await t.integrations.get('connection:c1')).not.toBeNull();
    expect(tomb.finishedAt).toBeTruthy();
  });

  it('says so when no GitHub App is connected', async () => {
    const gone = project('prj-gone');
    const tomb = await purgeProject(deps([gone], 'none').d, gone, 'vercel-cron');
    expect(tomb.steps.repository?.result).toMatchObject({
      outcome: 'refused',
      detail: expect.stringContaining('No GitHub App'),
    });
  });

  it('deletes now from any state but running, keeping what the operator chose to keep', async () => {
    const mistake = project('prj-mistake', { status: 'intake', deletion: null });
    const t = deps([mistake]);
    const tomb = await purgeProject(t.d, mistake, 'steve', { now: true, keep: ['repository'] });
    expect(t.deletedRepos).toEqual([]);
    expect(t.deletedHosting).toEqual(['prj-mistake-website']);
    expect(tomb.steps.repository?.result).toMatchObject({ outcome: 'kept' });
    expect(tomb).toMatchObject({ requestedBy: 'steve', purgedBy: 'steve' });
    expect(tomb.finishedAt).toBeTruthy();

    const live = project('prj-live', { status: 'running', deletion: null });
    await expect(purgeProject(deps([live]).d, live, 'steve', { now: true })).rejects.toThrow(
      'pause it',
    );
    // The daily run never deletes a project that wasn't archived and scheduled.
    const fresh = project('prj-fresh', { status: 'intake', deletion: null });
    await expect(purgeProject(deps([fresh]).d, fresh, 'vercel-cron')).rejects.toThrow(
      'not an archived project',
    );
  });

  it('keeps what the operator kept when the daily run finishes a purge cut off part way', async () => {
    const cut = project('prj-cut', { status: 'paused', deletion: null });
    const t = deps([cut]);
    t.d.hosting = {
      deleteProject: async () => {
        throw new Error('Vercel unavailable');
      },
    };
    await expect(
      purgeProject(t.d, cut, 'steve', { now: true, keep: ['repository'] }),
    ).rejects.toThrow('Vercel unavailable');
    t.d.hosting = { deleteProject: async (name) => ({ outcome: 'deleted', detail: name }) };
    // The log is still there (it goes last), so the daily run resumes with the project's state.
    const tomb = await purgeProject(t.d, cut, 'vercel-cron');
    expect(t.deletedRepos).toEqual([]);
    expect(tomb.steps.repository?.result).toMatchObject({ outcome: 'kept' });
    expect(tomb.steps.hosting?.result).toMatchObject({ outcome: 'deleted' });
    expect(tomb.finishedAt).toBeTruthy();
  });
});

describe('deletion readiness', () => {
  it('asks GitHub and Vercel, and says what is not connected', async () => {
    const t = deps([]);
    t.d.github!.canDeleteRepos = async (org) => ({ state: 'ok', detail: `ok on ${org}` });
    t.d.hosting!.canDelete = async () => ({ state: 'missing', detail: 'a Developer' });
    expect(await deletionReadiness(t.d)).toMatchObject({
      repository: { state: 'ok', detail: 'ok on lw-build' },
      hosting: { state: 'missing', detail: 'a Developer' },
    });
    expect(
      await deletionReadiness({ ...t.d, github: null, hosting: null, buildOrg: null }),
    ).toMatchObject({ repository: { state: 'off' }, hosting: { state: 'off' } });
  });
});
