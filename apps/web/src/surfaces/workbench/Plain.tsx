/*
 * A document in plain words. Above every document: "In plain words", Cypher's reading of it (what it
 * settles, what it means, what you need to do, usually nothing) and the terms it can't avoid. For
 * documents meant for the Director, a switch between Cypher's plain version (shown first) and the
 * team's own, technical one. The plain version is written once per version by the API and never
 * replaces the original; while it is being written, the author's own summary stands in.
 */
import type { ArtifactView, PlainVersion } from '@lw/contracts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { get, postFor } from '../../lib/api';
import { BASE_GLOSSARY, GlossaryContext, type Term } from '../../lib/glossary';
import { MarkdownDoc } from '../../parts/Doc';
import { useApp } from '../../state';
import { Button, Chips } from '../../ui/cypher/parts';
import { SmallEye } from '../../ui/eye/SmallEye';
import { DocHead } from './parts';
import d from './doc.module.css';
import s from './plain.module.css';

type View = 'plain' | 'technical';

/** The plain version of a version, asked for until it is written (a minute at most). */
function usePlain(projectId: string | null, artifactId: string, version: number, nonce = 0) {
  const [p, setP] = useState<PlainVersion | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    let tries = 0;
    let timer = 0;
    if (!nonce) setP(null);
    const ask = () =>
      get<PlainVersion>(`/projects/${projectId}/artifacts/${artifactId}/versions/${version}/plain`)
        .then((r) => {
          if (stop) return;
          setP(r);
          if (r.status === 'writing' && ++tries < 30) timer = window.setTimeout(ask, 2500);
        })
        .catch(() => !stop && setP(null));
    void ask();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [projectId, artifactId, version, nonce]);
  return p;
}

export function PlainLayer({ a, children }: { a: ArtifactView; children: ReactNode }) {
  const { projectId, run } = useApp();
  const [nonce, setNonce] = useState(0);
  const p = usePlain(projectId, a.artifactId, a.latest, nonce);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const rewrite = async () => {
    const ok = await run(
      () =>
        postFor(
          `/projects/${projectId}/artifacts/${a.artifactId}/versions/${a.latest}/plain/rewrite`,
          {
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        ),
      {
        title: 'Cypher is rewriting it',
        detail: 'The new plain version replaces this one in a minute.',
      },
      'Asking for a new plain version',
    );
    if (ok) {
      setAsking(false);
      setNote('');
      setNonce((n) => n + 1);
    }
  };
  const [chosen, setChosen] = useState<View | null>(null);
  const hasPlain = !!p?.plain;
  // Documents for the Director open in plain words once there are some; the rest as written.
  const view: View = chosen ?? (hasPlain && a.audience === 'director' ? 'plain' : 'technical');
  const terms = useMemo<Term[]>(() => {
    const own = p?.glossary ?? [];
    const ownKeys = new Set(own.map((t) => t.term.toLowerCase()));
    return [...own, ...BASE_GLOSSARY.filter((t) => !ownKeys.has(t.term.toLowerCase()))];
  }, [p?.glossary]);

  const writing = p?.status === 'writing';
  const box =
    p && (p.inShort || writing) ? (
      <section className={s.box} aria-label="In plain words" aria-busy={writing || undefined}>
        <div className={s.boxHead}>
          <SmallEye state={writing ? 'watching' : 'resting'} size={22} thinking={writing} />
          <span className={`${s.label} type-label`}>In plain words</span>
          {writing && (
            <span className={`${s.quiet} type-meta`}>Cypher is writing the plain version…</span>
          )}
          {p.status === 'ready' && (
            <span className={`${s.quiet} type-meta`}>Cypher, from the document</span>
          )}
        </div>
        {p.inShort && <p className={`${s.inShort} type-body`}>{p.inShort}</p>}
        {p.means.length > 0 && (
          <div className={s.part}>
            <span className={`${s.partHead} type-label`}>What it means</span>
            <ul className={s.means}>
              {p.means.map((m) => (
                <li key={m} className="type-body-small">
                  {m}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(p.status === 'ready' || p.toDo) && (
          <div className={s.part}>
            <span className={`${s.partHead} type-label`}>For you to do</span>
            <p className={`${s.todo} type-body-small`} data-yours={p.toDo ? '' : undefined}>
              {p.toDo ?? 'Nothing. This is for your information.'}
            </p>
          </div>
        )}
        {p.status === 'ready' &&
          (asking ? (
            <form
              className={s.ask}
              onSubmit={(e) => {
                e.preventDefault();
                void rewrite();
              }}
            >
              <label className={`${s.partHead} type-label`} htmlFor="plain-note">
                What was wrong with it? (optional)
              </label>
              <textarea
                id="plain-note"
                className={`${s.note} type-body-small`}
                value={note}
                maxLength={500}
                rows={2}
                placeholder="Too technical, missed the point, got something wrong…"
                onChange={(e) => setNote(e.target.value)}
              />
              <div className={s.askActions}>
                <Button kind="primary" onClick={() => void rewrite()}>
                  Rewrite it
                </Button>
                <Button kind="secondary" onClick={() => setAsking(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              className={`${s.again} type-meta`}
              onClick={() => setAsking(true)}
            >
              Not quite right? Ask Cypher for a new plain version
            </button>
          ))}
        {p.glossary.length > 0 && (
          <details className={s.words}>
            <summary className="type-meta">Words you'll see ({p.glossary.length})</summary>
            <dl>
              {p.glossary.map((g) => (
                <div key={g.term}>
                  <dt className="type-body-small">{g.term}</dt>
                  <dd className="type-body-small">{g.meaning}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </section>
    ) : null;

  return (
    <GlossaryContext.Provider value={terms}>
      {hasPlain && (
        <div className={s.switch}>
          <Chips
            label="How to read it"
            value={view}
            onChange={setChosen}
            options={[
              { value: 'plain', label: 'Plain words' },
              { value: 'technical', label: 'Technical' },
            ]}
          />
          <span className={`${s.quiet} type-meta`}>
            {view === 'plain'
              ? `Cypher's plain version of version ${p!.version}. The team's original is under Technical.`
              : 'The team’s own document, as written.'}
          </span>
        </div>
      )}
      {view === 'plain' && hasPlain && projectId ? (
        <>
          <DocHead title={a.headline ?? a.title} meta={`${a.title} · in plain words`} />
          {box && <div className={s.pad}>{box}</div>}
          <div className={`${d.body} ${d.host}`}>
            <MarkdownDoc text={p!.plain!} projectId={projectId} contents={false} />
          </div>
        </>
      ) : (
        <>
          {box && <div className={s.pad}>{box}</div>}
          {children}
        </>
      )}
    </GlossaryContext.Provider>
  );
}
