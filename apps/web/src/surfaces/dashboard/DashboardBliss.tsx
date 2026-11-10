import type { PortfolioOverview, PortfolioProject } from '@lw/contracts';
import { age, clock } from '../../lib/fmt';
import { useMode } from '../../mode/mode';
import { useApp, useNow } from '../../state';
import { clockOf, kindOf, raisedLine, useYoursActions } from '../../ui/cypher/cards';
import {
  Button,
  Handled,
  Hero,
  hueOf,
  ProjectTile,
  SectionHeading,
  urgencyOf,
  YoursCard,
} from '../../ui/cypher/parts';
import { useEyeState } from '../../voice/eye';
import { shortContext } from '../mission/Decision';
import { ago } from '../mission/model';
import s from './dashboard.module.css';
import { platformOf, playbookShort } from './projectNames';
import { showProjectsView, type View } from './ProjectsTable';

/** Up to this many projects get a tile each; past it, a line per state. */
const TILES = 6;

/**
 * The portfolio in Bliss (Dashboard-Bliss board): the eye and Cypher's sentence, at most three
 * things that are the Director's with Cypher's pick inside, the projects, and what was handled
 * without them. A few projects get a tile each; past six, the rest fold into a line per state
 * (moving, ready to start, paused, finished) and the book by platform: Bliss never lists fifty
 * tiles. Each line opens the Everything table on that view.
 */
export function DashboardBliss({ o, refresh }: { o: PortfolioOverview; refresh: () => void }) {
  const { switchProject } = useApp();
  const eye = useEyeState();
  const now = useNow(30_000);
  const live = o.projects.filter((p) => !p.archived);
  const calm = live.every((p) => p.readTone !== 'blocked');
  const shown = o.yours.slice(0, 3);
  return (
    <div className={s.bliss}>
      <Hero
        eye={eye.state}
        blink={eye.blink}
        voice={o.voice}
        urgency={urgencyOf(
          o.yours.map((y) => y.escalation.deadline),
          now,
        )}
      />

      {shown.length > 0 && (
        <section className={s.three} aria-label="Yours" id="yours">
          {shown.map((y) => (
            <YoursTile
              key={y.escalation.escalationId}
              y={y}
              tz={o.timezone}
              now={now}
              refresh={refresh}
            />
          ))}
        </section>
      )}
      {o.yours.length > 3 && (
        <p className={`${s.more} type-meta`}>
          {o.yours.length - 3} more wait their turn in Everything.
        </p>
      )}

      {o.projects.length > TILES ? (
        <ProjectLines projects={o.projects} calm={calm} />
      ) : (
        <section className={s.section} aria-label="Projects" id="projects">
          <SectionHeading>{calm ? 'Everyone else is fine.' : 'The projects'}</SectionHeading>
          <div className={s.four}>
            {live.map((p) => (
              <ProjectTile
                key={p.projectId}
                name={p.name}
                phase={p.phaseName ?? p.phaseLabel}
                percent={p.percent}
                hue={hueOf(p.hue)}
                eye={p.eye}
                read={p.read}
                tone={p.readTone}
                faces={p.faces}
                word={p.workingWord}
                yours={p.yours > 0}
                onOpen={() => switchProject(p.projectId)}
              />
            ))}
          </div>
        </section>
      )}

      {o.handled.length > 0 && (
        <section className={s.section} aria-label="Handled">
          <SectionHeading>Handled without you</SectionHeading>
          <Handled
            items={o.handled}
            timeOf={(at) => clock(at, o.timezone).replace(/\s?[AP]M$/, '')}
          />
        </section>
      )}
    </div>
  );
}

/** "Acme, Globex and Initech"; past four names, "and 6 more". */
function names(ps: PortfolioProject[]): string {
  const n = ps.map((p) => p.name);
  if (n.length > 4) return `${n.slice(0, 3).join(', ')} and ${n.length - 3} more`;
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : (n[0] ?? '');
}
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const count = (n: number) => WORDS[n] ?? String(n);

interface Line {
  key: string;
  tone: 'moving' | 'waiting' | 'paused' | 'done';
  title: string;
  text: string;
  projects: PortfolioProject[];
  view: View;
  action: string;
}

