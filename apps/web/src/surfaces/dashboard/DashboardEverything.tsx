import type { PortfolioOverview, PortfolioProject } from '@lw/contracts';
import { useState } from 'react';
import { age, clock, localDate, usd } from '../../lib/fmt';
import { useApp, useNow } from '../../state';
import { EscalationLines, SpendBars, Swatch } from '../../ui/cypher/charts';
import { leftOf, pillHue, pillOf, useYoursActions } from '../../ui/cypher/cards';
import { Avatar, Bar, Button, Chips, hueOf, Kpi, NeedsRow, Panel } from '../../ui/cypher/parts';
import s from './dashboard.module.css';

type Filter = 'all' | 'yours' | 'archived';

const HEALTH_TONE: Record<string, string> = {
  Healthy: 'var(--green)',
  Attention: 'var(--gold)',
  Blocked: 'var(--coral-text)',
};

/**
 * The portfolio in Everything (Dashboard-Everything board): four numbers, the projects table, every
 * card that is the Director's, deploys, agents under load, spend by day and escalations.
 */
export function DashboardEverything({ o, refresh }: { o: PortfolioOverview; refresh: () => void }) {
  const { switchProject, newProject } = useApp();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<Filter>('all');
  const rows = o.projects.filter((p) =>
    filter === 'all' ? true : filter === 'yours' ? p.yours > 0 : p.archived,
  );
  const tz = o.timezone;
  const hm = (at: string) => clock(at, tz).replace(/\s?[AP]M$/, '');
  const kpi = (k: string) => o.kpis.find((x) => x.key === k);

  return (
    <div className={s.everything}>
      <section className={s.kpis} aria-label="Key numbers">
        {(['yours', 'running', 'spend', 'events'] as const).map((k) => {
          const x = kpi(k);
          return x ? (
            <Kpi key={k} label={x.label} value={x.value} note={x.note} yours={x.tone === 'yours'} />
          ) : null;
        })}
      </section>

      <div id="projects">
        <Panel
          title="Projects"
          chips={
            <Chips<Filter>
              label="Show projects"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: 'All', count: o.projects.length },
                {
                  value: 'yours',
                  label: 'Needs you',
                  count: o.projects.filter((p) => p.yours > 0).length,
                },
                { value: 'archived', label: 'Archived', count: o.counts.archived },
              ]}
            />
          }
          meta={
            <span className={s.headRight}>
              Sorted by what needs you
              <Button kind="secondary" onClick={() => newProject()}>
                New project
              </Button>
            </span>
          }
        >
          <div className={s.tableWrap}>
            <table className={`${s.table} type-table`}>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Phase</th>
                  <th className={s.progressCol}>Progress</th>
                  <th className={s.num}>Yours</th>
                  <th className={s.num}>Spend</th>
                  <th>Last event</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <ProjectRow
                    key={p.projectId}
                    p={p}
                    hm={hm}
                    tz={tz}
                    onOpen={() => switchProject(p.projectId)}
                  />
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className={s.empty}>
                      Nothing here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <div id="needs">
        <Panel title="Needs you" count={o.yours.length} meta="By clock, then type">
          {o.yours.length === 0 && (
            <p className={`${s.empty} type-body-small`}>Nothing needs you.</p>
          )}
          {o.yours.map((y) => (
            <YoursRow key={y.escalation.escalationId} y={y} now={now} refresh={refresh} />
          ))}
        </Panel>
      </div>

      <section className={s.two} aria-label="Deploys and agents">
        <Panel title="Deploys" meta="Last 24 hours">
          {o.deploys.length === 0 && (
            <p className={`${s.empty} type-body-small`}>No deploys in the last day.</p>
          )}
          {o.deploys.map((d) => (
            <div key={`${d.projectId}-${d.id}`} className={`${s.listRow} type-table`}>
              <i className={s.dot} data-state={d.state} aria-hidden="true" />
              <span className={s.deployId}>{d.id}</span>
              <span className={s.grow}>{d.what}</span>
              <span className={`${s.when} type-meta`}>{hm(d.at)}</span>
              <span className="sr-only">
                {d.state === 'ok' ? 'deployed' : d.state === 'waiting' ? 'waiting' : 'failed'}
              </span>
            </div>
          ))}
        </Panel>
        <Panel title="Agents under load" meta="Tokens on the current task">
          {o.load.length === 0 && (
            <p className={`${s.empty} type-body-small`}>Nobody is working right now.</p>
          )}
          {o.load.map((l) => {
            const max = Math.max(...o.load.map((x) => x.tokens), 1);
            return (
              <div key={`${l.projectId}-${l.agent.agentId}`} className={`${s.listRow} type-table`}>
                <Avatar face={l.agent} size="md" />
                <span className={s.loadText}>
                  <span className={s.loadTop}>
                    <span>
                      <b>{l.agent.name}</b> <span className={s.quiet}>{l.project}</span>
                    </span>
                    <b>{tokensShort(l.tokens)}</b>
                  </span>
                  <Bar
                    percent={Math.round((l.tokens / max) * 100)}
                    hue={hueOf(l.agent.workstream)}
                    label={false}
                  />
                </span>
              </div>
            );
          })}
        </Panel>
      </section>

      <section className={s.two} aria-label="Charts">
        <Panel title="Spend by day" meta={`${usd(o.spendByDay.weekUsd)} this week`} padded>
          <SpendBars days={o.spendByDay.days} />
        </Panel>
        <Panel
          title="Escalations, 24 hours"
          meta={
            <span className={s.legend}>
              <span>
                <Swatch tone="raised" />
                raised {o.escalations.raised}
              </span>
              <span>
                <Swatch tone="settled" />
                settled by leads {o.escalations.settledByLeads}
              </span>
            </span>
          }
          padded
        >
          <EscalationLines
            points={o.escalations.points}
            labelOf={(at, _i, last) => (last ? 'Now' : hourWord(at, tz, now))}
          />
        </Panel>
      </section>
    </div>
  );
}

