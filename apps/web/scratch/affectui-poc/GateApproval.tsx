import type { EscalationView } from '@lw/contracts';
import { Icon } from '../../src/lib/icons';
import { ApprovalCard, type ApprovalRisk } from './vendor/approval-card';

/**
 * A gate escalation (type "gate") as affectUI's Approval Card, themed by icreon-affectui.css.
 * The proof of concept for docs/reference/affectui-evaluation.md: not wired into the app.
 *
 * What maps: title, context, impact, evidence and the gate's artifact go into the preview;
 * Approve stays Approve; "Send back with notes" takes the Deny slot; "Ask a question" takes Edit.
 * What doesn't: the typed confirmation of a final gate stays our TypedConfirm, opened from
 * onApprove (the card waits on the promise); "Always allow" is off, because a gate never is.
 *
 * Keys: the card denies on Esc, but Esc is the app's "close" (App.tsx useKeys) and must never send
 * a gate back. The wrapper swallows Esc before the card sees it, and the hints are hidden; ⌘↵
 * still approves, next to our own A.
 */
export function GateApproval({
  x,
  about,
  status,
  onApprove,
  onSendBack,
  onAsk,
}: {
  x: EscalationView;
  about?: { task: string | null; who: string | null };
  /** Controlled, from the escalation's status: the server decides when it is resolved. */
  status?: 'pending' | 'approved' | 'denied';
  onApprove: () => Promise<unknown>;
  onSendBack: () => void;
  onAsk: () => void;
}) {
  // Risk comes from the action, not the model: a gate that closes the engagement is high.
  const risk: ApprovalRisk = x.gate?.requiresConfirmation ? 'high' : 'medium';
  const details = [
    ...(x.gate
      ? [{ label: 'Approves', value: `Phase ${x.gate.phase} artifact, v${x.gate.artifactVersion}` }]
      : []),
    ...(about?.who ? [{ label: 'From', value: about.who }] : []),
    ...(about?.task ? [{ label: 'About', value: about.task }] : []),
    { label: 'Impact', value: x.impact },
    ...(x.evidence.length
      ? [{ label: 'Evidence', value: x.evidence.map((e) => e.label).join(' · ') }]
      : []),
  ];
  return (
    <div
      style={{ display: 'contents' }}
      onKeyDownCapture={(e) => {
        if (e.key === 'Escape') e.stopPropagation();
      }}
    >
      <ApprovalCard
        title={x.title}
        description={x.waitNote ?? 'Waits for you. No default action.'}
        label={x.typeLabel ?? 'Review'}
        risk={risk}
        icon={<Icon name="milestone" sm />}
        preview={<p style={{ margin: 0 }}>{x.context}</p>}
        details={details}
        status={status}
        allowAlways={false}
        approveLabel="Approve"
        denyLabel="Send back"
        editLabel="Ask a question"
        onApprove={onApprove}
        onDeny={onSendBack}
        onEdit={onAsk}
        shortcuts={false}
      />
    </div>
  );
}