function ProjectLines({ projects, calm }: { projects: PortfolioProject[]; calm: boolean }) {
  const { switchProject } = useApp();
  const { setMode } = useMode();
  const see = (view: View) => {
    showProjectsView(view);
    setMode('everything');
  };
  const moving = projects.filter((p) => p.status === 'running' && p.yours === 0);
  const look = moving.filter((p) => p.readTone === 'blocked');
  const ready = projects.filter((p) => p.status === 'intake' && p.yours === 0);
  const paused = projects.filter((p) => p.status === 'paused' && p.yours === 0);
  const finished = projects.filter((p) => p.archived && p.status !== 'archived');
  const lines: Line[] = [
    {
      key: 'moving',
      tone: 'moving',
      title: `${count(moving.length)} moving`,
      text: look.length
        ? `${names(look)} ${look.length === 1 ? 'wants' : 'want'} a look; the rest are on pace.`
        : 'On pace. Nothing in them needs you.',
      projects: moving,
      view: 'running',
      action: `See all ${moving.length}`,
    },
    {
      key: 'ready',
      tone: 'waiting',
      title: `${count(ready.length)} ready to start`,
      text: `${names(ready)}. Intake is done; start ${ready.length === 1 ? 'it' : 'one'} when you’re ready.`,
      projects: ready,
      view: 'intake',
      action: ready.length === 1 ? 'See it' : 'See them',
    },
    {
      key: 'paused',
      tone: 'paused',
      title: `${count(paused.length)} paused`,
      text: `${names(paused)}. Paused costs nothing: resume ${paused.length === 1 ? 'it' : 'them'}, or archive what you’re done with.`,
      projects: paused,
      view: 'paused',
      action: 'Tidy up',
    },
    {
      key: 'finished',
      tone: 'done',
      title: `${count(finished.length)} finished`,
      text: `${names(finished)}. Still listed: archive ${finished.length === 1 ? 'it' : 'them'} to keep this short.`,
      projects: finished,
      view: 'archived',
      action: finished.length === 1 ? 'See it' : 'See them',
    },
  ].filter((l) => l.projects.length > 0) as Line[];

  // The book: projects by platform, and by playbook within it.
  const live = projects.filter((p) => p.status !== 'archived');
  const platforms = new Map<string, PortfolioProject[]>();
  for (const p of live) platforms.set(platformOf(p), [...(platforms.get(platformOf(p)) ?? []), p]);
  const book = [...platforms.entries()].sort((a, b) => b[1].length - a[1].length);

  return (
    <>
      <section className={s.section} aria-label="Projects" id="projects">
        <SectionHeading>
          {calm ? 'Everyone else is fine.' : 'Everything else, a line each'}
        </SectionHeading>
        <ul className={s.lines}>
          {lines.map((l) => (
            <li key={l.key} className={s.line} aria-label={l.title}>
              <span className={s.lineDot} data-tone={l.tone} aria-hidden="true" />
              <span className={s.lineText}>
                <span className="type-section">{l.title}</span>
                <span className={`${s.lineSay} type-body-small`}>{l.text}</span>
              </span>
              <span className={s.lineTiles}>
                {l.projects.slice(0, 8).map((p) => (
                  <button
                    key={p.projectId}
                    type="button"
                    className={`${s.miniTile} type-label`}
                    style={{ background: l.tone === 'done' ? 'var(--text-3)' : hueOf(p.hue) }}
                    title={`${p.name}: ${p.phaseLabel}`}
                    aria-label={`Open ${p.name}`}
                    onClick={() => switchProject(p.projectId)}
                  >
                    {p.initials}
                  </button>
                ))}
                {l.projects.length > 8 && (
                  <span className={`${s.miniMore} type-meta`}>+{l.projects.length - 8}</span>
                )}
              </span>
              <Button kind="secondary" onClick={() => see(l.view)}>
                {l.action}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <section className={s.section} aria-label="Your book">
        <SectionHeading>Your book, by platform</SectionHeading>
        <div className={s.book}>
          {book.map(([platform, ps]) => {
            const byPlaybook = new Map<string, number>();
            for (const p of ps)
              byPlaybook.set(playbookShort(p), (byPlaybook.get(playbookShort(p)) ?? 0) + 1);
            const yours = ps.filter((p) => p.yours > 0).length;
            return (
              <div key={platform} className={s.bookCard}>
                <span className="type-label">{platform}</span>
                <span className={`${s.bookNumber} type-number`}>{ps.length}</span>
                <span className={`${s.lineSay} type-body-small`}>
                  {[...byPlaybook.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([name, n]) => `${n} ${name.toLowerCase()}`)
                    .join(' · ')}
                  {yours > 0 && ` · ${count(yours).toLowerCase()} waiting on you`}
                </span>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}

function YoursTile({
  y,
  tz,
  now,
  refresh,
}: {
  y: PortfolioOverview['yours'][number];
  tz: string;
  now: number;
  refresh: () => void;
}) {
  const x = y.escalation;
  const act = useYoursActions(y.projectId, y.project, refresh);
  const { primary, secondary } = act.cardActions(x);
  const body = x.gist ?? shortContext(x.context);
  return (
    <YoursCard
      kind={kindOf(x)}
      project={y.project}
      clock={clockOf(x, tz).replace(/\s?[AP]M$/, '')}
      clockYours={!!x.deadline}
      title={x.title}
      body={body}
      rec={x.recommendation ?? null}
      primary={primary}
      secondary={secondary}
      raiser={x.raisedBy ?? null}
      meta={raisedLine(x, ago(age(x.raisedAt, now)))}
    />
  );
}
