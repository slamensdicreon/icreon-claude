import type { ToolResult } from './types';

/** A call a tool server refuses: the reason, as the error the agent reads and the step's summary. */
export const rejected = (message: string, code = 422): ToolResult => ({
  code,
  body: { error: message },
  summary: message,
});

/** The branches agents work on in a build repository: launchworks/<task>. */
export const AGENT_BRANCH = /^launchworks\/[A-Za-z0-9._/-]{1,100}$/;

/** The branch accepted components are integrated on; its preview is the editing host. */
export const INTEGRATION_BRANCH = 'launchworks/integration';
