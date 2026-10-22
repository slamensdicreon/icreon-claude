import type { ConversationItem, EscalationView } from '@lw/contracts';
import { useEffect, useRef } from 'react';
import { post } from '../lib/api';
import { clock, localDate, longDay, zoneLabel } from '../lib/fmt';
import { Icon } from '../lib/icons';
import { Chip, useJump, Who } from '../parts/bits';
import { Card, TYPE_LABEL } from '../parts/Card';
import { useApp, useConversation, useNow, useRoster, useTz } from '../state';

const ORDER: Record<string, number> = {
  blocker: 0,
  access: 1,
  decision: 2,
  gate: 3,
  budget: 4,
  risk: 5,
};

export function Dock() {
  const { layout, setLayout, ui, setUi, projects, projectId } = useApp();
  const conv = useConversation().data;
  const now = useNow();
  const name = projects.find((p) => p.id === projectId)?.name ?? '';
  const waiting = conv?.queue.filter((x) => x.status === 'open').length ?? 0;
  const thinking = conv?.presence === 'thinking';

  // The queue keeps cards that are open, deferred, or still inside their undo window.
  const items: EscalationView[] = (conv?.queue ?? [])
    .filter(
      (x) =>
        x.status === 'open' ||
        x.status === 'deferred' ||
        (x.undoUntil && Date.parse(x.undoUntil) > now),
    )
    .sort(
      (a, b) =>
        Number(a.status !== 'open') - Number(b.status !== 'open') ||
        (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) ||
        b.raisedAt.localeCompare(a.raisedAt),
    );

  return (
    <aside className="dock" aria-label="Cypher">
      <div className="dock-head">
        <h2>
          <span className="dk-n">
            Cypher<small>Chief of Staff</small>
          </span>{' '}
          <span className={`presence ${thinking ? 'thinking' : ''}`}>
            <i />
            <span>{thinking ? 'Thinking' : 'Listening'}</span>
          </span>
        </h2>
        {waiting > 0 && <span className="badge">{waiting}</span>}
        <button
          className="iconbtn sl"
          data-action="collapse-dock"
          title="Collapse"
          aria-label="Collapse Cypher"
          onClick={() =>
            matchMedia('(max-width: 900px)').matches
              ? setLayout({ dockOpen: false })
              : setLayout({ dockCollapsed: !layout.dockCollapsed })
          }
        >
          <Icon name="chevron--right" />
        </button>
      </div>
      {items.length > 0 && (
        <div className={`queue ${ui.queueCollapsed ? 'collapsed' : ''}`}>
          <div className="q-h">
            <h3>Needs you{waiting > 0 && <span className="badge">{waiting}</span>}</h3>
            <button
              className="link-btn"
              onClick={() => setUi({ queueCollapsed: !ui.queueCollapsed })}
            >
              {ui.queueCollapsed ? 'Show' : 'Hide'}
            </button>
          </div>
          {!ui.queueCollapsed && (
            <div className="q-list">
              {items.map((x) => (
                <Card key={x.escalationId} x={x} mode="queue" projectName={name} />
              ))}
            </div>
          )}
        </div>
      )}
      <Conversation items={conv?.items ?? []} />
      <Composer />
      <div className="dock-mini">
        <button
          className="iconbtn sl"
          title="Open Cypher"
          aria-label="Open Cypher"
          onClick={() => setLayout({ dockCollapsed: false })}
        >
          <Icon name="chat" />
        </button>
        {waiting > 0 && <span className="badge">{waiting}</span>}
      </div>
    </aside>
  );
}

function DayLabel({ t, tz, now }: { t: string; tz: string; now: number }) {
  const today = localDate(t, tz) === localDate(now, tz);
  return (
    <div className="daysep">
      <span>{today ? `Today, ${longDay(t, tz)}` : longDay(t, tz)}</span>
    </div>
  );
}

function Conversation({ items }: { items: ConversationItem[] }) {
  const tz = useTz();
  const now = useNow(60_000);
  const ref = useRef<HTMLDivElement>(null);
  const last = items.at(-1)?.messageId;
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last, items.length]);

  const out: React.ReactNode[] = [];
  let day: string | null = null;
  let prev: ConversationItem | null = null;
  for (const m of items) {
    const d = localDate(m.ts, tz);
    if (d !== day) {
      out.push(<DayLabel key={`d-${d}`} t={m.ts} tz={tz} now={now} />);
      day = d;
      prev = null;
    }
    const plain = m.from === 'chief_of_staff' && m.kind === 'text';
    const grouped = plain && prev?.from === 'chief_of_staff' && prev.kind === 'text';
    out.push(<Message key={m.messageId} m={m} grouped={grouped} tz={tz} />);
    prev = m;
  }
  return (
    <div className="convo" ref={ref} aria-live="polite">
      {out}
    </div>
  );
}

