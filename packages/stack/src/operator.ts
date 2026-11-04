import { randomUUID } from 'node:crypto';
import type { EscalationType, NewEvent } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';
import type { EventStore, Projections } from '@lw/events';

/** What the operator told a Director, and why. */
export interface OperatorNotice {
  projectId: string;
  project: string;
  kind: 'attention' | 'stalled' | 'review';
  title: string;
  body: string;
  /** The cards and gates the notice is about (attention notices). */
  needs?: { escalationId: string; type: EscalationType; title: string }[];
  /** How many proposals wait for review (review notices): told again only when it grows. */
  proposals?: number;
}

export interface OperatorDeps {
  projections: Projections;
  store: EventStore;
  /** Sends a notice beyond the app (email, a Slack-style webhook); absent: in the app only. */
  notify?: (n: OperatorNotice) => Promise<unknown>;
  /** Where a notice that couldn't be sent is reported (default console.error). */
  log?: (message: string, err?: unknown) => void;
  now?: () => Date;
  /** A card open this long without a Lead settling it reaches the Director (default 10 minutes). */
  attentionMinutes?: number;
  /** Nothing moving this long, with work left and nothing waiting on the Director: stalled (default 30). */
  stallMinutes?: number;
  /** Proposed rules and lessons from a project that wait for the Director's review. */
  pendingReview?: (projectId: string) => Promise<{ rules: number; lessons: number }>;
}

const LABEL = 'Operator';
const STALLED = 'Nothing has moved';
const SYSTEM = { kind: 'system', id: 'operator' } as const;
const SETTLED = new Set(['done', 'cancelled']);
const minutes = (from: string, to: Date) => (to.getTime() - Date.parse(from)) / 60_000;

/**
 * The project's operator: what Claude did by watching. Every few minutes it looks at each live,
 * running project and tells the Director, once, when something needs them (a card no Lead could
 * settle, a gate) or when nothing has moved for a while with nothing waiting on them (a failing
 * workflow, a hung agent, a wait no task can end). Notices land in the project's conversation,
 * and by email or webhook when those are set. Nothing is decided here: it only makes sure someone knows.
 */
export async function operatorSweep(deps: OperatorDeps): Promise<OperatorNotice[]> {
  const now = deps.now?.() ?? new Date();
  await deps.projections.catchUpAll();
  const out: OperatorNotice[] = [];
  for (const s of deps.projections.all()) {
    if (s.mode !== 'live' || s.status !== 'running') continue;
    const notice =
      noticeFor(s, now, deps) ??
      (deps.pendingReview
        ? reviewNotice(s, await deps.pendingReview(s.projectId).catch(() => null))
        : null);
    if (!notice) continue;
    await deps.store.append(s.projectId, [message(notice, s)]);
    await deps
      .notify?.(notice)
      .catch((err: unknown) =>
        (deps.log ?? console.error)(`Operator notice for ${s.projectId} not sent`, err),
      );
    out.push(notice);
  }
  return out;
}

