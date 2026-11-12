import type { ConversationItem } from '@lw/contracts';
import { useEffect, useRef } from 'react';
import { messageOf, post } from '../lib/api';
import { clock, localDate, longDay, zoneLabel } from '../lib/fmt';
import { TYPE_LABEL } from '../lib/escalation';
import { Chip, useJump, Who } from '../parts/bits';
import { useApp, useConversation, useNow, useRoster, useTz } from '../state';
import { Icon } from '../theme/icons';
import { Eye } from '../ui/Eye';
import { SmallEye } from '../ui/eye/SmallEye';
import { useEyeState } from '../voice/eye';
import s from './dock.module.css';

const ORDER: Record<string, number> = {
  blocker: 0,
  access: 1,
  gate: 2,
  decision: 3,
  budget: 4,
  risk: 5,
};

/** Escalation kinds the Director has to act on before work moves: coral; a gate is ink. */
const toneOf = (type: string) =>
  type === 'blocker' || type === 'access' ? 'yours' : type === 'gate' ? 'gate' : undefined;

/**
 * The Chief of Staff's conversation for the project on screen, inside the Cypher sheet: the eye
 * and its presence, what needs the Director (pointing to Needs you), the thread and the composer.
 */
export function Dock() {
  const { go } = useApp();
  const conv = useConversation().data;
  const eye = useEyeState();
  const thinking = conv?.presence === 'thinking';
  // Decisions are made in Needs you; the chat only points there, so it stays a conversation.
  const open = (conv?.queue ?? [])
    .filter((x) => x.status === 'open')
    .sort(
      (a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || a.raisedAt.localeCompare(b.raisedAt),
    );
  const waiting = open.length;

  return (
    <aside className={s.dock} aria-label="Cypher">
      <div className={s.head}>
        <SmallEye state={eye.state} blink={eye.blink} size={34} lively thinking={thinking} />
        <div className={s.who}>
          <h2 className={`${s.name} type-section`}>Cypher</h2>
          <p className={`${s.role} type-meta`}>Chief of Staff</p>
        </div>
        <span className={`${s.presence} type-meta`} data-thinking={thinking || undefined}>
          <i aria-hidden="true" />
          <span>{thinking ? 'Thinking' : 'Listening'}</span>
        </span>
      </div>
      {waiting > 0 && (
        <button
          type="button"
          className={s.needs}
          onClick={() => go('inbox', { expanded: open[0]!.escalationId })}
        >
          <span className={`${s.needsCount} type-label`}>{waiting}</span>
          <span className={`${s.needsText} type-meta`}>
            <b>{waiting === 1 ? 'Needs you' : `${waiting} need you`}</b>
            <span>{open[0]!.title}</span>
          </span>
          <span className={`${s.needsGo} type-button`}>Review</span>
        </button>
      )}
      <Conversation items={conv?.items ?? []} />
      <Composer />
    </aside>
  );
}

function DayLabel({ t, tz, now }: { t: string; tz: string; now: number }) {
  const today = localDate(t, tz) === localDate(now, tz);
  return (
    <div className={`${s.day} type-label`}>
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
    <div className={s.convo} ref={ref} aria-live="polite">
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
            type="button"
            className={`${s.dref} type-meta`}
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
    <div className={s.actions}>
      {links.map((l) => (
        <button
          key={l.label}
          type="button"
          className={`${s.btn} type-button`}
          onClick={() => jump(l.target)}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}

function Message({ m, grouped, tz }: { m: ConversationItem; grouped: boolean; tz: string }) {
  const jump = useJump();
  const { byId } = useRoster();
  const { go } = useApp();
  const t = `${clock(m.ts, tz)} ${zoneLabel(tz)}`;
  if (m.from === 'director')
    return (
      <div className={s.me}>
        <span className={`${s.meta} type-meta`}>{t}</span>
        <div className={`${s.bubble} type-body-small`}>{m.body}</div>
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
      <div className={s.embed}>
        <div className={s.embedHead}>
          <span className={`${s.kind} type-label`}>
            {m.label ?? (m.kind === 'digest' ? 'Daily digest' : 'Brief')}
          </span>
          <b>{m.title}</b>
        </div>
        <div className={`${s.rows} type-body-small`}>
          {m.rows.map((r) => (
            <div className={s.row} key={r.label}>
              <span>{r.label}</span>
              <div>
                <Linked text={r.value} />
              </div>
            </div>
          ))}
          {m.sections.map((sec) => (
            <div className={s.row} key={sec.heading}>
              <span>{sec.heading}</span>
              <div>{sec.lines.join(' ')}</div>
            </div>
          ))}
          {m.bullets.length > 0 && (
            <ul className={s.list}>
              {m.bullets.map((b, i) => (
                <li key={i}>
                  <span>
                    <Linked text={b} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {m.body && !m.rows.length && !m.bullets.length && <p className={s.text}>{m.body}</p>}
        </div>
        {m.note && (
          <div className={`${s.note} type-meta`}>
            <Icon name="info" size={16} />
            <span>
              <Who text={m.note} />
            </span>
          </div>
        )}
        <Actions links={m.links} />
      </div>
    );
  } else if (m.kind === 'status' && m.status) {
    const st = m.status;
    body = (
      <div className={s.embed}>
        <div className={s.embedHead}>
          <span className={`${s.kind} type-label`}>Status</span>
          <b>
            {st.phase}, {st.percent}% done
          </b>
        </div>
        <div className={`${s.grid} type-body-small`}>
          <div>
            <span>Blockers</span>
            <b data-bad={st.blockers.length > 0 || undefined}>{st.blockers.length || 'None'}</b>
            {st.blockers.length > 0 && <small>{st.blockers.join(', ')}</small>}
          </div>
          <div>
            <span>Needs you</span>
            <b>{st.waiting}</b>
          </div>
          <div>
            <span>{st.headline.label}</span>
            <b>{st.headline.value}</b>
            {st.headline.sub && <small>{st.headline.sub}</small>}
          </div>
          <div>
            <span>Next gate</span>
            <b>{st.nextGate}</b>
          </div>
          <div>
            <span>Cost</span>
            <b>{st.cost}</b>
          </div>
          <div>
            <span>Elapsed</span>
            <b>{st.elapsed}</b>
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
      <div className={s.embed}>
        <div className={s.embedHead}>
          <span className={`${s.kind} type-label`}>Needs you</span>
          <b>
            {m.needs.length} {m.needs.length === 1 ? 'item' : 'items'} waiting on your call
          </b>
        </div>
        <div className={`${s.rows} type-body-small`}>
          {m.needs.map((n) => (
            <div className={s.item} key={n.escalationId}>
              <span className={`${s.type} type-label`} data-tone={toneOf(n.type)}>
                {TYPE_LABEL[n.type]}
              </span>
              <span className={s.itemText}>{n.title}</span>
              <button
                type="button"
                className={`${s.btn} type-button`}
                onClick={() => go('inbox', { expanded: n.escalationId })}
              >
                Open
              </button>
            </div>
          ))}
        </div>
      </div>
    ) : (
      <p className={`${s.text} type-body-small`}>Nothing is waiting on you.</p>
    );
  } else if (m.kind === 'next') {
    body = (
      <div className={s.embed}>
        <div className={s.embedHead}>
          <span className={`${s.kind} type-label`}>Up next</span>
          <b>The next {m.upNext.length} activities</b>
        </div>
        <div className={`${s.rows} type-body-small`}>
          {m.upNext.map((x) => {
            const a = byId(x.agentId);
            return (
              <div className={s.item} key={x.taskId}>
                <span className={`${s.time} type-meta`}>{clock(x.start, tz)}</span>
                <span className={s.itemText}>
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
        <p className={`${s.text} type-body-small`}>
          <Linked text={m.body} />
        </p>
        {m.links.length > 0 && (
          <div className={s.links}>
            {m.links.map((l) => (
              <button
                key={l.label}
                type="button"
                className={`${s.link} type-body-small`}
                onClick={() => jump(l.target)}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <div className={s.m} data-grouped={grouped || undefined}>
      {/* Cypher is the eye; a run of plain messages shows it once. */}
      <span className={s.mark} aria-hidden="true">
        {!grouped && <Eye state="resting" size={22} decorative />}
      </span>
      <div className={s.main}>
        {grouped ? (
          <span className="sr-only">Cypher, {t}</span>
        ) : (
          <div className={`${s.meta} type-meta`}>
            <b>Cypher</b>
            <span>{t}</span>
          </div>
        )}
        {body}
      </div>
    </div>
  );
}

function Directive({ m }: { m: ConversationItem }) {
  const { projectId, run } = useApp();
  // The countdown and its bar only show until the directive settles.
  const now = useNow(m.settled ? null : 250);
  const end = m.proceedsAt ? Date.parse(m.proceedsAt) : now;
  const total = m.proceedsAt ? Math.max(1, end - Date.parse(m.ts)) : 1;
  const left = Math.max(0, Math.ceil((end - now) / 1000));
  const settled = m.settled;
  return (
    <div className={s.embed}>
      <div className={s.embedHead}>
        <span className={`${s.kind} type-label`}>Directive</span>
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
      <div className={`${s.rows} type-body-small`}>
        <p className={s.text}>
          <Who text={m.body} />
        </p>
        {settled ? (
          <div className={s.done}>
            <Icon name="check" size={16} />
            <span>
              <Linked text={settled.summary} />
            </span>
          </div>
        ) : (
          <div className={s.ack}>
            <span className={s.bar}>
              <i style={{ width: `${Math.min(100, ((total - (end - now)) / total) * 100)}%` }} />
            </span>
            <button
              type="button"
              className={`${s.btn} type-button`}
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
  const { projectId, composer, setComposer, run, toast } = useApp();
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
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
  /**
   * A file for the team (a logo, a brand kit, a content export): stored with the project and
   * listed in every agent's context. What's typed in the box goes with it as its note.
   */
  const attach = async (file: File) => {
    if (!projectId) return;
    // A saved page (Chrome's "Webpage, Single File", .mhtml) holds its images: up to 40 MB.
    const savedPage = /\.mht(ml)?$/i.test(file.name);
    if (file.size > (savedPage ? 40 : 10) * 1024 * 1024) {
      toast(savedPage ? 'Saved pages can be up to 40 MB.' : 'Files can be up to 10 MB.');
      return;
    }
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(r.error ?? new Error('The file could not be read.'));
      r.readAsDataURL(file);
    });
    const note = composer.text.trim();
    try {
      await post(`/projects/${projectId}/files`, {
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        dataBase64,
        ...(note ? { note } : {}),
        ...(composer.about ? { about: composer.about } : {}),
      });
      setComposer({ text: '' });
      toast(`${file.name} is with the team.`);
    } catch (err) {
      toast(messageOf(err, 'The file could not be attached.'));
    }
  };
  return (
    <div className={s.composer}>
      <div className={s.prompts} role="group" aria-label="Quick prompts">
        {['Status', 'What needs me?', 'What is next?'].map((q) => (
          <button
            key={q}
            type="button"
            className={`${s.prompt} type-meta`}
            onClick={() => void send(q, null)}
          >
            {q}
          </button>
        ))}
      </div>
      <div className={s.box}>
        <textarea
          ref={ref}
          id="composer"
          className={`${s.input} type-body-small`}
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
        <input
          ref={picker}
          type="file"
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void attach(file);
          }}
        />
        <button
          type="button"
          className={s.attach}
          aria-label="Attach a file for the team"
          title="Attach a file for the team (what you type goes with it)"
          onClick={() => picker.current?.click()}
        >
          <Icon name="attach" size={18} />
        </button>
        <button
          type="button"
          className={s.send}
          aria-label="Send"
          disabled={!composer.text.trim()}
          onClick={() => void send(composer.text)}
        >
          <Icon name="send" size={18} />
        </button>
      </div>
      <div className={`${s.hint} type-meta`}>
        <span>Enter sends · the clip attaches a file</span>
        <span>/status · /pause · /resume · /approve</span>
      </div>
    </div>
  );
}
