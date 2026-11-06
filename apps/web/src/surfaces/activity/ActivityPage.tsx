import type { ActivityItem, ActivityPage as Page } from '@lw/contracts';
import { useEffect, useRef, useState } from 'react';
import { API, get } from '../../lib/api';
import { duration, stamp, tokens } from '../../lib/fmt';
import { live } from '../../lib/live';
import { Mode } from '../../mode/Mode';
import { Floor } from '../../scene/Floor';
import { useApp, useRoster, useTz } from '../../state';
import { Button, Chips, Panel } from '../../ui/cypher/parts';
import { ToolCallCard } from '../../ui/tool-call-card';
import s from './activity.module.css';

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

/** The project's log: filtered, paged, and kept live (or counted while the tail is off). */
function useLog() {
  const { ui, projectId } = useApp();
  const f = ui.activity;
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [pending, setPending] = useState(0);
  const [more, setMore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tail = useRef(ui.liveTail);
  tail.current = ui.liveTail;

  const params = () => {
    const q = new URLSearchParams({ view: 'log' });
    if (f.sev === 'warn') q.set('severity', 'warning,failure');
    if (f.sev === 'bad') q.set('severity', 'failure');
    if (f.agent !== 'all') q.set('agent', f.agent);
    return q;
  };
  const query = (before?: number) => {
    const q = params();
    q.set('limit', '150');
    if (before) q.set('before', String(before));
    return `/projects/${projectId}/activity?${q}`;
  };
  const load = () =>
    get<Page>(query())
      .then((p) => {
        setItems(p.items);
        setMore(p.nextBefore);
        setPending(0);
        setError(null);
      })
      .catch(() => setError('The log could not be read. It retries with the next event.'));

  useEffect(() => {
    if (!projectId) return;
    void load();
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
    get<Page>(query(more)).then((p) => {
      setItems((cur) => [...(cur ?? []), ...p.items]);
      setMore(p.nextBefore);
    });
  const csv = `${API}/projects/${projectId}/activity.csv?${params()}`;
  return { items, pending, more, error, load, older, csv };
}

/** Activity, in both faces (component table: the Floor and Tool call rows). */
export function ActivityPage() {
  const log = useLog();
  return <Mode bliss={<ActivityBliss log={log} />} everything={<ActivityEverything log={log} />} />;
}

type Log = ReturnType<typeof useLog>;

/** Who did it, as a name. */
function useWho() {
  const { agents } = useRoster();
  return (a: ActivityItem) => {
    if (a.agentId) {
      const x = agents.find((g) => g.agentId === a.agentId);
      return x?.tier === 'chief_of_staff' ? 'Cypher' : (x?.persona ?? x?.name ?? a.agentId);
    }
    return a.actorId === 'director'
      ? 'You'
      : a.actorId === 'chief-of-staff'
        ? 'Cypher'
        : 'The system';
  };
}

/** Bliss: the Floor, and the last thing that happened as one tool call. */
function ActivityBliss({ log }: { log: Log }) {
  const who = useWho();
  const last = log.items?.[0];
  return (
    <div className={s.bliss}>
      <div className={s.floor}>
        <Floor items={log.items} variant="bliss" />
      </div>
      {last && (
        <section className={s.beat} aria-label="The last thing that happened">
          <ToolCallCard
            name={`${who(last)} · ${last.toolLabel ?? 'Note'}`}
            summary={last.summary}
            status={last.severity === 'failure' ? 'error' : 'success'}
            {...(last.durationMs !== null ? { duration: last.durationMs } : {})}
            {...(last.severity === 'failure' && last.note ? { error: last.note } : {})}
            args={{
              operation: last.operation,
              result: last.outcome ?? last.resultCode,
              tokens: last.tokens,
            }}
          />
        </section>
      )}
    </div>
  );
}

/**
 * Everything: the log with its filters, the live tail, CSV export and paging; the Floor as the
 * other view of the same feed.
 */
function ActivityEverything({ log }: { log: Log }) {
  const { ui, setUi } = useApp();
  const tz = useTz();
  const who = useWho();
  const { agents } = useRoster();
  const f = ui.activity;
  const view = ui.activityView;
  return (
    <div className={s.everything}>
      <div className={s.tools}>
        <Chips
          label="View"
          value={view}
          onChange={(v) => setUi({ activityView: v })}
          options={[
            { value: 'list', label: 'Log' },
            { value: 'floor', label: 'Floor' },
          ]}
        />
        <Chips
          label="Severity"
          value={f.sev}
          onChange={(v) => setUi({ activity: { ...f, sev: v } })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'warn', label: 'Warnings and failures' },
            { value: 'bad', label: 'Failures' },
          ]}
        />
        <label className={s.select}>
          <span className="sr-only">Filter by agent</span>
          <select
            value={f.agent}
            onChange={(e) => setUi({ activity: { ...f, agent: e.target.value } })}
            className="type-body-small"
          >
            <option value="all">Everyone</option>
            {agents.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {a.tier === 'chief_of_staff' ? 'Cypher' : `${a.persona ?? a.name}, ${a.name}`}
              </option>
            ))}
          </select>
        </label>
        <span className={s.grow} />
        <button
          type="button"
          className={`${s.live} type-button`}
          aria-pressed={ui.liveTail}
          onClick={() => {
            setUi({ liveTail: !ui.liveTail });
            if (!ui.liveTail) void log.load();
          }}
        >
          <i aria-hidden="true" />
          {ui.liveTail ? 'Live' : 'Paused'}
        </button>
        <a className={s.link} href={log.csv} download>
          Export CSV
        </a>
      </div>

      {log.pending > 0 && !ui.liveTail && (
        <button type="button" className={`${s.pill} type-button`} onClick={() => void log.load()}>
          {log.pending} new event{log.pending > 1 ? 's' : ''}
        </button>
      )}

      {view === 'floor' ? (
        <div className={s.floor}>
          <Floor items={log.items} />
        </div>
      ) : (
        <Panel title="Activity" meta="Project time; only warnings and failures carry color">
          {log.error && <p className={`${s.empty} type-body-small`}>{log.error}</p>}
          <div className={s.tableWrap}>
            <table className={`${s.table} type-table`}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Who</th>
                  <th>Tool</th>
                  <th>What happened</th>
                  <th>Result</th>
                  <th className={s.num}>Took</th>
                  <th className={s.num}>Tokens</th>
                </tr>
              </thead>
              <tbody>
                {(log.items ?? []).map((a) => (
                  <tr key={a.seq} data-severity={a.severity}>
                    <td className={s.quiet}>{stamp(a.ts, tz)}</td>
                    <td className={s.who}>
                      <b>{who(a)}</b>
                    </td>
                    <td className={s.quiet}>{a.toolLabel ?? '—'}</td>
                    <td>
                      {a.operation || a.summary}
                      {a.note && <span className={`${s.note} type-meta`}>{a.note}</span>}
                    </td>
                    <td>
                      <b className={s.result} data-severity={a.severity}>
                        {a.outcome ?? a.resultCode ?? '—'}
                      </b>
                    </td>
                    <td className={`${s.num} ${s.quiet}`}>{duration(a.durationMs)}</td>
                    <td className={`${s.num} ${s.quiet}`}>{tokens(a.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {log.items && !log.items.length && (
            <p className={`${s.empty} type-body-small`}>Nothing matches these filters.</p>
          )}
          {log.more && (
            <div className={s.older}>
              <Button kind="secondary" onClick={() => void log.older()}>
                Load older activity
              </Button>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