function ProjectRow({
  p,
  hm,
  tz,
  onOpen,
}: {
  p: PortfolioProject;
  hm: (at: string) => string;
  tz: string;
  onOpen: () => void;
}) {
  const today = p.lastEvent && localDate(p.lastEvent.at, tz) === localDate(Date.now(), tz);
  return (
    <tr>
      <td>
        <button type="button" className={s.projectCell} onClick={onOpen}>
          <span
            className={`${s.tile} type-label`}
            style={{ background: p.archived ? 'var(--text-3)' : hueOf(p.hue) }}
            aria-hidden="true"
          >
            {p.initials}
          </span>
          <span className={s.projectName}>
            <b>{p.name}</b>
            <span
              className="type-meta"
              style={{ color: HEALTH_TONE[p.healthWord] ?? 'var(--text-3)' }}
            >
              {p.healthWord}
            </span>
          </span>
        </button>
      </td>
      <td className={s.secondary}>{p.phaseLabel}</td>
      <td>
        <Bar percent={p.percent} hue={p.archived ? 'var(--text-3)' : hueOf(p.hue)} />
      </td>
      <td className={s.num} data-yours={p.yours > 0 || undefined}>
        {p.yours > 0 ? p.yours : '–'}
      </td>
      <td className={`${s.num} ${s.secondary}`}>{usd(p.spentUsd)}</td>
      <td className={s.last}>
        {p.lastEvent && (
          <>
            <b>{today ? hm(p.lastEvent.at) : shortDate(p.lastEvent.at, tz)}</b> {p.lastEvent.text}
          </>
        )}
      </td>
    </tr>
  );
}

function YoursRow({
  y,
  now,
  refresh,
}: {
  y: PortfolioOverview['yours'][number];
  now: number;
  refresh: () => void;
}) {
  const x = y.escalation;
  const act = useYoursActions(y.projectId, y.project, refresh);
  return (
    <NeedsRow
      type={pillOf(x)}
      hue={pillHue(x)}
      title={x.title}
      meta={[y.project, x.raisedBy?.name, `${age(x.raisedAt, now)}`].filter(Boolean).join(' · ')}
      clock={leftOf(x, now)}
      clockYours={!!x.deadline}
      action={act.rowAction(x)}
    />
  );
}

const tokensShort = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function shortDate(at: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(
    new Date(at),
  );
}

/** "Noon yesterday", "6 PM", "Midnight", "6 AM". */
function hourWord(at: string, tz: string, now: number): string {
  const d = new Date(at);
  const h = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(d),
  );
  const word = h === 0 ? 'Midnight' : h === 12 ? 'Noon' : `${h % 12} ${h < 12 ? 'AM' : 'PM'}`;
  return localDate(at, tz) === localDate(now, tz) ? word : `${word} yesterday`;
}
