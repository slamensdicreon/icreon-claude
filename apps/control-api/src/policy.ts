import type { EscalationType, PolicyRow } from '@lw/contracts';
import type { Playbook } from '@lw/playbook-sdk';

const ORDER: EscalationType[] = ['blocker', 'access', 'decision', 'gate', 'budget', 'risk'];

const minutes = (window: string | undefined) => {
  const m = /^(\d+)([mh])$/.exec(window ?? '');
  return m ? Number(m[1]) * (m[2] === 'h' ? 60 : 1) : null;
};

/** The Settings escalation policy table, from the playbook's defaults. */
export function policyRows({ manifest }: Playbook): PolicyRow[] {
  const { escalationPolicy, escalationDeadlines } = manifest.defaults;
  return ORDER.filter((t) => escalationPolicy[t]).map((type) => {
    const p = escalationPolicy[type]!;
    return {
      type,
      defaultAfterMinutes: p.default ? minutes(escalationDeadlines[type]) : null,
      behaviour: p.behaviour,
      notifies: p.notifies,
    };
  });
}
