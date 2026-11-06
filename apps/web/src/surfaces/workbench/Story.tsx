/*
 * Workbench, the story so far (Everything): the documents in the order the work happened. Each
 * phase, newest first, says in one line what it was about, the approvals given in it, its
 * documents for the Director as cards (a short title, two sentences, who wrote it, when, how long
 * to read) and the team's working files folded into one line. Beside it: what to read first, who
 * wrote what, and the next phase. Every word comes from the API; opening a document switches to
 * All files with it open.
 */
import type { ArtifactView, StoryPhase, WorkbenchSnapshot, Workstream } from '@lw/contracts';
import type { ReactNode } from 'react';
import { shortDay } from '../../lib/fmt';
import { useApp, useRoster, useTz } from '../../state';
import { Icon } from '../../theme/icons';
import { Chips, hueOf } from '../../ui/cypher/parts';
import s from './story.module.css';

/** What kind of document it is, in plain words. */
export function kindWord(a: ArtifactView): string {
  switch (a.kind) {
    case 'blueprint':
      return 'Build plan';
    case 'platform_notes':
      return 'Briefing';
    case 'inventory':
      return a.audience === 'director' ? 'Content audit' : 'Inventory';
    case 'report':
      return a.audience === 'director' ? 'Results' : 'Quality check';
    case 'pull_request':
      return 'Code change';
    case 'handover_pack':
      return 'Handover';
    case 'screenshot':
      return 'Screenshot';
    case 'video':
      return 'Video';
    default:
      return 'Document';
  }
}

/** A small line drawing per kind, on the author's team tint. */
const GLYPH: Record<string, string> = {
  blueprint: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14',
  platform_notes: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7',
  inventory: 'M9 6h11M9 12h11M9 18h11M4 6h1M4 12h1M4 18h1',
  report: 'M5 20V10M12 20V4M19 20v-7M3 20h18',
  pull_request: 'M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16',
  handover_pack: 'M4 7h16v13H4zM9 7V4h6v3M4 12h16',
  screenshot: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4',
  video: 'M4 6h12v12H4zM16 10l4-2v8l-4-2',
};
export function Glyph({ kind, size = 20 }: { kind: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={GLYPH[kind] ?? GLYPH.platform_notes} />
    </svg>
  );
}

const latestAt = (a: ArtifactView) =>
  a.versions.find((v) => v.version === a.latest)?.ts ?? a.versions[0]?.ts ?? '';
const NEW_FOR = 48 * 3_600_000;
const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

/** How a document stands for the Director, in a word or three; null when nothing to say. */
export function standing(a: ArtifactView, now = Date.now()): { word: string; tone: string } | null {
  if (a.awaitingApproval) return { word: 'Waits on your approval', tone: 'yours' };
  if (a.changedSinceApproval) return { word: 'Changed since you approved', tone: 'changed' };
  const approved = a.approved[0];
  if (approved && approved.version === a.latest) return { word: 'Approved', tone: 'done' };
  if (latestAt(a) && now - Date.parse(latestAt(a)) < NEW_FOR) return { word: 'New', tone: 'new' };
  return null;
}

export function useOpenDocument() {
  const { setUi } = useApp();
  return (artifactId: string) =>
    setUi({ wbArtifact: artifactId, wbView: 'files', bpFilter: 'all' });
}

/** The Story and All files switch, shared by both views. */
export function ViewSwitch() {
  const { ui, setUi } = useApp();
  return (
    <Chips
      label="Workbench view"
      value={ui.wbView}
      onChange={(v) => setUi({ wbView: v })}
      options={[
        { value: 'story', label: 'Story' },
        { value: 'files', label: 'All files' },
      ]}
    />
  );
}

