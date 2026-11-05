/*
 * Who decides what: the gates, who settles each kind of question, the releases approved in
 * advance, the send-back limit, and what each kind of card does when nobody answers it.
 */
import type { AutonomyLevel, SettingsSnapshot } from '@lw/contracts';
import { put } from '../../lib/api';
import { stamp } from '../../lib/fmt';
import { useApp, useTz } from '../../state';
import { Select, Toggle } from '../../ui/cypher/forms';
import { Notice } from '../intake/shared';
import { Panel } from '../../ui/cypher/parts';
import {
  after,
  AUTONOMY_LEVELS,
  autonomyValue,
  levelName,
  policyTypeName,
  standingApprovalsValue,
} from './model';
import s from './settings.module.css';

const useSave = () => {
  const { projectId, run } = useApp();
  return (key: string, value: unknown) =>
    void run(() => put(`/projects/${projectId}/settings/${key}`, { value }));
};

/** Director gates where they stand; optional reviews switched on or off. */
export function GatesPanel({ gates }: { gates: SettingsSnapshot['gates'] }) {
  const tz = useTz();
  const save = useSave();
  return (
    <Panel title="Gates" padded>
      <div className={s.stack}>
        <p className={s.lead}>
          Director gates wait for you. The optional reviews add a stop of your own; switch them on
          or off.
        </p>
        <ul className={s.rows}>
          {gates.map((g) =>
            g.kind === 'director' ? (
              <li key={g.key} className={s.row}>
                <span className={s.rowText}>
                  <span className={s.strong}>{g.label}</span>
                </span>
                {g.state === 'approved' ? (
                  <Notice tone="ok">Approved{g.at ? ` ${stamp(g.at, tz)}` : ''}</Notice>
                ) : g.state === 'waiting' ? (
                  <Notice tone="bad">Waiting on you</Notice>
                ) : (
                  <Notice tone="idle">Phase {g.phase}</Notice>
                )}
              </li>
            ) : (
              <li key={g.key} className={s.row}>
                <Toggle
                  label={g.label}
                  hint={`Optional review · ${g.enabled ? 'on' : 'off'}`}
                  checked={!!g.enabled}
                  onChange={() => save(g.key, !g.enabled)}
                />
              </li>
            ),
          )}
        </ul>
      </div>
    </Panel>
  );
}

/** Who settles each kind of question before it reaches the Director. */
export function AutonomyPanel({ rows }: { rows: SettingsSnapshot['autonomy'] }) {
  const save = useSave();
  if (!rows.length) return null;
  return (
    <Panel title="Autonomy" meta="Who settles each kind of question">
      <p className={`${s.lead} ${s.sentence}`}>
        Before a question reaches you, the task’s Lead sees it. In shadow the Lead answers for the
        record and the card still comes to you, so the Scorecard can show how often you agree before
        you hand a kind of question to the Lead.
      </p>
      <ul className={`${s.rows} ${s.padRows}`}>
        {rows.map((r) => (
          <li key={r.category} className={s.row}>
            <span className={s.rowText}>
              <span className={s.strong}>{r.label}</span>
              {!r.locked && r.level !== r.default && (
                <span className={`${s.quiet} type-meta`}>Default: {levelName(r.default)}</span>
              )}
            </span>
            {r.locked ? (
              <span className={`${s.quiet} type-meta`}>Always you</span>
            ) : (
              <span className={s.selectCell}>
                <Select
                  aria-label={`Who settles ${r.label.toLowerCase()}`}
                  value={r.level}
                  onChange={(e) =>
                    save(
                      'autonomy',
                      autonomyValue(rows, r.category, e.target.value as AutonomyLevel),
                    )
                  }
                >
                  {AUTONOMY_LEVELS.map(([level, label]) => (
                    <option key={level} value={level}>
                      {label}
                    </option>
                  ))}
                </Select>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Release steps approved in advance: by the playbook, or by the Director here. */
export function StandingApprovalsPanel({ rows }: { rows: SettingsSnapshot['standingApprovals'] }) {
  const save = useSave();
  if (!rows.length) return null;
  return (
    <Panel title="Standing approvals" meta="Releases approved in advance" padded>
      <div className={s.stack}>
        <p className={s.lead}>
          An approved release runs without its card; the approval and its rollback go in the
          Decision Log. A remix of this project keeps these.
        </p>
        <ul className={s.rows}>
          {rows.map((r) => (
            <li key={r.id} className={s.row}>
              <Toggle
                label={r.title}
                hint={
                  r.byPlaybook
                    ? 'Approved by the playbook: it changes only this project’s own build'
                    : r.approved
                      ? 'Approved in advance'
                      : 'Ask me'
                }
                checked={r.approved}
                disabled={r.byPlaybook}
                onChange={() => save('standingApprovals', standingApprovalsValue(rows, r.id))}
              />
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/** What happens when a page has asked a component for fixes twice. */
export function SendBackPanel({ on }: { on: boolean }) {
  const save = useSave();
  return (
    <Panel title="Send-back limit" meta="After two rounds of fixes" padded>
      <div className={s.stack}>
        <p className={s.lead}>
          A page whose own work passed review finishes, and the component’s remaining differences go
          to the parity audit instead of a card. Turned off, the card comes to you.
        </p>
        <Toggle
          label="Finish past the send-back limit"
          hint={on ? 'Finish and hand on' : 'Ask me'}
          checked={on}
          onChange={() => save('finishPastLimit', !on)}
        />
      </div>
    </Panel>
  );
}

/** What each kind of card does when nobody answers it, and who hears about it. */
export function EscalationPolicyPanel({ rows }: { rows: SettingsSnapshot['escalationPolicy'] }) {
  return (
    <Panel title="Escalation policy">
      <p className={`${s.lead} ${s.sentence}`}>
        What each kind of card does when it isn’t answered, and how you hear about it.
      </p>
      <div className={s.tableWrap}>
        <table className={`${s.table} type-table`}>
          <thead>
            <tr>
              <th scope="col">Type</th>
              <th scope="col">Default action after</th>
              <th scope="col">Notifies</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.type}>
                <td className={s.strong}>{policyTypeName(r.type)}</td>
                <td>{after(r.defaultAfterMinutes, r.behaviour)}</td>
                <td className={s.muted}>{r.notifies}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
