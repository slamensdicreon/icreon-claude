import type { ActivityItem, ActivityPage } from '@lw/contracts';
import { useEffect, useRef, useState } from 'react';
import { API, get } from '../lib/api';
import { duration, stamp, tokens } from '../lib/fmt';
import { live } from '../lib/live';
import { AgentCell } from '../parts/bits';
import { Icon } from '../lib/icons';
import { Floor } from '../scene/Floor';
import { useApp, useRoster, useTz } from '../state';

const LOG_EVENTS = new Set([
  'step.recorded',
  'review.recorded',
  'plan.changed',
  'control.hold',
  'decision.recorded',
  'credential.verified',
  'preview.deployed',
  'escalation.updated',
]);

export function Activity() {
  const { ui, setUi, projectId } = useApp();
  const tz = useTz();
  const { agents } = useRoster();
  const f = ui.activity;
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [pending, setPending] = useState(0);
  const [more, setMore] = useState<number | null>(null);
  const tail = useRef(ui.liveTail);
  tail.current = ui.liveTail;

  const query = (before?: number) => {
    const q = new URLSearchParams({ view: 'log', limit: '150' });
    if (f.sev === 'warn') q.set('severity', 'warning,failure');
    if (f.sev === 'bad') q.set('severity', 'failure');
    if (f.agent !== 'all') q.set('agent', f.agent);
    if (before) q.set('before', String(before));
    return `/projects/${projectId}/activity?${q}`;
  };

  const load = () =>
    get<ActivityPage>(query()).then((p) => {
      setItems(p.items);
      setMore(p.nextBefore);
      setPending(0);
    });

  useEffect(() => {
    if (!projectId) return;
    void load();
    // Reload on filter change; new events are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, f.sev, f.agent]);

  useEffect(() => {
    const on = (pid: string, type: string) => {
      if (pid !== projectId || !LOG_EVENTS.has(type)) return;
      if (tail.current) void load();
      else setPending((n) => n + 1);
    };
    live.onEvent.add(on);
    return () => void live.onEvent.delete(on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, f.sev, f.agent]);

  const older = () =>
    more &&
    get<ActivityPage>(query(more)).then((p) => {
      setItems((cur) => [...(cur ?? []), ...p.items]);
      setMore(p.nextBefore);
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>
            Every tool call, item, commit and response, in project time. Only warnings, failures and
            escalations carry color. The floor shows the same feed as motion.
          </p>
        </div>
      </div>
      <div className="act-tools">
        <div className="act-view" role="group" aria-label="View">
          <button
            type="button"
            aria-pressed={ui.activityView === 'list'}
            onClick={() => setUi({ activityView: 'list' })}
          >
            <Icon name="list" sm /> List
          </button>
          <button
            type="button"
            aria-pressed={ui.activityView === 'floor'}
            onClick={() => setUi({ activityView: 'floor' })}
          >
            <Icon name="user-group" sm /> Floor
          </button>
        </div>
        <div className="filters">
          {(
            [
              ['all', 'All'],
              ['warn', 'Warnings and failures'],
              ['bad', 'Failures'],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              aria-pressed={f.sev === k}
              onClick={() => setUi({ activity: { ...f, sev: k } })}
            >
              {l}
            </button>
          ))}
        </div>
        <select
          className="select"
          aria-label="Filter by agent"
          value={f.agent}
          onChange={(e) => setUi({ activity: { ...f, agent: e.target.value } })}
        >
          <option value="all">All agents</option>
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.tier === 'chief_of_staff' ? 'Cypher' : `${a.persona ?? a.name}, ${a.name}`}
            </option>
          ))}
        </select>
        <span className="grow" />
        <a
          className="btn"
          href={(() => {
            const q = new URLSearchParams({ view: 'log' });
            if (f.sev === 'warn') q.set('severity', 'warning,failure');
            if (f.sev === 'bad') q.set('severity', 'failure');
            if (f.agent !== 'all') q.set('agent', f.agent);
            return `${API}/projects/${projectId}/activity.csv?${q}`;
          })()}
          download
          title="The whole log as shown (these filters), oldest first, with full text"
        >
          Export CSV
        </a>
        <label className="toggle-row">
          <button
            className="toggle"
            role="switch"
            aria-checked={ui.liveTail}
            aria-label="Live tail"
            onClick={() => {
              setUi({ liveTail: !ui.liveTail });
              if (!ui.liveTail) void load();
            }}
          />
          <span className="muted">Live tail</span>
        </label>
      </div>
      <div className="act-wrap">
        {pending > 0 && !ui.liveTail && (
          <button className="newpill" onClick={() => void load()}>
            {pending} new event{pending > 1 ? 's' : ''}
          </button>
        )}
        {ui.activityView === 'floor' && <Floor items={items} />}
        <div className="act-scroll" hidden={ui.activityView === 'floor'}>
          <table className="act">
            <thead>
              <tr>
                <th>Time</th>
                <th>Agent</th>
                <th>Tool</th>
                <th>Operation</th>
                <th>Result</th>
                <th className="num">Duration</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {(items ?? []).map((a) => (
                <tr
                  key={a.seq}
                  className={
                    a.severity === 'failure' ? 'bad' : a.severity === 'warning' ? 'warn' : ''
                  }
                >
                  <td className="mono">{stamp(a.ts, tz)}</td>
                  <td>
                    <AgentCell agentId={a.agentId} actorId={a.actorId} />
                  </td>
                  <td>{a.toolLabel}</td>
                  <td className="op">
                    {a.operation}
                    {a.note && (
                      <div className="muted" style={{ fontFamily: 'var(--font)', fontSize: 12 }}>
                        {a.note}
                      </div>
                    )}
                  </td>
                  <td>{a.outcome ?? a.resultCode ?? '–'}</td>
                  <td className="num">{duration(a.durationMs)}</td>
                  <td className="num">{tokens(a.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items && !items.length && (
            <p className="quiet-line" style={{ padding: 16 }}>
              Nothing matches these filters.
            </p>
          )}
          {more && (
            <div style={{ padding: 12, textAlign: 'center' }}>
              <button className="btn sm" onClick={() => void older()}>
                Load older activity
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
