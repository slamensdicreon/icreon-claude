import { randomUUID } from 'node:crypto';
import type { EscalationType, LwEvent, NewEvent } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';

/** Cypher's voice: counts under thirteen in words. */
const WORDS = 'zero one two three four five six seven eight nine ten eleven twelve'.split(' ');
const word = (n: number) => (n >= 0 && n < 13 ? WORDS[n]! : String(n));
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
import type { EventStore, Projections } from '@lw/events';

/** What the operator told a Director, and why. */
export interface OperatorNotice {
  projectId: string;
  project: string;
  /** down/up: the worker itself, told by the watchdog (no project). */
  /** source: a heads-up that the source site is slowing or turning the team away. */
  kind: 'attention' | 'stalled' | 'review' | 'down' | 'up' | 'source';
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
  /** The project's workflow: whether it runs and its last failed steps, to say why it stalled. */
  health?: (projectId: string) => Promise<WorkflowHealth | null>;
}

/** What the operator reads of a project's workflow (see `workflowHealth` in the orchestrator). */
export interface WorkflowHealth {
  status: string;
  failures: { at: string | null; message: string | null }[];
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
    let stall = noticeFor(s, now, deps);
    // A stall is told with its cause: the workflow's own health, read only when one is due.
    if (stall?.kind === 'stalled' && deps.health)
      stall = noticeFor(s, now, deps, await deps.health(s.projectId).catch(() => null)) ?? stall;
    const notice =
      stall ??
      (deps.pendingReview
        ? reviewNotice(s, await deps.pendingReview(s.projectId).catch(() => null))
        : null);
    // A heads-up about the source site is told beside any other notice: it needs nothing of the
    // Director, it explains why things are slower.
    const recent = await (async () =>
      deps.store.read(s.projectId, { order: 'desc', limit: 400 }))().catch(() => [] as LwEvent[]);
    const notices = [notice, sourceNotice(s, recent, now)].filter(
      (n): n is OperatorNotice => n !== null,
    );
    for (const n of notices) {
      await deps.store.append(s.projectId, [message(n, s)]);
      await deps
        .notify?.(n)
        .catch((err: unknown) =>
          (deps.log ?? console.error)(`Operator notice for ${s.projectId} not sent`, err),
        );
      out.push(n);
    }
  }
  return out;
}

const HEADS_UP = 'Heads-up';
/** How far back a sweep looks at the source site's answers, and how long one heads-up holds. */
const SOURCE_WINDOW_MINUTES = 15;
const SOURCE_REPEAT_MINUTES = 60;

/**
 * Cypher's heads-up when the source site slows the team or turns it away, read from the browser's
 * recent answers: "too many requests" (it throttles us), a refusal (bot protection), or a crawl
 * that ran out of time (a large site). Nothing for the Director to decide here: it says why the
 * work is slower than usual. Each kind is told once an hour at most.
 */
export function sourceNotice(s: ProjectState, recent: LwEvent[], now: Date): OperatorNotice | null {
  const steps = recent.filter(
    (e): e is Extract<LwEvent, { type: 'step.recorded' }> =>
      e.type === 'step.recorded' &&
      e.data.toolServer === 'browser' &&
      minutes(e.ts, now) <= SOURCE_WINDOW_MINUTES,
  );
  // A background crawl reads the site on its own, so its 429s and refusals aren't steps: its
  // progress (crawl.status) says when the site throttles or refuses it, and when the site is large.
  const crawling = steps.filter((e) => e.data.operation.startsWith('crawl.'));
  const said = (re: RegExp) => crawling.some((e) => re.test(e.data.summary));
  const throttled =
    steps.filter((e) => e.data.resultCode === 429).length + (said(/is throttling us/) ? 2 : 0);
  const refused =
    steps.filter(
      (e) =>
        e.data.resultCode === 422 &&
        /refused our browser|answered HTTP 40[13]/.test(e.data.summary),
    ).length + (said(/found no page it could read|The site refused \d+ pages/) ? 2 : 0);
  const slow =
    steps.filter(
      (e) =>
        e.data.operation === 'crawl' &&
        (e.data.resultCode === 504 || /Stopped for time/.test(e.data.summary)),
    ).length + (said(/A large site/) ? 1 : 0);
  const site = siteName(s.sourceUrl);
  const told = (title: string) =>
    s.conversation.some(
      (c) =>
        c.label === HEADS_UP && c.title === title && minutes(c.ts, now) < SOURCE_REPEAT_MINUTES,
    );
  const heads = (title: string, body: string): OperatorNotice | null =>
    told(title) ? null : { projectId: s.projectId, project: s.name, kind: 'source', title, body };
  // The most telling first: a refusal stops Discovery, throttling and size only slow it.
  if (refused >= 2)
    return heads(
      `${site} is turning the team away`,
      `Just so you know: ${site} is refusing our browser (${word(refused)} pages answered "access denied" in the last ${SOURCE_WINDOW_MINUTES} minutes). That's the site's bot protection, not our access, and we don't try to get past it. If the team needs a page it can't read, save it from your own browser (Chrome or Edge: Save page as, "Webpage, Single File") and attach the .mhtml file here: the team then works from your copy.`,
    );
  if (throttled >= 2)
    return heads(
      `${site} is throttling the team`,
      `Just so you know: ${site} is throttling the team (it answered "too many requests" ${crawling.some((e) => /is throttling us/.test(e.data.summary)) ? 'repeatedly' : `${word(throttled)} times`} in the last ${SOURCE_WINDOW_MINUTES} minutes), so ${s.name} will take a little longer than usual. The team keeps going at the pace the site allows. Nothing for you to do.`,
    );
  if (slow >= 1)
    return heads(
      `${site} is a large site`,
      `Just so you know: ${site} is large, so the team is reading it in the background and working from its page templates. Discovery will take a little longer than usual. Nothing for you to do.`,
    );
  return null;
}

