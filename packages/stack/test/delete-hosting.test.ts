import { describe, expect, it } from 'vitest';
import { deleteHostingProject } from '../src';

function vercel(read: number, del = 204) {
  const calls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${u.pathname}?${u.searchParams}`);
    const status = (init?.method ?? 'GET') === 'DELETE' ? del : read;
    return new Response(status === 204 ? null : '{}', { status });
  }) as typeof globalThis.fetch;
  return { w: { token: 't', teamId: 'team_1', fetch }, calls };
}

describe('deleting a hosting project', () => {
  it('deletes it from our team', async () => {
    const { w, calls } = vercel(200);
    expect(await deleteHostingProject(w, 'globex-website')).toMatchObject({ outcome: 'deleted' });
    expect(calls).toEqual([
      'GET /v9/projects/globex-website?teamId=team_1',
      'DELETE /v9/projects/globex-website?teamId=team_1',
    ]);
  });

  it('leaves one no longer in our team, and records a refusal', async () => {
    const gone = vercel(404);
    expect(await deleteHostingProject(gone.w, 'globex-website')).toMatchObject({
      outcome: 'not_found',
    });
    expect(gone.calls).toHaveLength(1);
    expect(await deleteHostingProject(vercel(200, 403).w, 'globex-website')).toMatchObject({
      outcome: 'refused',
    });
  });

  it('throws on an outage', async () => {
    await expect(deleteHostingProject(vercel(500).w, 'globex-website')).rejects.toThrow(
      'Vercel answered 500',
    );
  });
});
