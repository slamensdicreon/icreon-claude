import { createHash, randomUUID } from 'node:crypto';
import type { NewEvent, Severity } from '@lw/contracts';
import type { EventStore } from '@lw/events';
import type { Playbook, ToolGrant } from '@lw/playbook-sdk';
import { heuristicDetector, redact, wrapUntrusted, type InjectionDetector } from './sanitize';
import { inScope, readArg, ScopeError } from './scope';
import type { CredentialProvider, IdempotencyStore, RateLimiter, RollbackRegistry } from './stores';
import type {
  Bindings,
  Denial,
  GatewayResult,
  OperationSpec,
  ToolCall,
  ToolResult,
  ToolServer,
} from './types';

export interface GatewayDeps {
  playbook: Playbook;
  servers: ToolServer[];
  bindings: (projectId: string) => Bindings;
  credentials: CredentialProvider;
  idempotency: IdempotencyStore;
  rollback: RollbackRegistry;
  limiter: RateLimiter;
  store: EventStore;
  detector?: InjectionDetector;
  /** Called when fetched content looks like an injection attempt (raise a Risk escalation). */
  onInjection?: (call: ToolCall, reason: string) => Promise<void>;
  now?: () => number;
}

/**
 * The single policy enforcement point between agents and the systems they change. Every call is
 * authorized against the role's grant and resource scope, rate-limited per target, made idempotent,
 * given a credential the agent never sees, sanitized on the way back, and recorded as a Step.
 * Prompts can ask for anything; only this decides.
 */
export class ToolGateway {
  private readonly servers: Map<string, ToolServer>;
  private readonly grants: Map<string, Record<string, ToolGrant>>;
  private readonly detector: InjectionDetector;
  private readonly now: () => number;

  constructor(private readonly deps: GatewayDeps) {
    this.servers = new Map(deps.servers.map((s) => [s.name, s]));
    this.grants = new Map(deps.playbook.roles.map((r) => [r.role, r.tools]));
    this.detector = deps.detector ?? heuristicDetector;
    this.now = deps.now ?? Date.now;
  }

  /** Requests the role may make, for tool definitions shown to the agent (it never sees others). */
  allowedOperations(role: string): { server: string; op: string }[] {
    return Object.entries(this.grants.get(role) ?? {}).flatMap(([server, grant]) =>
      grant.ops.filter((op) => this.servers.get(server)?.catalog[op]).map((op) => ({ server, op })),
    );
  }

  operation(server: string, op: string): OperationSpec | undefined {
    return this.servers.get(server)?.catalog[op];
  }

  async call(call: ToolCall): Promise<GatewayResult> {
    const started = this.now();
    const requestHash = hashRequest(call);

    const denial = await this.authorize(call);
    if (denial) {
      await this.record(
        call,
        requestHash,
        403,
        started,
        `Denied (${denial.denied}): ${denial.message}`,
        'failure',
      );
      return denial;
    }
    const server = this.servers.get(call.server)!;
    const spec = server.catalog[call.op]!;

    const key = `${call.projectId}:${call.taskId}:${call.attempt}:${call.stepIndex}:${requestHash}`;
    const recorded = await this.deps.idempotency.get(key);
    if (recorded) return { ok: true, code: recorded.code, body: recorded.body, replayed: true };

    await this.deps.limiter.acquire(`${server.name}:${server.target(call.projectId)}`);
    const token = await this.deps.credentials.tokenFor(call.projectId, server.name);

    let result: ToolResult;
    try {
      result = await server.call(call.op, call.args, { projectId: call.projectId, token });
    } catch (err) {
      const message = redactText(err instanceof Error ? err.message : String(err), token);
      await this.record(
        call,
        requestHash,
        502,
        started,
        `${call.server} unreachable: ${message}`,
        'failure',
      );
      return {
        ok: false,
        code: 502,
        message: `${call.server} is unreachable: ${message}`,
        retryable: true,
      };
    }

    let body = redact(result.body, [token]);
    const summary = redactText(result.summary ?? `${call.server}.${call.op}`, token);

    if (result.code >= 400) {
      const retryable = result.code === 429 || result.code >= 500;
      const message =
        result.code === 401 || result.code === 403
          ? `${call.server} returned ${result.code} for ${call.op}. Re-verify the credential's scope in Settings.`
          : `${call.server} returned ${result.code} for ${call.op}.`;
      await this.record(call, requestHash, result.code, started, message, 'failure');
      return { ok: false, code: result.code, message, retryable };
    }

    let severity: Severity = spec.mutates ? 'notable' : 'routine';
    let line = summary;
    if (spec.untrusted) {
      const verdict = await this.detector.scan(JSON.stringify(body));
      if (verdict.flagged) {
        body = {
          quarantined: true,
          reason: verdict.reason,
          note: 'Content withheld: it looks like instructions aimed at the agent. A Risk was raised for review.',
        };
        severity = 'warning';
        line = `${summary} (quarantined: ${verdict.reason})`;
        await this.deps.onInjection?.(call, verdict.reason ?? 'suspected injection');
      } else {
        body = wrapUntrusted(call.server, call.op, body);
      }
    }

    await this.deps.idempotency.put(key, { code: result.code, body, summary: line });
    await this.record(call, requestHash, result.code, started, line, severity);
    return { ok: true, code: result.code, body, replayed: false };
  }

