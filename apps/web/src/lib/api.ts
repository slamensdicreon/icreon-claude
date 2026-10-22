import type { ApiError, CommandResult } from '@lw/contracts';

/** The Control API's origin. Empty: the same origin (Vite proxies in development). */
export const API = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

/** A refusal from the API, with the message written for the Director. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API + path, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    location.assign(`${API}/auth/login?returnTo=${encodeURIComponent(location.href)}`);
    throw new ApiProblem(401, 'unauthenticated', 'Signing you in…');
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiProblem(
      res.status,
      err?.error.code ?? 'http_' + res.status,
      err?.error.message ?? `The Control API answered ${res.status}.`,
    );
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export const get = <T>(path: string) => call<T>('GET', path);
export const post = (path: string, body: unknown = {}) => call<CommandResult>('POST', path, body);
export const put = (path: string, body: unknown) => call<CommandResult>('PUT', path, body);

/** A project's blob reference (`blob://<project>/<key>`) as a URL the browser can load. */
export function blobUrl(projectId: string, ref: string): string {
  const prefix = `blob://${projectId}/`;
  return ref.startsWith(prefix)
    ? `${API}/projects/${projectId}/blobs/${ref.slice(prefix.length)}`
    : ref;
}
