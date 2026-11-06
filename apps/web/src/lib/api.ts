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

/** What to tell the Director about a failure: the API's own words, or the fallback. */
export const messageOf = (err: unknown, fallback: string): string =>
  err instanceof ApiProblem ? err.message : fallback;

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
    // The API's shape is { error: { code, message } }; a few routes answer { error, message }.
    const err = (await res.json().catch(() => null)) as
      ApiError | { error?: string; message?: string } | null;
    const nested = err && typeof err.error === 'object' ? (err as ApiError).error : null;
    const flat =
      err && typeof err.error !== 'object' ? (err as { error?: string; message?: string }) : null;
    throw new ApiProblem(
      res.status,
      nested?.code ?? flat?.error ?? 'http_' + res.status,
      nested?.message ?? flat?.message ?? `The Control API answered ${res.status}.`,
    );
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export const get = <T>(path: string) => call<T>('GET', path);
export const post = (path: string, body: unknown = {}) => call<CommandResult>('POST', path, body);
export const put = (path: string, body: unknown) => call<CommandResult>('PUT', path, body);
export const del = (path: string) => call<CommandResult>('DELETE', path);
/** A POST whose answer is a resource rather than a command result. */
export const postFor = <T>(path: string, body: unknown) => call<T>('POST', path, body);

/** A project's blob reference (`blob://<project>/<key>`) as a URL the browser can load. */
export function blobUrl(projectId: string, ref: string): string {
  const prefix = `blob://${projectId}/`;
  const key = ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
  // Only a plain key inside the project's folder: never "..", which the browser would resolve to
  // another route of the app.
  if (key === null || key.split('/').some((p) => p === '..' || p === '.' || p === '')) return '#';
  return `${API}/projects/${projectId}/blobs/${key.split('/').map(encodeURIComponent).join('/')}`;
}
