/**
 * A Director command the orchestrator refused, surfaced by the API as a 4xx whose message names
 * the problem and the next step.
 */
export class CommandError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
