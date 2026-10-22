import type { AgentView, LinkTarget } from '@lw/contracts';
import { whoize } from '../lib/fmt';
import { useApp, useRoster, type Surface } from '../state';

const STATE_LABEL: Record<string, string> = {
  idle: 'Idle',
  active: 'Active',
  waiting: 'Waiting',
  blocked: 'Blocked',
  failed: 'Failed',
  done: 'Done',
  rolled_back: 'Rolled back',
  rolledback: 'Rolled back',
  inactive: 'Not in this phase',
  paused: 'Paused',
  planned: 'Planned',
  ready: 'Ready',
  running: 'Running',
  validating: 'Validating',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

/** Chip class for a state (task states map onto the prototype's chip set). */
const CHIP_CLASS: Record<string, string> = {
  validating: 'running',
  rejected: 'waiting',
  rolled_back: 'rolledback',
  cancelled: 'inactive',
};

export function Chip({ state, label }: { state: string; label?: string }) {
  return (
    <span className={`chip ${CHIP_CLASS[state] ?? state}`}>
      {label ?? STATE_LABEL[state] ?? state}
    </span>
  );
}

/** Prose with role names shown as people (first name, full name and role on hover). */
export function Who({ text }: { text: string }) {
  const { agents } = useRoster();
  return (
    <>
      {whoize(text, agents).map((m, i) =>
        m.title ? (
          <span key={i} className="pref" title={m.title}>
            {m.text}
          </span>
        ) : (
          <span key={i}>{m.text}</span>
        ),
      )}
    </>
  );
}

/** "Emily Chen / Component Engineer", or the actor in words when it is not an agent. */
export function AgentCell({ agentId, actorId }: { agentId: string | null; actorId?: string }) {
  const { byId } = useRoster();
  const a = byId(agentId);
  if (a)
    return (
      <>
        <b style={{ fontWeight: 500 }}>{a.persona ?? a.name}</b>
        <div className="muted" style={{ fontSize: 12 }}>
          {a.tier === 'chief_of_staff' ? 'Chief of Staff' : a.name}
        </div>
      </>
    );
  const who = actorId ?? agentId;
  return (
    <>
      {who === 'director'
        ? 'You'
        : who === 'tool-server' || who === 'system'
          ? 'Tool server'
          : (who ?? '–')}
    </>
  );
}

export function personOf(a: AgentView | undefined): string {
  return a ? (a.persona ?? a.name) : '';
}

/** Follows a jump link from a message, card or brief. */
export function useJump() {
  const { go, inspect, toast } = useApp();
  return (t: LinkTarget) => {
    switch (t.kind) {
      case 'artifact':
        return go('workbench', { wbArtifact: t.ref });
      case 'decision':
        return go('workbench', { wbArtifact: 'decisions' });
      case 'agent':
        go('team');
        return inspect('agent', t.ref);
      case 'task':
        go('plan');
        return inspect('task', t.ref);
      case 'activity':
        return go('activity', { activity: { sev: 'all', agent: 'all' } });
      case 'preview':
        return go('preview', t.ref ? { previewPage: t.ref } : undefined);
      case 'settings':
        return go('settings');
      case 'surface':
        return go(t.ref as Surface);
      case 'external':
      case 'page_builder':
      case 'delivery_host':
      case 'pull_request':
        if (/^https?:\/\//.test(t.ref)) return void window.open(t.ref, '_blank', 'noopener');
        return toast('That system opens from the project’s own links once it is connected.');
      default:
        return go('activity');
    }
  };
}
