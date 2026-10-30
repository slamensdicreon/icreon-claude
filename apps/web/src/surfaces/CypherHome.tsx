import type { CypherMessage, CypherProposal } from '@lw/contracts';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiProblem } from '../lib/api';
import { cypher, useCypher } from '../lib/cypher';
import { age } from '../lib/fmt';
import { NewProject } from '../overlays/NewProject';
import { useApp } from '../state';

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
  const { openOverlay } = useApp();
  const d = p.draft;
  const source = [d.sourceUrl, d.repo].filter(Boolean).join(' · ') || 'No source yet';
  return (
    <div className="cy-proposal">
      <div className="cy-p-head">
        <span className="cy-p-kind">
          {p.kind === 'remix' ? `Remix of ${d.from?.name}` : 'New project'}
        </span>
        <strong>{d.name}</strong>
      </div>
      <dl>
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
      {p.reason && <p className="cy-p-why">{p.reason}</p>}
      {p.notCovered.length > 0 && (
        <p className="cy-p-gap">
          <strong>Not covered:</strong> {p.notCovered.join('; ')}
        </p>
      )}
      <button
        className="btn primary sm"
        onClick={() => openOverlay(<NewProject remix={{ draft: d, connectionName: null }} />)}
      >
        Review and create
      </button>
    </div>
  );
}

function Message({ m }: { m: CypherMessage }) {
  const { switchProject } = useApp();
  if (m.role === 'director')
    return (
      <div className="cy-m me">
        <div className="cy-bubble">{m.body}</div>
      </div>
    );
  return (
    <div className="cy-m">
      <div className="cy-who">
        Cypher <span>{age(m.at)}</span>
      </div>
      <div className="cy-text">
        <Prose text={m.body} />
      </div>
      {m.proposals.map((p, i) => (
        <Proposal key={i} p={p} />
      ))}
      {m.projects.length > 0 && (
        <div className="cy-links">
          {m.projects.map((p) => (
            <button key={p.id} className="dash-chip" onClick={() => switchProject(p.id)}>
              Open {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "just now", "12 min ago", "3 h ago", "4 days ago": when a conversation was last touched. */
export function when(t: string): string {
  const h = (Date.now() - Date.parse(t)) / 3_600_000;
  if (h < 2) return age(t);
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * Cypher above every project: ask about the portfolio, describe a project for him to draft, or
 * ask for a site like an existing one. He drafts; the Director reviews and creates in the wizard.
 * The page opens on a new chat; saved conversations are listed in the sidebar and open here.
 */
export function CypherHome() {
  const { toast } = useApp();
  const s = useCypher();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!s.loaded) void cypher.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Scrolls the conversation, never the page around it.
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [s.active?.messages.length, pending]);

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
      toast(err instanceof ApiProblem ? err.message : 'Cypher could not answer. Try again.');
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

  const active = s.active;
  const messages = active?.messages ?? [];
  const inChat = messages.length > 0 || pending !== null;
  return (
    <section className="cy-home">
      <header className="cy-head">
        <span className="cy-avatar" aria-hidden="true">
          C
        </span>
        <div>
          <h2>{active?.title ?? 'Cypher'}</h2>
          <p>{active ? `Chief of Staff · ${when(active.updatedAt)}` : 'Chief of Staff'}</p>
        </div>
        <div className="cy-actions">
          {(s.activeId || inChat) && (
            <button className="btn sm" onClick={fresh} disabled={Boolean(pending)}>
              New chat
            </button>
          )}
        </div>
      </header>
      {s.loaded && !s.available ? (
        <p className="quiet-line">Cypher needs the model, which isn’t configured on this server.</p>
      ) : (
        <>
          {inChat && (
            <div className="cy-convo" aria-live="polite" ref={box}>
              {messages.map((m) => (
                <Message key={m.id} m={m} />
              ))}
              {pending && (
                <>
                  <div className="cy-m me">
                    <div className="cy-bubble">{pending}</div>
                  </div>
                  <div className="cy-m">
                    <div className="cy-who">Cypher</div>
                    <div className="cy-thinking">Reading the portfolio…</div>
                  </div>
                </>
              )}
            </div>
          )}
          {!inChat && s.opening && <p className="quiet-line">Opening the conversation…</p>}
          {!inChat && !s.opening && (
            <div className="cy-starters">
              {STARTERS.map((st) => (
                <button
                  key={st}
                  className="dash-chip"
                  onClick={() => {
                    setText(st.replace(/…$/, ''));
                    input.current?.focus();
                  }}
                >
                  {st}
                </button>
              ))}
            </div>
          )}
          <form
            className="cy-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={input}
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
              className="btn primary"
              type="submit"
              disabled={!text.trim() || Boolean(pending)}
            >
              Send
            </button>
          </form>
        </>
      )}
    </section>
  );
}
