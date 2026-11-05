/*
 * The record: the conventions the team builds by (locked at Gate 1), and what the agents' tools
 * couldn't do, with the tasks waiting on each gap.
 */
import type { SettingsSnapshot } from '@lw/contracts';
import { post } from '../../lib/api';
import { stamp } from '../../lib/fmt';
import { useApp, useTz } from '../../state';
import { Facts } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Action, Notice } from '../intake/shared';
import s from './settings.module.css';

export function ConventionsPanel({
  conventions,
}: {
  conventions: SettingsSnapshot['conventions'];
}) {
  const tz = useTz();
  return (
    <Panel title="Conventions" meta="Locked after Gate 1" padded>
      <div className={s.stack}>
        {conventions.entries.length ? (
          <>
            <p className={s.lead}>How the team names, structures and hosts the build.</p>
            <Facts rows={conventions.entries.map((c) => [c.key, c.value])} />
          </>
        ) : (
          <p className={s.quiet}>Recorded with the Blueprint in phase 2.</p>
        )}
        <p className={`${s.lock} type-meta`}>
          {conventions.lockedAt
            ? `Locked by Gate 1 on ${stamp(conventions.lockedAt, tz)}. Changes arrive as Director directives and are logged.`
            : 'Open until Gate 1. After approval, changes arrive as Director directives and are logged.'}
        </p>
      </div>
    </Panel>
  );
}

export function CapabilityGapsPanel({ gaps }: { gaps: SettingsSnapshot['capabilityGaps'] }) {
  const { projectId, run } = useApp();
  const tz = useTz();
  return (
    <Panel title="Capability gaps" meta="What the agents’ tools couldn’t do" padded>
      {gaps.length ? (
        <div className={s.stack}>
          <p className={s.lead}>
            Each gap holds the tasks that need it. Once the tool can do the step, run them again.
          </p>
          <ul className={s.rows}>
            {gaps.map((g) => (
              <li key={g.key} className={s.gap} data-closed={g.closedAt ? true : undefined}>
                <div className={s.row}>
                  <span className={s.rowText}>
                    <span className={s.strong}>{g.capability}</span>
                    {g.closedAt ? (
                      <Notice tone="ok">Closed {stamp(g.closedAt, tz)}</Notice>
                    ) : (
                      <Notice tone="waiting">
                        {g.tasks.length} {g.tasks.length === 1 ? 'task waits' : 'tasks wait'} since{' '}
                        {stamp(g.firstAt, tz)}
                      </Notice>
                    )}
                  </span>
                  {!g.closedAt && (
                    <Action
                      onClick={() =>
                        void run(() =>
                          post(
                            `/projects/${projectId}/capability-gaps/${encodeURIComponent(g.key)}/close`,
                            {},
                          ),
                        )
                      }
                    >
                      Added: run {g.tasks.length === 1 ? 'its task' : 'its tasks'} again
                    </Action>
                  )}
                </div>
                {g.tasks.length > 0 && (
                  <ul className={s.gapTasks}>
                    {g.tasks.map((t) => (
                      <li key={t.taskId} className="type-meta">
                        <b>{t.title}</b>: {t.summary}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className={s.quiet}>
          None. When an agent’s tools can’t do a step, its task waits here instead of asking you.
        </p>
      )}
    </Panel>
  );
}