/** Text with D-07 style references as chips that open the Decision Log. */
function Linked({ text }: { text: string }) {
  const { go } = useApp();
  const parts = text.split(/\b(D-\d{2})\b/);
  return (
    <>
      {parts.map((p, i) =>
        /^D-\d{2}$/.test(p) ? (
          <button
            key={i}
            className="dchip"
            onClick={() => go('workbench', { wbArtifact: 'decisions' })}
          >
            {p}
          </button>
        ) : (
          <Who key={i} text={p} />
        ),
      )}
    </>
  );
}

function Actions({ links }: { links: ConversationItem['links'] }) {
  const jump = useJump();
  if (!links.length) return null;
  return (
    <div className="em-act">
      {links.map((l) => (
        <button key={l.label} className="btn sm" onClick={() => jump(l.target)}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

function Message({ m, grouped, tz }: { m: ConversationItem; grouped: boolean; tz: string }) {
  const jump = useJump();
  const { byId } = useRoster();
  const { setUi, setLayout } = useApp();
  const t = `${clock(m.ts, tz)} ${zoneLabel(tz)}`;
  if (m.from === 'director')
    return (
      <div className="m me">
        <div className="m-meta">
          <span>{t}</span>
        </div>
        <div className="m-bubble">{m.body}</div>
      </div>
    );

  let body: React.ReactNode;
  if (
    m.kind === 'brief' ||
    m.kind === 'digest' ||
    m.kind === 'phase_brief_entry' ||
    m.kind === 'phase_brief_exit'
  ) {
    body = (
      <div className="embed">
        <div className="em-h">
          <span className="em-k">
            {m.label ?? (m.kind === 'digest' ? 'Daily digest' : 'Brief')}
          </span>
          <b>{m.title}</b>
        </div>
        <div className="em-body">
          {m.rows.map((r) => (
            <div className="em-row" key={r.label}>
              <span>{r.label}</span>
              <div>
                <Linked text={r.value} />
              </div>
            </div>
          ))}
          {m.sections.map((s) => (
            <div className="em-row" key={s.heading}>
              <span>{s.heading}</span>
              <div>{s.lines.join(' ')}</div>
            </div>
          ))}
          {m.bullets.length > 0 && (
            <ul className="em-list">
              {m.bullets.map((b, i) => (
                <li key={i}>
                  <span>
                    <Linked text={b} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {m.body && !m.rows.length && !m.bullets.length && (
            <p className="m-text" style={{ margin: 0 }}>
              {m.body}
            </p>
          )}
        </div>
        {m.note && (
          <div className="em-note">
            <Icon name="information" sm />
            <span>
              <Who text={m.note} />
            </span>
          </div>
        )}
        <Actions links={m.links} />
      </div>
    );
  } else if (m.kind === 'status' && m.status) {
    const s = m.status;
    body = (
      <div className="embed">
        <div className="em-h">
          <span className="em-k">Status</span>
          <b>
            {s.phase}, {s.percent}% done
          </b>
        </div>
        <div className="em-grid">
          <div>
            <span>Blockers</span>
            <b className={s.blockers.length ? 'bad' : ''}>{s.blockers.length || 'None'}</b>
            {s.blockers.length > 0 && <small>{s.blockers.join(', ')}</small>}
          </div>
          <div>
            <span>Needs you</span>
            <b>{s.waiting}</b>
          </div>
          <div>
            <span>{s.headline.label}</span>
            <b>{s.headline.value}</b>
            {s.headline.sub && <small>{s.headline.sub}</small>}
          </div>
          <div>
            <span>Next gate</span>
            <b>{s.nextGate}</b>
          </div>
          <div>
            <span>Cost</span>
            <b>{s.cost}</b>
          </div>
          <div>
            <span>Elapsed</span>
            <b>{s.elapsed}</b>
          </div>
        </div>
        <Actions
          links={[
            { label: 'Open plan', target: { kind: 'surface', ref: 'plan' } },
            { label: 'Open team', target: { kind: 'surface', ref: 'team' } },
          ]}
        />
      </div>
    );
  } else if (m.kind === 'needs') {
    body = m.needs.length ? (
      <div className="embed">
        <div className="em-h">
          <span className="em-k">Needs you</span>
          <b>
            {m.needs.length} {m.needs.length === 1 ? 'item' : 'items'} waiting on your call
          </b>
        </div>
        <div className="em-body">
          {m.needs.map((n) => (
            <div className="em-item" key={n.escalationId}>
              <span className={`type ${n.type}`}>{TYPE_LABEL[n.type]}</span>
              <span className="em-it">{n.title}</span>
              <button
                className="btn sm"
                onClick={() => {
                  setUi({ expanded: n.escalationId, queueCollapsed: false });
                  setLayout({ dockOpen: true });
                }}
              >
                Open
              </button>
            </div>
          ))}
        </div>
      </div>
    ) : (
      <div className="m-text">Nothing is waiting on you.</div>
    );
  } else if (m.kind === 'next') {
    body = (
      <div className="embed">
        <div className="em-h">
          <span className="em-k">Up next</span>
          <b>The next {m.upNext.length} activities</b>
        </div>
        <div className="em-body">
          {m.upNext.map((x) => {
            const a = byId(x.agentId);
            return (
              <div className="em-item" key={x.taskId}>
                <span className="em-time">{clock(x.start, tz)}</span>
                <span className="em-it">
                  {x.title}
                  <small>
                    {a?.persona ?? x.agentId}, {a?.name ?? ''}
                  </small>
                </span>
                <Chip state={x.state} />
              </div>
            );
          })}
        </div>
        <Actions links={[{ label: 'Open the plan', target: { kind: 'surface', ref: 'plan' } }]} />
      </div>
    );
  } else if (m.kind === 'directive_ack') {
    body = <Directive m={m} />;
  } else {
    body = (
      <>
        <div className="m-text">
          <Linked text={m.body} />
        </div>
        {m.links.length > 0 && (
          <div className="m-links">
            {m.links.map((l) => (
              <button key={l.label} className="link-btn" onClick={() => jump(l.target)}>
                {l.label}
              </button>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <div className={`m cos ${grouped ? 'grp' : ''}`}>
      <div className="m-av" aria-hidden="true">
        C
      </div>
      <div className="m-main">
        <div className="m-meta">
          <b>Cypher</b>
          <span>{t}</span>
        </div>
        {body}
      </div>
    </div>
  );
}

function Directive({ m }: { m: ConversationItem }) {
  const { projectId, run } = useApp();
  const now = useNow(250);
  const end = m.proceedsAt ? Date.parse(m.proceedsAt) : now;
  const total = m.proceedsAt ? Math.max(1, end - Date.parse(m.ts)) : 1;
  const left = Math.max(0, Math.ceil((end - now) / 1000));
  const settled = m.settled;
  return (
    <div className="embed dir">
      <div className="em-h">
        <span className="em-k">Directive</span>
        <b>
          {settled
            ? settled.outcome === 'applied'
              ? 'Applied'
              : 'Stopped'
            : left > 0
              ? `Applying in ${left} s`
              : 'Applying'}
        </b>
      </div>
      <div className="em-body">
        <p className="m-text" style={{ margin: 0 }}>
          <Who text={m.body} />
        </p>
        {settled ? (
          <div className="em-done">
            <Icon name="checkmark" sm />
            <span>
              <Linked text={settled.summary} />
            </span>
          </div>
        ) : (
          <div className="ack">
            <span className="bar">
              <i style={{ width: `${Math.min(100, ((total - (end - now)) / total) * 100)}%` }} />
            </span>
            <button
              className="btn sm"
              disabled={left === 0}
              onClick={() =>
                void run(() => post(`/projects/${projectId}/directives/${m.directiveId}/stop`))
              }
            >
              Stop
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Composer() {
  const { projectId, composer, setComposer, run } = useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!composer.focus) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [composer.focus]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(132, el.scrollHeight)}px`;
  }, [composer.text]);

  const send = async (text: string, about: string | null = composer.about) => {
    const body = text.trim();
    if (!body || !projectId) return;
    setComposer({ text: '' });
    await run(() => post(`/projects/${projectId}/messages`, { body, ...(about ? { about } : {}) }));
  };
  return (
    <div className="composer">
      <div className="qp" role="group" aria-label="Quick prompts">
        {['Status', 'What needs me?', 'What is next?'].map((q) => (
          <button key={q} onClick={() => void send(q, null)}>
            {q}
          </button>
        ))}
      </div>
      <div className="composer-box">
        <textarea
          ref={ref}
          id="composer"
          rows={1}
          placeholder="Message Cypher"
          aria-label="Message to Cypher"
          value={composer.text}
          onChange={(e) => setComposer({ text: e.target.value, about: composer.about })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(composer.text);
            }
          }}
        />
        <button className="send" aria-label="Send" onClick={() => void send(composer.text)}>
          <Icon name="send" sm />
        </button>
      </div>
      <div className="hint">
        <span>Enter sends</span>
        <span>/status · /pause · /resume · /approve</span>
      </div>
    </div>
  );
}
