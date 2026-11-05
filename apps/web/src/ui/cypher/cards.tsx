/*
 * What a card that is the Director's says and does, for both modes and any project: its kind word,
 * its clock, its type pill hue, and its two actions. Labels here are the product's labels (Decide,
 * Approve, Grant); Cypher's sentences (the verdict and why) come from the API.
 */
import type { EscalationView } from '@lw/contracts';
import { post } from '../../lib/api';
import { clock } from '../../lib/fmt';
import { TypedConfirm } from '../../overlays/Dialogs';
import { useApp, type Surface } from '../../state';
import { hueOf, type CardAction } from './parts';

/** The kind of thing it is, as a verb (Bliss label, Everything pill). */
export const KIND: Record<string, string> = {
  decision: 'Decide',
  gate: 'Approve',
  access: 'Grant',
  blocker: 'Unblock',
  budget: 'Budget',
  risk: 'Risk',
};
/** The one action a Needs-you row offers. */
const ROW_ACTION: Record<string, string> = {
  decision: 'Choose',
  gate: 'Review',
  access: 'Grant',
  blocker: 'Unblock',
  budget: 'Review',
  risk: 'Review',
};
const WORKSTREAM: Record<string, string> = {
  discovery: 'Discovery',
  engineering: 'Engineering',
  content: 'Content',
  quality: 'Quality',
};

export const kindOf = (x: EscalationView) => KIND[x.type] ?? 'Decide';
/** The Everything pill: the gate's own label ("Gate 1") or the kind. */
export const pillOf = (x: EscalationView) =>
  x.type === 'gate' && x.typeLabel ? x.typeLabel : kindOf(x);
/** The pill's color: the team that raised it; a gate is ink. */
export const pillHue = (x: EscalationView) =>
  x.type === 'gate' ? 'var(--ink)' : hueOf(x.raisedBy?.workstream ?? null);

/** "2:24" or "No clock". */
export const clockOf = (x: EscalationView, tz: string) =>
  x.deadline ? clock(x.deadline, tz) : 'No clock';

