import { randomUUID } from 'node:crypto';
import type { EscalationType, NewEvent } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';
import type { EventStore, Projections } from '@lw/events';

/** What the operator told a Director, and why. */
export interface OperatorNotice {
  projectId: string;
  project: string;
  kind: 'attention' | 'stalled';
  title: string;
  body: string;
  /** The cards and gates the notice is about (attention notices). */
  needs?: { escalationId: string; type: EscalationType; title: string }[];
}

export interface OperatorDeps {
  projections: Projections;
  store: EventStore;
  /** Sends a notice beyond the app (a Slack-style webhook); absent: in the app only. */
  notify?: (n: OperatorNotice) => Promise<void>;
  now?: () => Date;
  /** A card open this long without a Lead settling it reaches the Director (default 10 minutes). */
  attentionMinutes?: number;
  /** Nothing moving this long, with work left and nothing waiting on the Director: stalled (default 30). */
  stallMinutes?: number;
}

const LABEL = 'Operator';
const SYSTEM = { kind: 'system', id: 'operator' } as const;
const SETTLED = new Set(['done', 'cancelled']);
const minutes = (from: string, to: Date) => (to.getTime() - Date.parse(from)) / 60_000;

/**
 * The project's operator: what Claude did by watching. Every few minutes it looks at each live,
 * running project and tells the Director, once, when something needs them (a card no Lead could
 * settle, a gate) or when nothing has moved for a while with nothing waiting on them (a failing
 * workflow, a hung agent, a wait no task can end). Notices land in the project's conversation,
 * and on the webhook when one is set. Nothing is decided here: it only makes sure someone knows.
 */
export async function operatorSweep(deps: OperatorDeps): Promise<OperatorNotice[]> {
  const now = deps.now?.() ?? new Date();
  await deps.projections.catchUpAll();
  const out: OperatorNotice[] = [];
  for (const s of deps.projections.all()) {
    if (s.mode !== 'live' || s.status !== 'running') continue;
    const notice = noticeFor(s, now, deps);
    if (!notice) continue;
    await deps.store.append(s.projectId, [message(notice, s)]);
    await deps.notify?.(notice).catch(() => undefined);
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
    .find((c) => c.label === LABEL && !c.needs.length);
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
    title: 'Nothing has moved',
    body: `${s.name}: nothing has happened for ${Math.round(minutes(last, now))} minutes, with ${left.length} task${left.length === 1 ? '' : 's'} left (${parts.join(', ')}) and nothing waiting on you. ${running ? "An agent may be hung, or the project's workflow may be failing" : "The project's workflow may be failing, or a wait may have no task to end it"}: open Diagnostics in the project to see which.`,
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
    },
  } as NewEvent;
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
