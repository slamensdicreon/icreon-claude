import type { CypherMessage, CypherProposal } from '@lw/contracts';
import { Component, Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiProblem, messageOf } from '../lib/api';
import { cypher, useCypher } from '../lib/cypher';
import { age, ago } from '../lib/fmt';
import s from '../dock/dock.module.css';
import { useApp, useNow } from '../state';
import { Icon } from '../theme/icons';
import { Eye } from '../ui/Eye';
import { SmallEye } from '../ui/eye/SmallEye';

const STARTERS = [
  'What needs me today?',
  'Start a project from a brief: …',
  'Set up the next site like Ansco: …',
];

/** **bold**, and nothing else inline: Cypher's answers are short and plain. */
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
}

/** Paragraphs and bullet lists, as React text (never HTML). */
function Prose({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n');
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)))
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>
              ))}
            </ul>
          );
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

function Proposal({ p }: { p: CypherProposal }) {
  const { newProject } = useApp();
  const conversationId = useCypher().active?.id ?? null;
  const d = p.draft;
  const source = [d.sourceUrl, d.repo].filter(Boolean).join(' · ') || 'No source yet';
  return (
    <div className={s.proposal}>
      <div className={s.embedHead}>
        <span className={`${s.kind} type-label`}>
          {p.kind === 'remix' ? `Remix of ${d.from?.name}` : 'New project'}
        </span>
        <b className="type-section">{d.name}</b>
      </div>
      <dl className={`${s.facts} type-body-small`}>
        <dt>Client</dt>
        <dd>{d.client}</dd>
        <dt>Playbook</dt>
        <dd>{d.playbookId}</dd>
        <dt>Source</dt>
        <dd>{source}</dd>
        <dt>Credentials</dt>
        <dd>
          {d.connectionId
            ? `From a saved connection (${d.providedCredentials.length} reused)`
            : 'Entered in the wizard'}
        </dd>
      </dl>
      {p.reason && <p className={`${s.text} type-body-small`}>{p.reason}</p>}
      {p.notCovered.length > 0 && (
        <p className={`${s.gap} type-body-small`}>
          <strong>Not covered:</strong> {p.notCovered.join('; ')}
        </p>
      )}
      <button
        type="button"
        className={`${s.btn} type-button`}
        data-primary
        onClick={() =>
          newProject({
            remix: { draft: d, connectionName: null },
            origin: { conversationId, reason: p.reason, notCovered: p.notCovered },
          })
        }
      >
        Review and create
      </button>
    </div>
  );
}

