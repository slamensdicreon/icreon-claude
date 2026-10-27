import type { EscalationView, PlanSnapshot } from '@lw/contracts';
import { useEffect, useMemo, useRef } from 'react';
import { age, clock, zoneLabel } from '../lib/fmt';
import { Card, TYPE_LABEL } from '../parts/Card';
import {
  useApp,
  useConversation,
  useMission,
  useNow,
  useProjectResource,
  useRoster,
  useTz,
} from '../state';

/** Most urgent first: what stops work, then what waits on a review, then everything else. */
const URGENCY: Record<string, number> = {
  blocker: 0,
  access: 1,
  gate: 2,
  decision: 3,
  budget: 4,
  risk: 5,
};

/** "1 h 56" or "18 min": how long until a card's default action is taken. */
function until(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}

/**
 * Everything waiting on the Director, one decision at a time: a list to scan on the left, the
 * card to act on at the right. Deciding moves to the next open item.
 */
export function Inbox() {
  const { ui, setUi, projects, projectId } = useApp();
  const conv = useConversation().data;
  const plan = useProjectResource<PlanSnapshot>('/plan').data;
  const mc = useMission().data;
  const roster = useRoster();
  const now = useNow(30_000);
  const tz = useTz();
  const name = projects.find((p) => p.id === projectId)?.name ?? '';
  const tasks = useMemo(() => new Map((plan?.tasks ?? []).map((t) => [t.taskId, t])), [plan]);

  const queue = conv?.queue ?? [];
  const open = queue
    .filter((x) => x.status === 'open')
    .sort(
      (a, b) =>
        (URGENCY[a.type] ?? 9) - (URGENCY[b.type] ?? 9) || a.raisedAt.localeCompare(b.raisedAt),
    );
  const deferred = queue.filter((x) => x.status === 'deferred');
  const decided = queue.filter(
    (x) =>
      x.status !== 'open' &&
      x.status !== 'deferred' &&
      x.undoUntil &&
      Date.parse(x.undoUntil) > now,
  );
  const list = [...open, ...deferred, ...decided];
  const chosen = list.find((x) => x.escalationId === ui.expanded) ?? null;

  // When the card in view is decided, move on to the next open one.
  const seen = useRef(new Map<string, string>());
  useEffect(() => {
    const was = chosen ? seen.current.get(chosen.escalationId) : undefined;
    for (const x of queue) seen.current.set(x.escalationId, x.status);
    if (chosen && was === 'open' && chosen.status !== 'open' && open[0])
      setUi({ expanded: open[0].escalationId });
    else if (!chosen && open[0]) setUi({ expanded: open[0].escalationId });
  });
  const selected = chosen ?? open[0] ?? null;

  // J and K (or the arrow keys) move through the list.
  const order = useRef(list);
  order.current = list;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && /INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step =
        e.key === 'j' || e.key === 'ArrowDown' ? 1 : e.key === 'k' || e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      const items = order.current;
      const i = items.findIndex((x) => x.escalationId === ui.expanded);
      const next = items[Math.min(items.length - 1, Math.max(0, i + step))];
      if (next) {
        e.preventDefault();
        setUi({ expanded: next.escalationId });
        document.getElementById(`ibx-${next.escalationId}`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ui.expanded, setUi]);

  const about = (x: EscalationView) => {
    const t = x.sourceTaskId ? tasks.get(x.sourceTaskId) : undefined;
    const a = t ? roster.byId(t.agentId) : undefined;
    const who = a ? (a.persona ? `${a.persona.split(' ')[0]}, ${a.name}` : a.name) : null;
    return { task: t?.title ?? null, who };
  };

  const row = (x: EscalationView) => {
    const { task, who } = about(x);
    const rec = x.type === 'gate' ? null : x.options.find((o) => o.recommended);
    const active = selected?.escalationId === x.escalationId;
    return (
      <li key={x.escalationId}>
        <button
          id={`ibx-${x.escalationId}`}
          className={`ibx-row ${x.type} ${x.status}`}
          aria-current={active ? 'true' : undefined}
          onClick={() => setUi({ expanded: x.escalationId })}
        >
          <span className="ibx-top">
            <span className={`type ${x.type}`}>{x.typeLabel ?? TYPE_LABEL[x.type]}</span>
            <span className="age">{age(x.raisedAt, now)}</span>
          </span>
          <span className="ibx-title">{x.title}</span>
          {(task || who) && (
            <span className="ibx-meta">{[who, task].filter(Boolean).join(' · ')}</span>
          )}
          {x.status === 'open' && rec && <span className="ibx-rec">Recommended: {rec.label}</span>}
          {x.status === 'open' && x.deadline && x.defaultOptionId && (
            <span className="ibx-due">Default in {until(Date.parse(x.deadline) - now)}</span>
          )}
          {x.status === 'deferred' && x.deferredUntil && (
            <span className="ibx-due">
              Deferred until {clock(x.deferredUntil, tz)} {zoneLabel(tz)}
            </span>
          )}
        </button>
      </li>
    );
  };

  const nextGate = mc?.phases.find((p) => p.gate === 'director' && p.status !== 'done');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Needs you</h1>
          <p>
            {open.length
              ? `${open.length} ${open.length === 1 ? 'decision is' : 'decisions are'} waiting on you, most urgent first. J and K move between them; 1 to 4 chooses.`
              : 'Nothing is waiting on you.'}
          </p>
        </div>
      </div>
      {list.length === 0 ? (
        <section className="panel">
          <p className="quiet-line" style={{ margin: 0 }}>
            The team is working.
            {nextGate ? ` The next review is ${nextGate.shortName}, phase ${nextGate.number}.` : ''}
          </p>
        </section>
      ) : (
        <div className="inbox">
          <nav className="ibx-list" aria-label="Waiting on you">
            {open.length > 0 && (
              <>
                <h2 className="ibx-h">
                  Waiting on you <small>{open.length}</small>
                </h2>
                <ul>{open.map(row)}</ul>
              </>
            )}
            {deferred.length > 0 && (
              <>
                <h2 className="ibx-h">
                  Deferred <small>{deferred.length}</small>
                </h2>
                <ul>{deferred.map(row)}</ul>
              </>
            )}
            {decided.length > 0 && (
              <>
                <h2 className="ibx-h">Just decided</h2>
                <ul>{decided.map(row)}</ul>
              </>
            )}
          </nav>
          <div className="ibx-detail">
            {selected && (
              <Card
                key={selected.escalationId}
                x={selected}
                mode="full"
                projectName={name}
                about={about(selected)}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
