/** A response body as JSON when it parses, else its text. */
export async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * A request with the config's timeout: the status and body, or why it never answered (a timeout,
 * or the host unreachable), worded for the Director.
 */
export async function timedCall(
  cfg: { fetch: typeof fetch; timeoutMs: number },
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const res = await cfg.fetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs) });
    return { status: res.status, body: await readBody(res) };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return {
      error:
        name === 'TimeoutError'
          ? `${new URL(url).host} did not answer within ${cfg.timeoutMs / 1000} s.`
          : `${new URL(url).host} could not be reached.`,
    };
  }
}
