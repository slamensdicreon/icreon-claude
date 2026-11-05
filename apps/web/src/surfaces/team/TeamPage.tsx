import type { AgentView, Face, TeamSnapshot } from '@lw/contracts';
import { initials as initialsOf } from '../../lib/fmt';
import { Mode } from '../../mode/Mode';
import { useApp, useMission, useTeam } from '../../state';
import { Eye } from '../../ui/Eye';
import { Avatar, Chips, Panel, SectionHeading, TeamLine } from '../../ui/cypher/parts';
import { useEyeState } from '../../voice/eye';
import { leadFace, teamName, word } from '../mission/model';
import s from './team.module.css';

const WORKING = new Set(['active', 'waiting', 'blocked', 'paused']);
const isWorking = (a: AgentView) => WORKING.has(a.state);

const STATE: Record<string, [string, string]> = {
  active: ['Working', 'var(--blue)'],
  waiting: ['Waiting', 'var(--gold)'],
  blocked: ['Blocked', 'var(--coral-text)'],
  paused: ['Paused', 'var(--gold)'],
  failed: ['Failed', 'var(--coral-text)'],
  done: ['Done', 'var(--green)'],
  idle: ['Idle', 'var(--text-3)'],
  inactive: ['Not in this phase', 'var(--text-3)'],
};

const faceOf = (a: AgentView): Face => {
  const name = a.persona ?? a.name;
  return {
    agentId: a.agentId,
    name,
    firstName: name.split(' ')[0] ?? name,
    initials: initialsOf(a),
    workstream: a.workstream,
    working: isWorking(a),
  };
};

/** Team, in both faces (component table: Team line in Bliss; the agent tree in Everything). */
export function TeamPage() {
  const team = useTeam().data as TeamSnapshot | undefined;
  const mc = useMission().data;
  if (!team || !mc) return <p className="type-body">Reading the team…</p>;
  return (
    <Mode bliss={<TeamBliss mc={mc} />} everything={<TeamEverything agents={team.agents} />} />
  );
}

/** Bliss: one line per Lead, in Cypher's words, with the faces of their people. */
function TeamBliss({ mc }: { mc: NonNullable<ReturnType<typeof useMission>['data']> }) {
  const { inspect } = useApp();
  return (
    <div className={s.bliss}>
      <SectionHeading>The team, in one line each</SectionHeading>
      <div>
        {mc.teamNow.map((l) => (
          <TeamLine
            key={l.agentId}
            face={leadFace(l)}
            team={teamName(l.workstream)}
            read={l.read ?? `${capital(word(l.active))} active.`}
            tone={l.readTone ?? (l.blocked ? 'blocked' : l.active ? 'normal' : 'quiet')}
            reports={l.reports ?? []}
            onOpen={() => inspect('agent', l.agentId)}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Everything: the team as a tree, the Chief of Staff and each Lead with their specialists under
 * them; tokens roll up to the Lead. Filter by who's working; any row opens the inspector.
 */
function TeamEverything({ agents }: { agents: AgentView[] }) {
  const { ui, setUi, inspect } = useApp();
  const filter = ui.teamFilter;
  const show = (a: AgentView) =>
    filter === 'all' || (filter === 'working' ? isWorking(a) : !isWorking(a));
  const cos = agents.filter((a) => a.tier === 'chief_of_staff');
  const leads = agents.filter((a) => a.tier === 'lead');
  const under = (lead: AgentView) =>
    agents.filter((a) => a.tier === 'specialist' && a.reportsTo === lead.agentId);
  const orphans = agents.filter(
    (a) => a.tier === 'specialist' && !leads.some((l) => l.agentId === a.reportsTo),
  );
  const working = agents.filter(isWorking).length;
  const eye = useEyeState();

  const row = (a: AgentView, depth: 0 | 1, total?: number) => {
    const [w, c] = STATE[a.state] ?? [a.state, 'var(--text-3)'];
    return (
      <tr key={a.agentId} data-depth={depth} data-off={!isWorking(a) || undefined}>
        <td>
          <button type="button" className={s.who} onClick={() => inspect('agent', a.agentId)}>
            {/* The eye is only ever Cypher (design system §3). */}
            {a.tier === 'chief_of_staff' ? (
              <Eye state={eye.state} size={44} decorative />
            ) : (
              <Avatar face={faceOf(a)} size={depth ? 'md' : 'lg'} />
            )}
            <span className={s.whoText}>
              <b>{a.persona ?? a.name}</b>
              <span className="type-meta">
                {a.tier === 'chief_of_staff' ? 'Chief of Staff' : a.name}
              </span>
            </span>
          </button>
        </td>
        <td>
          <span className={s.state} style={{ color: c }}>
            <i style={{ background: c }} aria-hidden="true" />
            {w}
          </span>
        </td>
        <td className={s.now}>
          {a.now ?? '—'}
          {a.step && (
            <span className={`${s.step} type-meta`}>
              step {word(a.step.n)} of {word(a.step.of)}
            </span>
          )}
        </td>
        <td className={s.num}>{tokens(total ?? a.tokensProject)}</td>
      </tr>
    );
  };

  return (
    <div className={s.everything}>
      <Panel
        title="Team"
        chips={
          <Chips
            label="Show"
            value={filter}
            onChange={(v) => setUi({ teamFilter: v })}
            options={[
              { value: 'all', label: 'All', count: agents.length },
              { value: 'working', label: 'Working now', count: working },
              { value: 'idle', label: 'Not working', count: agents.length - working },
            ]}
          />
        }
        meta="Tokens this project, rolled up to each Lead"
      >
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>Person</th>
                <th>State</th>
                <th>Now</th>
                <th className={s.num}>Tokens</th>
              </tr>
            </thead>
            {cos.filter(show).length > 0 && <tbody>{cos.filter(show).map((a) => row(a, 0))}</tbody>}
            {leads.map((l) => {
              const team = under(l);
              const visible = team.filter(show);
              if (!show(l) && !visible.length) return null;
              const total = l.tokensProject + team.reduce((n, a) => n + a.tokensProject, 0);
              return (
                <tbody key={l.agentId} className={s.group}>
                  <tr className={s.groupHead}>
                    <th colSpan={4} className="type-label">
                      {teamName(l.workstream)} · {word(team.filter(isWorking).length)} of{' '}
                      {word(team.length)} working
                    </th>
                  </tr>
                  {row(l, 0, total)}
                  {visible.map((a) => row(a, 1))}
                </tbody>
              );
            })}
            {orphans.filter(show).length > 0 && (
              <tbody>{orphans.filter(show).map((a) => row(a, 1))}</tbody>
            )}
          </table>
        </div>
      </Panel>
    </div>
  );
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const tokens = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);