export function WorkbenchStory({ wb }: { wb: WorkbenchSnapshot }) {
  const tz = useTz();
  const { byId } = useRoster();
  const open = useOpenDocument();
  const story = wb.story;
  const docs = new Map(wb.artifacts.map((a) => [a.artifactId, a]));
  const hue = (a: ArtifactView) =>
    hueOf((byId(a.author?.agentId)?.workstream as Workstream | null | undefined) ?? null);

  if (!story) return <p className="type-body">Reading the story…</p>;

  const card = (a: ArtifactView) => {
    const st = standing(a);
    const color = hue(a);
    return (
      <li key={a.artifactId}>
        <button type="button" className={s.doc} onClick={() => open(a.artifactId)}>
          <span className={s.tile} style={{ '--hue': color } as React.CSSProperties}>
            <Glyph kind={a.kind} />
          </span>
          <span className={s.docBody}>
            <span className={s.docTop}>
              <span className={`${s.kind} type-label`}>{kindWord(a)}</span>
              {st && (
                <span className={`${s.standing} type-meta`} data-tone={st.tone}>
                  {st.word}
                </span>
              )}
            </span>
            <b className={`${s.headline} type-section`}>{a.headline ?? a.title}</b>
            {a.headline && a.headline !== a.title && (
              <span className={`${s.real} type-meta`}>
                {a.title}
                {a.latest > 1 ? ` · version ${a.latest}` : ''}
              </span>
            )}
            {(a.inShort ?? a.summary) && (
              <span className={`${s.summary} type-body-small`}>{a.inShort ?? a.summary}</span>
            )}
            <span className={`${s.meta} type-meta`}>
              {a.author && (
                <span className={s.avatar} style={{ background: color }} aria-hidden="true">
                  {initialsOf(a.author.name)}
                </span>
              )}
              {a.author && <b>{a.author.name}</b>}
              {a.author && <span>{a.author.role}</span>}
              <span>· {shortDay(latestAt(a), tz)}</span>
              {a.readMinutes != null && (
                <span>
                  · {a.readMinutes} minute{a.readMinutes === 1 ? '' : 's'} to read
                </span>
              )}
            </span>
          </span>
        </button>
      </li>
    );
  };

  const phase = (p: StoryPhase) => {
    const forYou = p.docs.map((id) => docs.get(id)).filter((a): a is ArtifactView => !!a);
    const files = p.files.map((id) => docs.get(id)).filter((a): a is ArtifactView => !!a);
    const now = p.status === 'current';
    const empty = !forYou.length && !files.length && !p.milestones.length;
    return (
      <section
        key={p.number}
        className={s.phase}
        data-now={now || undefined}
        data-empty={empty || undefined}
      >
        <span className={s.node} aria-hidden="true" />
        <header className={s.phaseHead}>
          <span className={`${s.phaseName} type-label`}>
            {p.number >= 0 ? `Phase ${p.number} · ${p.name}` : p.name}
          </span>
          <span className={`${s.when} type-meta`}>
            {now ? 'Now' : ''}
            {now && p.at ? ' · ' : ''}
            {p.at ? `began ${shortDay(p.at, tz)}` : ''}
          </span>
        </header>
        {p.line ? (
          <p className={`${s.line} type-body-small`}>{p.line}</p>
        ) : empty ? (
          <p className={`${s.line} ${s.quiet} type-body-small`}>
            {now ? 'Nothing written in this phase yet.' : 'No documents from this phase.'}
          </p>
        ) : null}
        {p.milestones.map((m) => (
          <span key={m.at + m.label} className={`${s.milestone} type-meta`}>
            <Icon name="check" size={14} />
            {m.label}
            <span className={s.quiet}> · {shortDay(m.at, tz)}</span>
          </span>
        ))}
        {forYou.length > 0 && <ul className={s.docs}>{forYou.map(card)}</ul>}
        {files.length > 0 && (
          <div className={s.files}>
            <span className={`${s.quiet} type-meta`}>
              The team also wrote{' '}
              {files.length === 1 ? 'one working file' : `${files.length} working files`}:
            </span>
            {files.map((a) => (
              <button
                key={a.artifactId}
                type="button"
                className={`${s.file} type-meta`}
                onClick={() => open(a.artifactId)}
                title={a.inShort ?? a.summary ?? a.title}
              >
                <Glyph kind={a.kind} size={14} />
                {a.headline ?? a.title}
              </button>
            ))}
          </div>
        )}
      </section>
    );
  };

  const emph = story.voice.emphasis;
  const i = emph ? story.voice.text.indexOf(emph) : -1;
  const sentence: ReactNode =
    i < 0 ? (
      story.voice.text
    ) : (
      <>
        {story.voice.text.slice(0, i)}
        <b>{emph}</b>
        {story.voice.text.slice(i + emph!.length)}
      </>
    );

  return (
    <div className={s.story}>
      <div className={s.main}>
        <div className={s.top}>
          <p className={`${s.voice} type-heading`}>{sentence}</p>
          <ViewSwitch />
        </div>
        {story.phases.length ? (
          <div className={s.timeline}>{story.phases.map(phase)}</div>
        ) : (
          <p className={`${s.quiet} type-body`}>The story starts when the first phase begins.</p>
        )}
      </div>

      <aside className={s.rail} aria-label="Reading guide">
        {story.startHere.length > 0 && (
          <section className={s.box}>
            <h2 className={`${s.boxHead} type-label`}>Start here</h2>
            <p className={`${s.quiet} type-body-small`}>
              New to the project, or back after a while? These tell the story.
            </p>
            <ol className={s.start}>
              {story.startHere.map((p, n) => {
                const a = docs.get(p.artifactId);
                if (!a) return null;
                return (
                  <li key={p.artifactId}>
                    <button
                      type="button"
                      className={s.startItem}
                      onClick={() => open(a.artifactId)}
                    >
                      <span className={s.num} aria-hidden="true">
                        {n + 1}
                      </span>
                      <span className={s.startText}>
                        <b className="type-body-small">{a.headline ?? a.title}</b>
                        <span className={`${s.quiet} type-meta`}>
                          {p.why}
                          {a.readMinutes != null ? ` · ${a.readMinutes} min` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
        {story.authors.length > 0 && (
          <section className={s.box}>
            <h2 className={`${s.boxHead} type-label`}>Who wrote what</h2>
            <ul className={s.authors}>
              {story.authors.slice(0, 6).map((w) => (
                <li key={w.agentId} className="type-body-small">
                  <span
                    className={s.avatar}
                    style={{
                      background: hueOf((byId(w.agentId)?.workstream as Workstream | null) ?? null),
                    }}
                    aria-hidden="true"
                  >
                    {initialsOf(w.name)}
                  </span>
                  <span className={s.grow}>
                    <b>{w.name}</b> <span className={s.quiet}>{w.role}</span>
                  </span>
                  <span>{w.count}</span>
                </li>
              ))}
            </ul>
            {story.authors.length > 6 && (
              <span className={`${s.quiet} type-meta`}>
                And {story.authors.length - 6} more across the team.
              </span>
            )}
          </section>
        )}
        {story.next && (
          <section className={`${s.box} ${s.next}`}>
            <h2 className={`${s.boxHead} ${s.quiet} type-label`}>Coming next</h2>
            <b className="type-body-small">
              Phase {story.next.number} · {story.next.name}
            </b>
            <span className={`${s.quiet} type-body-small`}>
              {story.next.tasks
                ? `${story.next.tasks} task${story.next.tasks === 1 ? '' : 's'} planned. What it writes lands here.`
                : 'What it writes lands here.'}
            </span>
          </section>
        )}
      </aside>
    </div>
  );
}
