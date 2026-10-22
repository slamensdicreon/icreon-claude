/**
 * A Director command the orchestrator refused (or that a runner cannot do: 501, or is not there to
 * take: 503), surfaced by the API with a message that names the problem and the next step.
 */
export class CommandError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 501 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
