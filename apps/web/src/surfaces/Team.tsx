import type { AgentView } from '@lw/contracts';
import { initials } from '../lib/fmt';
import { Chip, Who } from '../parts/bits';
import { useApp, useRoster } from '../state';

const WORKSTREAMS = ['engineering', 'quality', 'content', 'discovery'] as const;
const WS_LABEL = {
  engineering: 'Engineering',
  quality: 'Quality',
  content: 'Content',
  discovery: 'Discovery',
};
const WORKING = new Set(['active', 'waiting', 'blocked', 'paused']);
export const working = (a: AgentView) => WORKING.has(a.state);

function AgentCard({ a, lead }: { a: AgentView; lead?: boolean }) {
  const { inspect } = useApp();
  const off = a.state === 'inactive' || a.state === 'done' || a.state === 'idle';
  const cos = a.tier === 'chief_of_staff';
  const now = off ? (a.state === 'done' ? 'Finished its work' : 'Not working') : (a.now ?? '–');
  return (
    <button
      className={`acard ${lead ? 'lead' : ''} ${off ? 'off' : ''} ${a.state === 'blocked' ? 'bad' : ''}`}
      onClick={() => inspect('agent', a.agentId)}
    >
      <span className="ah">
        <span className="aid">
          <span className={`av8 ${cos ? 'cy' : ''}`}>{initials(a)}</span>
          <span className="anw">
            <span className="an">{a.persona ?? a.name}</span>
            <span className="at">{cos ? 'Chief of Staff' : a.name}</span>
          </span>
        </span>
        <Chip state={a.state} />
      </span>
      <span className="arole">{a.description}</span>
      <span className="arow">
        <span className="ak">Now</span>
        <span className="av">
          {off ? now : <Who text={now} />}
          {!off && a.step && (
            <span className="abar">
              <i style={{ width: `${Math.round((a.step.n / a.step.of) * 100)}%` }} />
            </span>
          )}
        </span>
      </span>
      <span className="arow">
        <span className="ak">Next</span>
        <span className="av">
          {a.next ? <Who text={a.next.title} /> : 'No further work'}
          <small>{a.next?.when ?? ''}</small>
        </span>
      </span>
    </button>
  );
}

export function Team() {
  const { ui, setUi } = useApp();
  const { agents } = useRoster();
  if (!agents.length) return <p className="quiet-line">Loading the team…</p>;
  const f = ui.teamFilter;
  const show = (a: AgentView) => f === 'all' || (f === 'working' ? working(a) : !working(a));
  const cos = agents.find((a) => a.tier === 'chief_of_staff')!;
  const direct = agents.filter((a) => a.reportsTo === cos.agentId && a.tier === 'specialist');
  const others = agents.filter((a) => a.tier !== 'chief_of_staff');
  const nWorking = others.filter(working).length;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team</h1>
          <p>
            {nWorking} of {others.length} agents are working now. Each card shows what it is doing
            and what it picks up next. Select any card to inspect it. Agents are read-only here.
          </p>
        </div>
        <div className="seg" role="group" aria-label="Filter agents">
          {(
            [
              ['all', 'All'],
              ['working', 'Working now'],
              ['idle', 'Not working'],
            ] as const
          ).map(([k, t]) => (
            <button key={k} aria-pressed={f === k} onClick={() => setUi({ teamFilter: k })}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <section className="ws">
        <div className="ws-head">
          <h2>Leadership</h2>
          <span className="muted">Reports to you</span>
        </div>
        <div className="ws-grid">
          <AgentCard a={cos} lead />
          {direct.filter(show).map((a) => (
            <AgentCard key={a.agentId} a={a} />
          ))}
        </div>
      </section>
      {WORKSTREAMS.map((ws) => {
        const lead = agents.find((a) => a.tier === 'lead' && a.workstream === ws);
        if (!lead) return null;
        const specs = agents.filter((a) => a.reportsTo === lead.agentId);
        const list = specs.filter(show);
        if (!show(lead) && !list.length) return null;
        return (
          <section className="ws" key={ws}>
            <div className="ws-head">
              <h2>{WS_LABEL[ws]}</h2>
              <span className="muted">
                {specs.filter(working).length} of {specs.length} specialists working
              </span>
            </div>
            <div className="ws-grid">
              <AgentCard a={lead} lead />
              {list.map((a) => (
                <AgentCard key={a.agentId} a={a} />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
