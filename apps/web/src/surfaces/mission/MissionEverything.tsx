import type {
  ActivityPage,
  MissionControlSnapshot,
  PlanSnapshot,
  TaskView,
  TeamSnapshot,
} from '@lw/contracts';
import { useState } from 'react';
import { age, clock, elapsed, usd } from '../../lib/fmt';
import { useApp, useNow, useProjectResource, useTeam } from '../../state';
import { leftOf, pillHue, pillOf, useYoursActions } from '../../ui/cypher/cards';
import { Avatar, Bar, Chips, NeedsRow, Panel, PhaseStrip } from '../../ui/cypher/parts';
import { gateShort, openCards, phaseOwners, stripOf, word } from './model';
import s from './mission.module.css';

type TaskFilter = 'running' | 'queued' | 'blocked' | 'done';
const STATES: Record<TaskFilter, TaskView['state'][]> = {
  running: ['running', 'validating'],
  queued: ['planned', 'ready'],
  blocked: ['blocked', 'waiting', 'paused', 'rejected'],
  done: ['done'],
};
const STATE_WORD: Record<string, [string, string]> = {
  running: ['Running', 'var(--blue)'],
  validating: ['Checking', 'var(--blue)'],
  planned: ['Queued', 'var(--text-3)'],
  ready: ['Ready', 'var(--text-3)'],
  blocked: ['Blocked', 'var(--coral-text)'],
  waiting: ['Waiting', 'var(--gold)'],
  paused: ['Paused', 'var(--gold)'],
  rejected: ['Sent back', 'var(--coral-text)'],
  done: ['Done', 'var(--green)'],
  cancelled: ['Cancelled', 'var(--text-3)'],
  rolled_back: ['Rolled back', 'var(--text-3)'],
};

/**
 * One project in Everything (Mission-Everything board): the labelled phase strip, four metric
 * cards, every card that is the Director's, the tasks, the team and the live activity log.
 */