/** The one notice a project warrants now, or none: attention first, then a stall. */
export function noticeFor(
  s: ProjectState,
  now: Date,
  opts: Pick<OperatorDeps, 'attentionMinutes' | 'stallMinutes'> = {},
): OperatorNotice | null {
  const attention = opts.attentionMinutes ?? 10;
  const stall = opts.stallMinutes ?? 30;
  const told = new Set(
    s.conversation
      .filter((c) => c.label === LABEL)
      .flatMap((c) => c.needs.map((n) => n.escalationId)),
  );
  const open = Object.values(s.escalations).filter((e) => e.status === 'open');
  const due = open.filter(
    (e) => !told.has(e.escalationId) && minutes(e.raisedAt, now) >= attention,
  );
  if (due.length)
    return {
      projectId: s.projectId,
      project: s.name,
      kind: 'attention',
      title: `${due.length === 1 ? 'A decision waits' : `${due.length} decisions wait`} on you`,
      body: `${s.name}: ${due.map((e) => e.title).join('; ')}. The Leads couldn't settle ${due.length === 1 ? 'it' : 'them'}; ${due.length === 1 ? 'its' : 'their'} work waits until you answer.`,
      needs: due.map((e) => ({ escalationId: e.escalationId, type: e.type, title: e.title })),
    };
  // A stall: work left, nothing waiting on the Director, and nothing has happened for a while.
  if (open.length) return null;
  const left = Object.values(s.tasks).filter((t) => !SETTLED.has(t.state));
  const last = s.latest[0]?.ts ?? s.startedAt;
  if (!left.length || !last || minutes(last, now) < stall) return null;
  // Once per stall: not again until something has happened since the last notice.
  const lastNotice = [...s.conversation]
    .reverse()
    .find((c) => c.label === LABEL && c.title === STALLED);
  if (lastNotice && Date.parse(lastNotice.ts) >= Date.parse(last)) return null;
  const count = (state: string) => left.filter((t) => t.state === state).length;
  const parts = [
    ['running', count('running') + count('validating')],
    ['ready', count('ready')],
    ['waiting on other tasks', count('waiting')],
    ['blocked', count('blocked')],
    ['not started', count('planned')],
  ]
    .filter(([, n]) => Number(n) > 0)
    .map(([what, n]) => `${n} ${what}`);
  const running = count('running') + count('validating');
  return {
    projectId: s.projectId,
    project: s.name,
    kind: 'stalled',
    title: STALLED,
    body: `${s.name}: nothing has happened for ${Math.round(minutes(last, now))} minutes, with ${left.length} task${left.length === 1 ? '' : 's'} left (${parts.join(', ')}) and nothing waiting on you. ${running ? "An agent may be hung, or the project's workflow may be failing" : "The project's workflow may be failing, or a wait may have no task to end it"}: open Diagnostics in the project to see which.`,
  };
}

/**
 * What the team proposes to learn from the project's cards, waiting on the Director: told once,
 * and again only when there is more than last time.
 */
export function reviewNotice(
  s: ProjectState,
  pending: { rules: number; lessons: number } | null,
): OperatorNotice | null {
  const total = (pending?.rules ?? 0) + (pending?.lessons ?? 0);
  if (!pending || !total) return null;
  const told = Math.max(
    0,
    ...s.conversation
      .filter((c) => c.label === LABEL)
      .map((c) => Number(c.rows.find((r) => r.label === 'proposals')?.value ?? 0)),
  );
  if (total <= told) return null;
  const parts = [
    pending.rules ? `${pending.rules} rule${pending.rules === 1 ? '' : 's'}` : '',
    pending.lessons ? `${pending.lessons} lesson${pending.lessons === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return {
    projectId: s.projectId,
    project: s.name,
    kind: 'review',
    title: 'The team proposes what to learn',
    body: `${s.name}: ${parts.join(' and ')} drafted from settled cards wait for your review (Rules; Lessons learned). Approved, they settle the same questions next time without a card.`,
    proposals: total,
  };
}

function message(n: OperatorNotice, s: ProjectState): NewEvent {
  return {
    type: 'cos.message',
    actor: SYSTEM,
    subject: { kind: 'project', id: s.projectId },
    severity: n.kind === 'stalled' ? 'warning' : 'notable',
    data: {
      messageId: randomUUID(),
      kind: 'text',
      title: n.title,
      body: n.body,
      label: LABEL,
      needs: n.needs ?? [],
      rows: n.proposals ? [{ label: 'proposals', value: String(n.proposals) }] : [],
    },
  } as NewEvent;
}

/**
 * Several notifiers as one: each gets every notice; one failing doesn't stop the others, and the
 * failures are reported together.
 */
export function notifyAll(
  notifiers: ((n: OperatorNotice) => Promise<unknown>)[],
): ((n: OperatorNotice) => Promise<void>) | undefined {
  if (!notifiers.length) return undefined;
  return async (n) => {
    const failed = (await Promise.allSettled(notifiers.map((f) => f(n)))).filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failed.length)
      throw new Error(
        failed.map((r) => (r.reason as Error)?.message ?? String(r.reason)).join('; '),
      );
  };
}

/** A webhook notifier: posts `{ text }`, which Slack incoming webhooks and most chat tools accept. */
export function webhookNotifier(url: string, fetchImpl: typeof fetch = fetch) {
  return async (n: OperatorNotice) => {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `*${n.title}*: ${n.body}` }),
      signal: AbortSignal.timeout(10_000),
    });
  };
}