  private async authorize(
    call: ToolCall,
  ): Promise<(GatewayResult & { ok: false; denied: Denial }) | null> {
    const deny = (denied: Denial, message: string) => ({ ok: false as const, denied, message });
    const server = this.servers.get(call.server);
    if (!server) return deny('unknown_server', `No tool server "${call.server}".`);
    const spec = server.catalog[call.op];
    if (!spec) return deny('unknown_operation', `${call.server} has no operation "${call.op}".`);
    const grant = this.grants.get(call.role)?.[call.server];
    if (!grant || !grant.ops.includes(call.op)) {
      return deny('not_allowed', `${call.role} may not call ${call.server}.${call.op}.`);
    }
    if (grant.scope && spec.pathArgs?.length) {
      const bindings = this.deps.bindings(call.projectId);
      for (const arg of spec.pathArgs) {
        const values = readArg(call.args, arg);
        if (!values.length)
          return deny('out_of_scope', `${call.op} needs "${arg}" to check its scope.`);
        for (const v of values) {
          try {
            if (!inScope(String(v), grant.scope.paths, bindings)) {
              return deny('out_of_scope', `${String(v)} is outside ${call.role}'s scope.`);
            }
          } catch (e) {
            if (e instanceof ScopeError) return deny('out_of_scope', `${String(v)}: ${e.message}.`);
            throw e;
          }
        }
      }
    }
    if (spec.destructive && !(await this.deps.rollback.hasRecipe(call.projectId, call.taskId))) {
      return deny(
        'rollback_recipe_required',
        `${call.op} is destructive; record the task's rollback recipe first.`,
      );
    }
    return null;
  }

  private async record(
    call: ToolCall,
    requestHash: string,
    code: number,
    started: number,
    summary: string,
    severity: Severity,
  ) {
    const event: NewEvent = {
      type: 'step.recorded',
      actor: { kind: 'agent', id: call.role },
      subject: { kind: 'step', id: randomUUID() },
      severity,
      data: {
        stepId: randomUUID(),
        agentId: call.role,
        taskId: call.taskId,
        toolServer: call.server,
        operation: call.op,
        resultCode: code,
        durationMs: Math.max(0, Math.round(this.now() - started)),
        tokens: 0,
        summary,
        requestHash,
      },
    };
    await this.deps.store.append(call.projectId, [event]);
  }
}

/** sha256 over server, operation and canonical (key-sorted) arguments. */
export function hashRequest(call: Pick<ToolCall, 'server' | 'op' | 'args'>): string {
  return createHash('sha256')
    .update(`${call.server}\n${call.op}\n${canonical(call.args)}`)
    .digest('hex');
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function redactText(s: string, token: string) {
  return redact(s, [token]) as string;
}