/** "2 h 42 m, then A" or "No clock": time left and what happens. */
export function leftOf(x: EscalationView, now: number): string {
  if (!x.deadline) return 'No clock';
  const ms = Math.max(0, new Date(x.deadline).getTime() - now);
  const m = Math.round(ms / 60_000);
  const t = m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m` : `${m} min`;
  const i = x.options.findIndex((o) => o.id === x.defaultOptionId);
  const key = i >= 0 ? (x.options[i]!.key ?? String.fromCharCode(65 + i)) : null;
  return key ? `${t}, then ${key}` : t;
}

/** "Raised by Aisha, Discovery · 4 min ago". */
export function raisedLine(x: EscalationView, ago: string): string {
  const r = x.raisedBy;
  const verb = x.type === 'gate' ? 'Signed off by' : 'Raised by';
  if (!r) return `Raised ${ago}`;
  const team = r.workstream ? `, ${WORKSTREAM[r.workstream]}` : '';
  return `${verb} ${r.firstName}${team} · ${ago}`;
}

/** The option Cypher would pick, then the other one. */
export function picks(x: EscalationView) {
  const pickId =
    x.recommendation?.pick ?? x.options.find((o) => o.recommended)?.id ?? x.options[0]?.id ?? null;
  const pick = x.options.find((o) => o.id === pickId) ?? null;
  const other = x.options.find((o) => o.id !== pickId) ?? null;
  return { pick, other };
}

/**
 * The actions on a card, for any project (the Dashboard isn't inside one). `after` refreshes the
 * caller's data once a command lands.
 */
export function useYoursActions(projectId: string, projectName: string, after?: () => void) {
  const { run, switchProject, go, projectId: current, openOverlay, closeOverlay } = useApp();
  const base = `/projects/${projectId}`;
  const done = (ok: boolean) => {
    if (ok) after?.();
  };
  const open = (surface: Surface, patch?: { expanded: string }) => {
    if (current !== projectId) switchProject(projectId);
    go(surface, current === projectId ? patch : undefined);
  };
  // Undo, from a toast: the server keeps a short window in which a settled card can be taken back.
  const undoAction = (x: EscalationView) => ({
    label: 'Undo',
    run: () =>
      void run(() => post(`${base}/escalations/${x.escalationId}/undo`), {
        title: 'Undone',
        detail: `${x.title} is back with you.`,
      }).then(done),
  });
  const resolve = (x: EscalationView, optionId: string) => {
    const chose = x.options.find((o) => o.id === optionId)?.label;
    void run(
      () =>
        post(`${base}/escalations/${x.escalationId}/resolve`, {
          optionId,
          ...(x.group ? { all: true } : {}),
        }),
      {
        title: x.group ? `Answered for ${x.group.taskIds.length}` : 'Answered',
        detail: chose ? `${x.title}: ${chose}` : x.title,
        action: undoAction(x),
      },
    ).then(done);
  };
  const defer = (x: EscalationView) =>
    void run(
      () =>
        post(`${base}/escalations/${x.escalationId}/defer`, {
          until: new Date(Date.now() + 30 * 60_000).toISOString(),
        }),
      { title: 'Deferred for half an hour', detail: x.title, tone: 'info' },
    ).then(done);
  const approve = (x: EscalationView) => {
    if (x.gate?.requiresConfirmation) {
      openOverlay(
        <TypedConfirm
          title={`Approve ${x.title}?`}
          body="This gate closes the engagement. Approval is final and cannot be undone."
          confirmLabel="Approve"
          typed={projectName}
          danger={false}
          onConfirm={() => {
            closeOverlay();
            void run(
              () => post(`${base}/gates/${x.escalationId}/approve`, { confirmation: projectName }),
              { title: 'Approved', detail: x.title },
            ).then(done);
          }}
        />,
      );
      return;
    }
    void run(() => post(`${base}/gates/${x.escalationId}/approve`, {}), {
      title: 'Approved',
      detail: `${x.title}. The team carries on.`,
    }).then(done);
  };

  /**
   * The card's primary and secondary actions, as the Yours card shows them. A gate offers "Read it"
   * from the Dashboard and "Approve" / "Send back" inside its project (Mission Control board).
   */
  const cardActions = (
    x: EscalationView,
    where: 'portfolio' | 'project' = 'portfolio',
  ): { primary: CardAction; secondary: CardAction | null } => {
    if (x.type === 'gate')
      return where === 'portfolio'
        ? {
            primary: { label: 'Read it', run: () => open('workbench') },
            secondary: {
              label: 'Approve now',
              run: () => approve(x),
              leaves: !x.gate?.requiresConfirmation,
            },
          }
        : {
            primary: {
              label: 'Approve',
              run: () => approve(x),
              leaves: !x.gate?.requiresConfirmation,
            },
            secondary: {
              label: 'Send back',
              run: () => open('inbox', { expanded: x.escalationId }),
            },
          };
    const { pick, other } = picks(x);
    if (!pick)
      return {
        primary: { label: 'Open', run: () => open('inbox', { expanded: x.escalationId }) },
        secondary: null,
      };
    return {
      primary: { label: pick.label, run: () => resolve(x, pick.id), leaves: true },
      secondary: other
        ? { label: other.label, run: () => resolve(x, other.id), leaves: true }
        : { label: 'Later', run: () => defer(x), leaves: true },
    };
  };

  /** The one action on a Needs-you row: open it where it's decided. */
  const rowAction = (x: EscalationView): CardAction => ({
    label: ROW_ACTION[x.type] ?? 'Open',
    run: () => open('inbox', { expanded: x.escalationId }),
  });

  const resume = (x: EscalationView) =>
    void run(() => post(`${base}/escalations/${x.escalationId}/resume`), {
      title: 'Back in the queue',
      detail: x.title,
      tone: 'info',
    }).then(done);
  const undo = (x: EscalationView) =>
    void run(() => post(`${base}/escalations/${x.escalationId}/undo`), {
      title: 'Undone',
      detail: `${x.title} is back with you.`,
    }).then(done);
  const sendBack = (x: EscalationView, notes: string) =>
    void run(() => post(`${base}/gates/${x.escalationId}/send-back`, { notes }), {
      title: 'Sent back',
      detail: `${x.title}, with your notes.`,
    }).then(done);

  return { cardActions, rowAction, resolve, defer, approve, open, resume, undo, sendBack };
}
