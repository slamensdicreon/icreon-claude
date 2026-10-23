/** What a tool server declares about each operation. The gateway's policy decisions read this. */
export interface OperationSpec {
  /** What the operation does, as the agent will read it in its tool definition. */
  description?: string;
  /** JSON Schema for the arguments; defaults to an open object. */
  inputSchema?: Record<string, unknown>;
  /** Changes state on the target. */
  mutates: boolean;
  /**
   * Release-affecting: publishes, deploys, or changes host settings. Risk tiers, from least to
   * most: read-only (`mutates: false`), scoped reversible write (`mutates`), release-affecting
   * (`releases`), destructive (`destructive`).
   */
  releases?: boolean;
  /** Deletes, clears Edge content, unlinks or revokes: needs a rollback recipe first. */
  destructive?: boolean;
  /** Returns content from outside our control (source site, repo files, web): wrapped as untrusted. */
  untrusted?: boolean;
  /** Dotted paths into the arguments that hold resource paths, checked against the role's scope. */
  pathArgs?: string[];
  /**
   * The items a write changes, for write locks, when they aren't simply the path arguments (a
   * create changes `parentPath/name`, not the parent).
   */
  lockPaths?: (args: Record<string, unknown>) => string[];
}

export type OperationCatalog = Record<string, OperationSpec>;

export interface ToolResult {
  /** HTTP-like status from the target system. */
  code: number;
  body: unknown;
  /** One plain line for the Activity log. */
  summary?: string;
}

/** What a server learns about a call besides its arguments. Never includes other secrets. */
export interface ToolCallContext {
  projectId: string;
  /** Gateway-minted, short-lived credential for this server. */
  token: string;
  role: string;
  taskId: string;
}

/** A tool server as the gateway sees it. MCP clients implement this; tests use fakes. */
export interface ToolServer {
  name: string;
  catalog: OperationCatalog;
  /**
   * Credential-scoped call. `token` is minted by the gateway for this run and never leaves it.
   * `target` names the external system instance (e.g. the client's tenant) for rate limiting.
   */
  call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult>;
  target(projectId: string): string;
}

/** Values bound per project into scope patterns: `{module}`, `{project}`, `{sitePath}`. */
export type Bindings = Record<string, string>;

export interface ToolCall {
  projectId: string;
  taskId: string;
  /** Position of this call in the task attempt; part of the idempotency key. */
  stepIndex: number;
  attempt: number;
  role: string;
  server: string;
  op: string;
  args: Record<string, unknown>;
}

export type Denial =
  | 'locked'
  | 'release_not_approved'
  | 'unknown_server'
  | 'unknown_operation'
  | 'not_allowed'
  | 'out_of_scope'
  | 'rollback_recipe_required';

export type GatewayResult =
  | { ok: true; code: number; body: unknown; replayed: boolean }
  | { ok: false; denied: Denial; message: string }
  | { ok: false; code: number; message: string; retryable: boolean };
