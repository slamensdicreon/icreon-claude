/*
 * Workbench in Bliss (PLAN.md › Component mapping): one document in plain words and what to look
 * at in it, with the others as quiet lines to switch to. The words come from the API: the producing
 * agent's summary and pointers, or Cypher's from what the document carries. The UI writes none of
 * its own, except a marked stand-in for an API that predates the field.
 */
import type { ArtifactView, LinkTarget, WorkbenchSnapshot } from '@lw/contracts';
import { useRef } from 'react';
import { shortDay } from '../../lib/fmt';
import { useMode } from '../../mode/mode';
import { useJump } from '../../parts/bits';
import { useApp, useMission, useProjectResource, useRoster } from '../../state';
import { Icon } from '../../theme/icons';
import { Avatar, Button, SectionHeading } from '../../ui/cypher/parts';
import { Eye } from '../../ui/Eye';
import s from './workbenchBliss.module.css';

const latestAt = (a: ArtifactView) =>
  a.versions.find((v) => v.version === a.latest)?.ts ?? a.versions[0]?.ts ?? '';

/** The document shown first: the one a gate waits on, else the newest. */
function firstOf(docs: ArtifactView[]): ArtifactView | undefined {
  return docs.find((a) => a.awaitingApproval) ?? docs[0];
}

export function WorkbenchBliss() {
  const wb = useProjectResource<WorkbenchSnapshot>('/workbench').data;
  const tz = useMission().data?.project.timezone ?? 'America/New_York';
  const { ui, setUi } = useApp();
  const { setMode } = useMode();
  const { byId } = useRoster();
  const jump = useJump();
  const card = useRef<HTMLElement>(null);
  if (!wb) return <p className="type-body">Reading the Workbench…</p>;
  if (!wb.artifacts.length)
    return (
      <div className={s.bliss}>
        <SectionHeading>The documents</SectionHeading>
        <p className={`${s.quiet} type-body`}>No documents yet.</p>
      </div>
    );

  const docs = [...wb.artifacts].sort((x, y) => latestAt(y).localeCompare(latestAt(x)));
  const shown = docs.find((a) => a.artifactId === ui.wbArtifact) ?? firstOf(docs)!;
  const others = docs.filter((a) => a.artifactId !== shown.artifactId);
  const latest = shown.versions.find((v) => v.version === shown.latest) ?? shown.versions[0];
  const writer = latest ? byId(latest.producer) : undefined;
  const byAgent = shown.summaryBy === 'agent' && writer && writer.tier !== 'chief_of_staff';
  const name = writer ? (writer.persona ?? writer.name) : '';
  const approved = shown.approved[0];

  const openEverything = (artifactId: string) => {
    setUi({ wbArtifact: artifactId });
    setMode('everything');
  };
  // A pointer into this Workbench opens the console there; anything else follows the link.
  const follow = (t: LinkTarget) => {
    if (t.kind === 'artifact') return openEverything(t.ref || shown.artifactId);
    if (t.kind === 'decision') return openEverything('decisions');
    jump(t);
  };

  return (
    <div className={s.bliss}>
      <article ref={card} className={s.doc} aria-labelledby="wb-bliss-title" tabIndex={-1}>
        <div className={`${s.eyebrow} type-label`}>
          {shown.awaitingApproval ? (
            <span className={s.yours}>Waits on your approval</span>
          ) : approved && approved.version === shown.latest ? (
            <span>Approved at {approved.gate}</span>
          ) : (
            <span>Version {shown.latest}</span>
          )}
          {latest && <span className={s.when}>{shortDay(latest.ts, tz)}</span>}
        </div>
        <h1 id="wb-bliss-title" className={`${s.title} type-heading`}>
          {shown.title}
        </h1>

        <div className={s.voice}>
          <span className={s.who} aria-hidden="true">
            {byAgent ? (
              <Avatar
                face={{
                  agentId: writer.agentId,
                  name,
                  firstName: name.split(' ')[0] ?? name,
                  initials: name
                    .split(/\s+/)
                    .map((w) => w[0])
                    .join('')
                    .slice(0, 2)
                    .toUpperCase(),
                  workstream: writer.workstream,
                  working: false,
                }}
                size="md"
              />
            ) : (
              <Eye state="resting" size={34} decorative />
            )}
          </span>
          <div className={s.words}>
            {shown.summary ? (
              <p className={`${s.summary} type-body`}>{shown.summary}</p>
            ) : (
              // Stand-in for an API without document summaries: facts only, no voice.
              <p className={`${s.summary} type-body`}>
                Version {shown.latest}
                {approved ? `, version ${approved.version} approved at ${approved.gate}` : ''}.
              </p>
            )}
            <span className={`${s.by} type-meta`}>
              {byAgent ? `In ${name.split(' ')[0]}’s words` : 'Cypher, from the document'}
            </span>
          </div>
        </div>

        {!!shown.attention?.length && (
          <section className={s.look} aria-label="What to look at">
            <h2 className={`${s.lookHead} type-label`}>What to look at</h2>
            <ul className={s.pointers}>
              {shown.attention.map((p, i) => (
                <li key={i}>
                  <button type="button" className={s.pointer} onClick={() => follow(p.target)}>
                    <span className="type-body">{p.label}</span>
                    <Icon name="forward" size={18} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div>
          <Button kind="secondary" onClick={() => openEverything(shown.artifactId)}>
            Open in Everything
          </Button>
        </div>
      </article>

      {others.length > 0 && (
        <section className={s.others} aria-label="The other documents">
          <SectionHeading>The other documents</SectionHeading>
          <ul className={s.list}>
            {others.map((a) => (
              <li key={a.artifactId}>
                <button
                  type="button"
                  className={s.line}
                  onClick={() => {
                    setUi({ wbArtifact: a.artifactId });
                    // The document now shown is at the top: bring it into view and focus.
                    requestAnimationFrame(() => {
                      card.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
                      card.current?.focus({ preventScroll: true });
                    });
                  }}
                >
                  <Icon name="workbench" size={20} />
                  <span className={s.lineText}>
                    <b className="type-body">{a.title}</b>
                    <span
                      className="type-meta"
                      data-tone={a.awaitingApproval ? 'yours' : undefined}
                    >
                      {a.awaitingApproval ? 'Waits on your approval' : `Version ${a.latest}`}
                      {latestAt(a) ? ` · ${shortDay(latestAt(a), tz)}` : ''}
                    </span>
                  </span>
                  <Icon name="forward" size={18} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
