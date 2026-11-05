/*
 * What the Director can do to an escalation, wherever it is shown: choose, defer, resume, undo,
 * approve a gate (with the typed confirmation when the gate asks for one), send it back, or ask
 * Cypher about it. The keyboard (App), the Cypher sheet and Mission Control share these.
 */
import type { EscalationView } from '@lw/contracts';
import { post } from './api';
import { TypedConfirm } from '../overlays/Dialogs';
import { useApp } from '../state';

export const TYPE_LABEL: Record<string, string> = {
  decision: 'Decision',
  blocker: 'Blocker',
  access: 'Access',
  budget: 'Budget',
  risk: 'Risk',
  gate: 'Review',
};

export function useCardActions(x: EscalationView) {
  const { projectId, run, go, setLayout, setComposer, openOverlay, closeOverlay } = useApp();
  const base = `/projects/${projectId}`;
  return {
    /** Opens the card in Needs you, where decisions are made one at a time. */
    expand: () => go('inbox', { expanded: x.escalationId }),
    choose: (optionId: string, notes?: string) =>
      run(() =>
        post(`${base}/escalations/${x.escalationId}/resolve`, {
          optionId,
          ...(notes?.trim() ? { notes: notes.trim() } : {}),
          // A grouped card stands for its siblings: one answer for all of them.
          ...(x.group ? { all: true } : {}),
        }),
      ),
    defer: () =>
      run(() =>
        post(`${base}/escalations/${x.escalationId}/defer`, {
          until: new Date(Date.now() + 30 * 60_000).toISOString(),
        }),
      ),
    resume: () => run(() => post(`${base}/escalations/${x.escalationId}/resume`)),
    undo: () => run(() => post(`${base}/escalations/${x.escalationId}/undo`)),
    approve: (name: string) => {
      if (x.gate?.requiresConfirmation) {
        openOverlay(
          <TypedConfirm
            title={`Approve ${x.title}?`}
            body="This gate closes the engagement. Approval is final and cannot be undone."
            confirmLabel="Approve"
            typed={name}
            danger={false}
            onConfirm={() => {
              closeOverlay();
              void run(() =>
                post(`${base}/gates/${x.escalationId}/approve`, { confirmation: name }),
              );
            }}
          />,
        );
        return;
      }
      void run(() => post(`${base}/gates/${x.escalationId}/approve`, {}));
    },
    sendBack: (notes: string) =>
      run(() => post(`${base}/gates/${x.escalationId}/send-back`, { notes })),
    ask: () => {
      setComposer({ text: `About ${x.title}: `, about: x.escalationId, focus: true });
      setLayout({ dockOpen: true });
    },
  };
}