export function MissionEverything({ mc }: { mc: MissionControlSnapshot }) {
  const { go, inspect, setUi } = useApp();
  const plan = useProjectResource<PlanSnapshot>('/plan').data ?? null;
  const team = useTeam().data as TeamSnapshot | undefined;
  const log = useProjectResource<ActivityPage>('/activity?limit=8').data;
  const now = useNow(30_000);
  const p = mc.project;
  const tz = p.timezone;
  const act = useYoursActions(p.id, p.name);
  const cards = openCards(mc);
  const [filter, setFilter] = useState<TaskFilter>('running');
  const tasks = plan?.tasks ?? [];
  const shown = tasks.filter((t) => STATES[filter].includes(t.state)).slice(0, 8);
  const agents = team?.agents ?? [];
  const persona = (id: string) =>
    agents.find((a) => a.agentId === id)?.persona ??
    agents.find((a) => a.agentId === id)?.name ??
    id;
  const working = agents.filter((a) => a.state === 'active');
  const nextGate = mc.phases.find((x) => x.gate === 'director' && x.status !== 'done');
  const approved = mc.phases.filter((x) => x.gate === 'director' && x.status === 'done');

  return (
    <div className={s.everything}>
      <Panel
        title="Phases"
        padded
        meta={[
          ...approved.map((g) => `${gateShort(g.gateLabel)} approved`),
          nextGate
            ? `${gateShort(nextGate.gateLabel, 'Next gate')} at ${nextGate.shortName || nextGate.name}`
            : null,
          `${usd(p.spent.usd)} of ${usd(p.budgets.usd)}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      >
        <PhaseStrip phases={stripOf(mc, phaseOwners(plan))} labelled />
      </Panel>

      <section className={s.metrics} aria-label="Metrics">
        {mc.stats.slice(0, 3).map((m) => {
          const pct = m.value !== null && m.total ? Math.round((m.value / m.total) * 100) : null;
          return (
            <div key={m.key} className={s.metric}>
              <span className={s.metricHead}>
                <span className="type-label">{m.label}</span>
                {m.note && <span className="type-meta">{m.note}</span>}
              </span>
              <span className="type-number">
                {m.value === null ? '—' : m.unit === 'percent' ? `${m.value}%` : m.value}
                {m.unit === 'count' && m.total !== null && (
                  <span className="type-number-unit"> of {m.total}</span>
                )}
              </span>
              <Bar
                percent={m.unit === 'percent' ? (m.value ?? 0) : (pct ?? 0)}
                hue="var(--ink)"
                label={false}
              />
            </div>
          );
        })}
        <div className={s.metric}>
          <span className={s.metricHead}>
            <span className="type-label">Cost against budget</span>
            <span className="type-meta">
              {Math.round((p.spent.usd / Math.max(1, p.budgets.usd)) * 100)}% spent
            </span>
          </span>
          <span className="type-number">
            {usd(p.spent.usd)}
            <span className="type-number-unit"> of {usd(p.budgets.usd)}</span>
          </span>
          <Bar
            percent={Math.min(100, Math.round((p.spent.usd / Math.max(1, p.budgets.usd)) * 100))}
            hue="var(--ink)"
            label={false}
          />
        </div>
      </section>

      <Panel title="Needs you" count={cards.length} meta="By clock, then type">
        {cards.length === 0 && <p className={`${s.empty} type-body-small`}>Nothing needs you.</p>}
        {cards.map((x) => (
          <NeedsRow
            key={x.escalationId}
            type={pillOf(x)}
            hue={pillHue(x)}
            title={x.title}
            meta={[x.raisedBy?.name, age(x.raisedAt, now), x.impact].filter(Boolean).join(' · ')}
            clock={leftOf(x, now)}
            clockYours={!!x.deadline}
            action={act.rowAction(x)}
          />
        ))}
      </Panel>

      <Panel
        title="Tasks"
        chips={
          <Chips<TaskFilter>
            label="Show tasks"
            value={filter}
            onChange={setFilter}
            options={(['running', 'queued', 'blocked', 'done'] as const).map((k) => ({
              value: k,
              label: k[0]!.toUpperCase() + k.slice(1),
              count: tasks.filter((t) => STATES[k].includes(t.state)).length,
            }))}
          />
        }
        meta={
          <button type="button" className={s.link} onClick={() => go('plan')}>
            Open the plan
          </button>
        }
      >
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>Task</th>
                <th>Agent</th>
                <th>State</th>
                <th className={s.num}>Elapsed</th>
                <th className={s.num}>Attempt</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const [w, c] = STATE_WORD[t.state] ?? [t.state, 'var(--text-3)'];
                return (
                  <tr key={t.taskId}>
                    <td>
                      <button
                        type="button"
                        className={s.rowLink}
                        onClick={() => inspect('task', t.taskId)}
                      >
                        {t.title}
                      </button>
                    </td>
                    <td className={s.secondary}>{persona(t.agentId)}</td>
                    <td>
                      <span className={s.state} style={{ color: c }}>
                        <i style={{ background: c }} aria-hidden="true" />
                        {w}
                      </span>
                    </td>
                    <td className={`${s.num} ${s.secondary}`}>
                      {t.startedAt && t.state !== 'done' ? elapsed(t.startedAt, now) : '—'}
                    </td>
                    <td className={`${s.num} ${s.quietText}`}>
                      {t.attempt > 0 ? `attempt ${word(t.attempt)}` : '—'}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} className={s.empty}>
                    No tasks here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <section className={s.teamActivity} aria-label="Team and activity">
        <Panel title="Team" meta={`${working.length} of ${agents.length} working`}>
          {agents
            .slice()
            .sort(
              (a, b) =>
                Number(b.state === 'active') - Number(a.state === 'active') ||
                b.tokensThisTask - a.tokensThisTask,
            )
            .slice(0, 9)
            .map((a) => {
              const name = a.persona ?? a.name;
              const face = {
                agentId: a.agentId,
                name,
                firstName: name.split(' ')[0] ?? name,
                initials: name
                  .split(/\s+/)
                  .map((x) => x[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase(),
                workstream: a.workstream,
                working: a.state === 'active',
              };
              const blocked = a.state === 'blocked';
              return (
                <button
                  key={a.agentId}
                  type="button"
                  className={`${s.listRow} type-table`}
                  onClick={() => inspect('agent', a.agentId)}
                >
                  <Avatar face={face} size="md" />
                  <span className={s.listText}>
                    <b>{name}</b>
                    <span
                      className="type-meta"
                      style={{ color: blocked ? 'var(--coral-text)' : 'var(--text-3)' }}
                    >
                      {a.now ?? a.role}
                    </span>
                  </span>
                  <span className={`${s.quietText} type-meta`}>
                    {a.tokensThisTask ? `${Math.round(a.tokensThisTask / 1000)}k` : ''}
                  </span>
                </button>
              );
            })}
        </Panel>
        <Panel
          title="Activity"
          meta={
            <button
              type="button"
              className={s.link}
              onClick={() => {
                setUi({ activityView: 'floor' });
                go('activity');
              }}
            >
              Open the floor
            </button>
          }
        >
          {(log?.items ?? []).map((e) => (
            <div key={e.seq} className={`${s.logRow} type-table`} data-severity={e.severity}>
              <span className={`${s.logTime} type-meta`}>
                {clock(e.ts, tz).replace(/\s?[AP]M$/, '')}
              </span>
              <span className={s.listText}>
                <span>
                  <b>
                    {e.agentId ? persona(e.agentId) : e.actorId === 'director' ? 'You' : 'Cypher'}
                  </b>
                  {e.toolLabel && <span className={s.quietText}> · {e.toolLabel}</span>}
                </span>
                <span className={s.logOp}>{e.summary}</span>
              </span>
              {e.outcome && (
                <b className={s.outcome} data-severity={e.severity}>
                  {e.outcome}
                </b>
              )}
            </div>
          ))}
          {log && log.items.length === 0 && (
            <p className={`${s.empty} type-body-small`}>Nothing yet.</p>
          )}
        </Panel>
      </section>
    </div>
  );
}
