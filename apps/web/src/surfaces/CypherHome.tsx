import type { CypherConversation, CypherMessage, CypherProposal } from '@lw/contracts';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiProblem, del, get, postFor } from '../lib/api';
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

/**
 * Cypher above every project: ask about the portfolio, describe a project for him to draft, or
 * ask for a site like an existing one. He drafts; the Director reviews and creates in the wizard.
 */
export function CypherHome() {
  const { toast } = useApp();
  const [convo, setConvo] = useState<CypherConversation | null>(null);
  const [text, setText] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    get<CypherConversation>('/cypher')
      .then(setConvo)
      .catch(() => setConvo({ available: false, messages: [] }));
  }, []);
  useEffect(() => {
    // Scrolls the conversation, never the page around it.
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [convo?.messages.length, pending]);

  const send = async () => {
    const body = text.trim();
    if (!body || pending) return;
    setPending(body);
    setText('');
    try {
      setConvo(await postFor<CypherConversation>('/cypher', { body }));
    } catch (err) {
      setText(body);
      toast(err instanceof ApiProblem ? err.message : 'Cypher could not answer. Try again.');
    } finally {
      setPending(null);
    }
  };

  const restart = async () => {
    try {
      await del('/cypher');
      setConvo((c) => (c ? { ...c, messages: [] } : c));
    } catch (err) {
      toast(err instanceof ApiProblem ? err.message : 'The conversation could not be cleared.');
    }
  };

  const messages = convo?.messages ?? [];
  const recent = open ? messages : messages.slice(-2);
  return (
    <section className="cy-home" aria-label="Cypher">
      <header className="cy-head">
        <span className="cy-avatar" aria-hidden="true">
          C
        </span>
        <div>
          <h2>Cypher</h2>
          <p>Chief of Staff. Ask about any project, or describe one to start.</p>
        </div>
        <div className="cy-actions">
          {messages.length > 2 && (
            <button className="btn sm" onClick={() => setOpen((o) => !o)}>
              {open ? 'Show less' : `Show all ${messages.length}`}
            </button>
          )}
          {messages.length > 0 && (
            <button className="btn sm" onClick={restart} disabled={Boolean(pending)}>
              New conversation
            </button>
          )}
        </div>
      </header>
      {convo && !convo.available ? (
        <p className="quiet-line">Cypher needs the model, which isn’t configured on this server.</p>
      ) : (
        <>
          {(recent.length > 0 || pending) && (
            <div className="cy-convo" aria-live="polite" ref={box}>
              {recent.map((m) => (
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
          {messages.length === 0 && !pending && (
            <div className="cy-starters">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  className="dash-chip"
                  onClick={() => {
                    setText(s.replace(/…$/, ''));
                    input.current?.focus();
                  }}
                >
                  {s}
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
              rows={2}
              value={text}
              placeholder="Message Cypher: a question, a brief, or “a site like Ansco for …”"
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