/** "paylocity.com" from the project's source URL, or "The source site". */
function siteName(url: string | null | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : 'The source site';
  } catch {
    return 'The source site';
  }
}

/** The one notice a project warrants now, or none: attention first, then a stall. */
export function noticeFor(
  s: ProjectState,
  now: Date,
  opts: Pick<OperatorDeps, 'attentionMinutes' | 'stallMinutes'> = {},
  health?: WorkflowHealth | null,
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
      title: `${due.length === 1 ? 'A decision waits' : `${cap(word(due.length))} decisions wait`} on you`,
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
    .map(([what, n]) => `${word(Number(n))} ${what}`);
  const running = count('running') + count('validating');
  return {
    projectId: s.projectId,
    project: s.name,
    kind: 'stalled',
    title: STALLED,
    body: `${s.name}: nothing has happened for ${Math.round(minutes(last, now))} minutes, with ${word(left.length)} task${left.length === 1 ? '' : 's'} left (${parts.join(', ')}) and nothing waiting on you. ${stallCause(s, health, last, running)}`,
  };
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;

/**
 * Why nothing moves, as far as the operator can tell: a workflow that stopped or fails every step
 * (an engineering fix), tasks waiting on a capability the team lacks (engineering, not a
 * decision), or, with neither, where to look.
 */
function stallCause(
  s: ProjectState,
  health: WorkflowHealth | null | undefined,
  since: string,
  running: number,
): string {
  if (health && health.status !== 'RUNNING')
    return `Its workflow is no longer running (${health.status.toLowerCase()}), so nothing starts until it is restarted: that needs engineering.`;
  const failing = health?.failures.find((f) => f.at && f.at >= since);
  if (failing)
    return `Its workflow fails every step it takes, since ${hhmm(failing.at!)}: "${clip(failing.message ?? 'no message', 300)}". That needs an engineering fix; cards and Resume won't answer until then.`;
  const gaps = Object.values(s.capabilityGaps ?? {}).filter(
    (g) => !g.closedAt && Object.keys(g.tasks).length,
  );
  if (gaps.length) {
    const waiting = gaps.reduce((n, g) => n + Object.keys(g.tasks).length, 0);
    return `${waiting} task${waiting === 1 ? ' waits' : 's wait'} on what the team can't do yet: ${gaps.map((g) => clip(g.capability, 120)).join('; ')}. That needs engineering (a tool or a permission), not a decision.`;
  }
  if (health)
    return running
      ? 'Its workflow is running and not failing, so an agent may be stuck in a long step: open Diagnostics in the project to see which.'
      : 'Its workflow is running and not failing, so a wait may have no task to end it: open Diagnostics in the project to see which.';
  return `${running ? "An agent may be hung, or the project's workflow may be failing" : "The project's workflow may be failing, or a wait may have no task to end it"}: open Diagnostics in the project to see which.`;
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
    body: `${s.name}: ${parts.join(' and ')} drafted from settled cards wait for your review. Open Knowledge, Review proposals: Cypher recommends approving, editing or rejecting each one, and you apply them in one go. Nothing applies to the next build until you do.`,
    proposals: total,
  };
}

const CHIEF = { kind: 'chief_of_staff', id: 'chief-of-staff' } as const;

function message(n: OperatorNotice, s: ProjectState): NewEvent {
  const headsUp = n.kind === 'source';
  return {
    type: 'cos.message',
    // A heads-up is Cypher talking to the Director; the other notices are the operator's.
    actor: headsUp ? CHIEF : SYSTEM,
    subject: { kind: 'project', id: s.projectId },
    severity: n.kind === 'stalled' ? 'warning' : 'notable',
    data: {
      messageId: randomUUID(),
      kind: 'text',
      title: n.title,
      body: n.body,
      label: headsUp ? HEADS_UP : LABEL,
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