function Message({ m }: { m: CypherMessage }) {
  // Keeps the relative times ("12 min ago") current.
  useNow(15_000);
  const { switchProject } = useApp();
  if (m.role === 'director')
    return (
      <div className={s.me}>
        <div className={`${s.bubble} type-body-small`}>{m.body}</div>
      </div>
    );
  return (
    <div className={s.m}>
      <span className={s.mark} aria-hidden="true">
        <Eye state="resting" size={22} decorative />
      </span>
      <div className={s.main}>
        <div className={`${s.meta} type-meta`}>
          <b>Cypher</b>
          <span>{age(m.at)}</span>
        </div>
        <div className={`${s.prose} type-body-small`}>
          <Prose text={m.body} />
        </div>
        {m.proposals.map((p, i) => (
          <Proposal key={i} p={p} />
        ))}
        {(m.filed ?? []).length > 0 && (
          <ul className={`${s.filed} type-meta`}>
            {m.filed.map((f) => (
              <li key={f.ref}>
                Proposed <span className={s.ref}>{f.ref}</span> {f.title}: waiting for you under
                Menu → {f.kind === 'rule' ? 'Rules' : 'Knowledge'}.
              </li>
            ))}
          </ul>
        )}
        {m.projects.length > 0 && (
          <div className={s.actions}>
            {m.projects.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`${s.btn} type-button`}
                onClick={() => switchProject(p.id)}
              >
                Open {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Cypher above every project: ask about the portfolio, describe a project for him to draft, or
 * ask for a site like an existing one. He drafts; the Director reviews and creates in the wizard.
 * The page opens on a new chat; saved conversations are listed in the sidebar and open here.
 */
/** A bad conversation never takes the Dashboard down: the panel shows what happened and offers a new chat. */
class CypherBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className={s.home}>
        <header className={s.homeHead}>
          <Eye state="resting" size={34} decorative />
          <div className={s.who}>
            <h2 className={`${s.name} type-section`}>Cypher</h2>
            <p className={`${s.role} type-meta`}>Chief of Staff</p>
          </div>
        </header>
        <p className={`${s.quiet} type-body-small`}>
          This conversation could not be shown ({this.state.error.message}).
        </p>
        <div>
          <button
            type="button"
            className={`${s.btn} type-button`}
            onClick={() => {
              cypher.fresh();
              this.setState({ error: null });
            }}
          >
            New chat
          </button>
        </div>
      </section>
    );
  }
}

export function CypherHome() {
  return (
    <CypherBoundary>
      <CypherPanel />
    </CypherBoundary>
  );
}

function CypherPanel() {
  // Keeps the relative times ("12 min ago") current.
  useNow(15_000);
  const { toast } = useApp();
  const st = useCypher();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!st.loaded) void cypher.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Scrolls the conversation, never the page around it.
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [st.active?.messages.length, pending]);

  const send = async () => {
    const body = text.trim();
    if (!body || pending) return;
    setPending(body);
    setText('');
    try {
      await cypher.send(body);
    } catch (err) {
      setText(body);
      if (err instanceof ApiProblem && err.status === 404) {
        cypher.fresh();
        void cypher.load();
      }
      toast(messageOf(err, 'Cypher could not answer. Try again.'));
    } finally {
      setPending(null);
    }
  };

  const fresh = () => {
    if (pending) return;
    cypher.fresh();
    setText('');
    input.current?.focus();
  };

  const active = st.active;
  const messages = active?.messages ?? [];
  const inChat = messages.length > 0 || pending !== null;
  return (
    <section className={s.home}>
      <header className={s.homeHead}>
        <SmallEye state="watching" size={34} lively thinking={Boolean(pending)} />
        <div className={s.who}>
          <h2 className={`${s.name} type-section`}>{active?.title ?? 'Cypher'}</h2>
          <p className={`${s.role} type-meta`}>
            {active ? `Chief of Staff · ${ago(active.updatedAt)}` : 'Chief of Staff'}
          </p>
        </div>
        {(st.activeId || inChat) && (
          <button
            type="button"
            className={`${s.btn} type-button`}
            onClick={fresh}
            disabled={Boolean(pending)}
          >
            <Icon name="plus" size={18} />
            New chat
          </button>
        )}
      </header>
      {st.loaded && !st.available ? (
        <p className={`${s.quiet} type-body-small`}>
          Cypher needs the model, which isn’t configured on this server.
        </p>
      ) : (
        <>
          {inChat && (
            <div className={s.homeConvo} aria-live="polite" ref={box}>
              {messages.map((m) => (
                <Message key={m.id} m={m} />
              ))}
              {pending && (
                <>
                  <div className={s.me}>
                    <div className={`${s.bubble} type-body-small`}>{pending}</div>
                  </div>
                  <div className={s.m}>
                    <span className={s.mark} aria-hidden="true">
                      <Eye state="watching" size={22} decorative />
                    </span>
                    <div className={s.main}>
                      <div className={`${s.meta} type-meta`}>
                        <b>Cypher</b>
                      </div>
                      <p className={`${s.thinking} type-body-small`}>Reading the portfolio…</p>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {!inChat && st.opening && (
            <p className={`${s.quiet} type-body-small`}>Opening the conversation…</p>
          )}
          {!inChat && !st.opening && (
            <div className={s.starters} role="group" aria-label="Ways to start">
              {STARTERS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className={`${s.prompt} type-meta`}
                  onClick={() => {
                    setText(q.replace(/…$/, ''));
                    input.current?.focus();
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          )}
          <form
            className={s.compose}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div className={s.box}>
              <textarea
                ref={input}
                className={`${s.input} type-body-small`}
                value={text}
                rows={3}
                placeholder={
                  active
                    ? 'Continue this conversation…'
                    : 'Ask about a project, give a brief, or ask for “a site like Ansco for …”'
                }
                aria-label="Message Cypher"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <button
                className={s.send}
                type="submit"
                aria-label="Send"
                disabled={!text.trim() || Boolean(pending)}
              >
                <Icon name="send" size={18} />
              </button>
            </div>
            <span className={`${s.hint} type-meta`}>
              <span>Enter sends · Shift Enter for a new line</span>
            </span>
          </form>
        </>
      )}
    </section>
  );
}
