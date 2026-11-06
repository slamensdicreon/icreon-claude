/*
 * The portfolio's own sections (design system §8): Team, Workbench, Activity and Scorecard across
 * every project. Each has a Bliss face (the eye, Cypher's line from the API, the few lines a
 * Director reads) and an Everything face (the tables, filtered). Rows open the project at the page
 * they came from.
 */
import type {
  AgentView,
  PortfolioActivity,
  PortfolioScorecard,
  PortfolioTeam,
  PortfolioWorkbench,
} from '@lw/contracts';
import { useMemo, useState } from 'react';
import { clock, shortDay, usd } from '../../lib/fmt';
import { useOverview } from '../../lib/overview';
import { usePoll } from '../../lib/poll';
import { Mode } from '../../mode/Mode';
import { useMode } from '../../mode/mode';
import { useApp, type PortfolioPage } from '../../state';
import { Icon } from '../../theme/icons';
import { Chip } from '../../parts/bits';
import {
  Avatar,
  Button,
  Chips,
  Hero,
  hueOf,
  Kpi,
  Panel,
  SectionHeading,
  TeamLine,
} from '../../ui/cypher/parts';
import { Eye } from '../../ui/Eye';
import { useEyeState } from '../../voice/eye';
import { leadFace, teamName } from '../mission/model';
import { faceOf, roleOf } from '../plan/model';
import s from './portfolio.module.css';
import w2 from './workbenchStory.module.css';

export function PortfolioPageView({ page }: { page: PortfolioPage }) {
  switch (page) {
    case 'team':
      return <TeamPage />;
    case 'workbench':
      return <WorkbenchPage />;
    case 'activity':
      return <ActivityPage />;
    case 'scorecard':
      return <ScorecardPage />;
  }
}

/** The dashboard's time zone, for clocks on rows from many projects. */
function useTz() {
  return useOverview().data?.timezone ?? 'America/New_York';
}

/** Each project's team hue, for rows that carry only the project's id. */
function useHues() {
  const projects = useOverview().data?.projects ?? [];
  return (id: string) => projects.find((p) => p.projectId === id)?.hue ?? null;
}

function Loading({ what, error }: { what: string; error: string | null }) {
  return <p className="type-body">{error ?? `Reading ${what}…`}</p>;
}

/** A project's initials tile in its team's hue, with its name beside it when asked. */
function ProjectMark({
  initials,
  hue,
  name,
}: {
  initials: string;
  hue: Parameters<typeof hueOf>[0];
  name?: string;
}) {
  return (
    <span className={s.project}>
      <span className={`${s.tile} type-label`} style={{ background: hueOf(hue) }} aria-hidden>
        {initials}
      </span>
      {name && <span className={s.projectName}>{name}</span>}
    </span>
  );
}

function BlissHead({ voice }: { voice: PortfolioTeam['voice'] }) {
  const eye = useEyeState();
  return <Hero eye={eye.state} blink={eye.blink} voice={voice} small />;
}

// ------------------------------------------------------------------------------------------ Team

function TeamPage() {
  const { data, error } = usePoll<PortfolioTeam>('/portfolio/team');
  if (!data) return <Loading what="the team" error={error} />;
  return <Mode bliss={<TeamBliss t={data} />} everything={<TeamEverything t={data} />} />;
}

/** Bliss: each live project, its Leads in one line each in Cypher's words. */
function TeamBliss({ t }: { t: PortfolioTeam }) {
  const { openProject } = useApp();
  const live = t.projects.filter((p) => !p.archived);
  return (
    <div className={s.bliss}>
      <BlissHead voice={t.voice} />
      {live.map((p) => (
        <section key={p.projectId} className={s.section} aria-label={p.name}>
          <SectionHeading>
            <ProjectMark initials={p.initials} hue={p.hue} name={p.name} />
          </SectionHeading>
          <div>
            {p.leads.map((l) => (
              <TeamLine
                key={l.agentId}
                face={leadFace(l)}
                team={teamName(l.workstream)}
                read={l.read ?? ''}
                tone={l.readTone ?? (l.blocked ? 'blocked' : l.active ? 'normal' : 'quiet')}
                reports={l.reports ?? []}
                onOpen={() =>
                  openProject(p.projectId, 'team', undefined, { kind: 'agent', id: l.agentId })
                }
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

type TeamFilter = 'all' | 'working' | 'stuck';
const STUCK = new Set(['blocked', 'waiting', 'failed']);

/** Everything: everyone on every project, filtered by state and project. */
function TeamEverything({ t }: { t: PortfolioTeam }) {
  const { openProject } = useApp();
  const [filter, setFilter] = useState<TeamFilter>('all');
  const [project, setProject] = useState('all');
  const rows = useMemo(
    () =>
      t.projects
        .filter((p) => !p.archived && (project === 'all' || p.projectId === project))
        .flatMap((p) => p.agents.map((a) => ({ p, a }))),
    [t, project],
  );
  const shown = rows.filter(({ a }) =>
    filter === 'working' ? a.state === 'active' : filter === 'stuck' ? STUCK.has(a.state) : true,
  );
  const tokens = (a: AgentView) => a.tokensProject;
  return (
    <div className={s.everything}>
      <Panel
        title="Everyone"
        count={shown.length}
        chips={
          <Chips
            label="Who to show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: rows.length },
              {
                value: 'working',
                label: 'Working now',
                count: rows.filter(({ a }) => a.state === 'active').length,
              },
              {
                value: 'stuck',
                label: 'Waiting or blocked',
                count: rows.filter(({ a }) => STUCK.has(a.state)).length,
              },
            ]}
          />
        }
        meta={<ProjectPicker value={project} onChange={setProject} options={t.projects} />}
      >
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>Person</th>
                <th>Project</th>
                <th>State</th>
                <th>Now</th>
                <th className={s.num}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ p, a }) => (
                <tr
                  key={`${p.projectId}:${a.agentId}`}
                  className={s.clickable}
                  onClick={() =>
                    openProject(p.projectId, 'team', undefined, { kind: 'agent', id: a.agentId })
                  }
                >
                  <td>
                    <button type="button" className={s.person}>
                      {a.tier === 'chief_of_staff' ? (
                        <Eye state="resting" size={28} decorative />
                      ) : (
                        <Avatar face={faceOf(a, a.agentId, a.state === 'active')} size="sm" />
                      )}
                      <span className={s.stack}>
                        <b>{a.tier === 'chief_of_staff' ? 'Cypher' : (a.persona ?? a.name)}</b>
                        <span className="type-meta">{roleOf(a)}</span>
                      </span>
                    </button>
                  </td>
                  <td>
                    <ProjectMark initials={p.initials} hue={p.hue} name={p.name} />
                  </td>
                  <td>
                    <Chip state={a.state} />
                  </td>
                  <td className={s.now}>{a.now ?? '—'}</td>
                  <td className={s.num}>{tok(tokens(a))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function ProjectPicker({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { projectId: string; name: string; archived: boolean }[];
}) {
  return (
    <label className={s.picker}>
      <span className="sr-only">Project</span>
      <select className="type-body-small" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="all">Every project</option>
        {options
          .filter((p) => !p.archived)
          .map((p) => (
            <option key={p.projectId} value={p.projectId}>
              {p.name}
            </option>
          ))}
      </select>
      <Icon name="chevron" size={16} />
    </label>
  );
}

const tok = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

// ------------------------------------------------------------------------------------- Workbench

function WorkbenchPage() {
  const { data, error } = usePoll<PortfolioWorkbench>('/portfolio/workbench', 20_000);
  if (!data) return <Loading what="the documents" error={error} />;
  return <Mode bliss={<WorkbenchBliss w={data} />} everything={<WorkbenchEverything w={data} />} />;
}

/** Bliss: Cypher's sentence and at most three documents for you, then the way to the rest. */
function WorkbenchBliss({ w }: { w: PortfolioWorkbench }) {
  const { openProject } = useApp();
  const { setMode } = useMode();
  const tz = useTz();
  const picks = readingList(w.documents).slice(0, 3);
  return (
    <div className={s.bliss}>
      <BlissHead voice={w.voice} />
      <section className={s.section} aria-label="For you">
        <SectionHeading>For you</SectionHeading>
        <ul className={s.lines}>
          {picks.map((d) => (
            <li key={`${d.projectId}:${d.artifactId}`}>
              <button
                type="button"
                className={s.line}
                onClick={() => openProject(d.projectId, 'workbench', { wbArtifact: d.artifactId })}
              >
                <ProjectMark initials={d.initials} hue={d.hue} />
                <span className={s.stack}>
                  <b>{d.headline ?? d.title}</b>
                  <span
                    className="type-meta"
                    data-tone={standingOf(d)?.tone === 'changed' ? 'waiting' : undefined}
                  >
                    {standingOf(d)?.word ?? d.project}
                    {d.author ? ` · ${d.author.name}` : ''}
                    {d.updatedAt ? ` · ${shortDay(d.updatedAt, tz)}` : ''}
                  </span>
                </span>
                <Icon name="forward" size={18} className={s.chev} />
              </button>
            </li>
          ))}
          {picks.length === 0 && <li className="type-body">No documents for you yet.</li>}
        </ul>
      </section>
      {w.documents.length > 0 && (
        <div>
          <Button kind="secondary" onClick={() => setMode('everything')}>
            Everything the teams wrote
          </Button>
        </div>
      )}
    </div>
  );
}

type Doc = PortfolioWorkbench['documents'][number];

/** How a document stands for the Director, in a few words. */
function standingOf(d: Doc): { word: string; tone: string } | null {
  if (d.awaitingApproval) return { word: 'Waits on your approval', tone: 'yours' };
  if (d.changedSinceApproval) return { word: 'Changed since you approved', tone: 'changed' };
  if (d.approved && d.approved.version === d.latest) return { word: 'Approved', tone: 'done' };
  if (d.updatedAt && Date.now() - Date.parse(d.updatedAt) < 48 * 3_600_000)
    return { word: 'New', tone: 'new' };
  return null;
}

/** What to read first across projects: what waits on you, what moved, then the newest for you. */
function readingList(docs: Doc[]): Doc[] {
  const forYou = docs.filter((d) => d.audience !== 'team');
  const rank = (d: Doc) => (d.awaitingApproval ? 0 : d.changedSinceApproval ? 1 : 2);
  return [...forYou].sort(
    (a, b) => rank(a) - rank(b) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
  );
}

const dayFmt = new Map<string, Intl.DateTimeFormat>();
function dayOf(t: string, tz: string): { key: string; label: string } {
  let f = dayFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
    dayFmt.set(tz, f);
  }
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(t));
  const parts = f.formatToParts(new Date(t));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? '';
  return { key, label: `${get('weekday')} ${get('day')} ${get('month')}` };
}
const names = (xs: string[]) =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
const short = (p: string) => p.split(' ')[0] ?? p;
const countWords = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
const said = (n: number) => countWords[n] ?? String(n);

/**
 * Everything: the documents as the week's story. Each day, newest first, lists the documents for
 * you across projects (a short title, two sentences, who wrote it) and folds the team's working
 * files into one line. Beside it: approvals (what moved past what you approved) and each project.
 */
function WorkbenchEverything({ w }: { w: PortfolioWorkbench }) {
  const { openProject } = useApp();
  const tz = useTz();
  const [who, setWho] = useState<'you' | 'all'>('you');
  const [project, setProject] = useState('all');
  const [openDays, setOpenDays] = useState<Set<string>>(() => new Set());
  const inProject = w.documents.filter((d) => project === 'all' || d.projectId === project);
  const projects = [...new Map(w.documents.map((d) => [d.projectId, d])).values()];
  const days = new Map<string, { label: string; docs: Doc[] }>();
  for (const d of inProject) {
    if (!d.updatedAt) continue;
    const day = dayOf(d.updatedAt, tz);
    if (!days.has(day.key)) days.set(day.key, { label: day.label, docs: [] });
    days.get(day.key)!.docs.push(d);
  }
  const open = (d: Doc) => openProject(d.projectId, 'workbench', { wbArtifact: d.artifactId });
  const flagged = w.documents.filter((d) => d.awaitingApproval || d.changedSinceApproval);
  const recentlyApproved = w.documents.filter(
    (d) =>
      d.approved &&
      d.approved.version === d.latest &&
      Date.now() - Date.parse(d.approved.at) < 7 * 86_400_000,
  );

  const row = (d: Doc) => {
    const st = standingOf(d);
    return (
      <li key={`${d.projectId}:${d.artifactId}`}>
        <button
          type="button"
          className={st?.tone === 'yours' ? `${w2.row} ${w2.yours}` : w2.row}
          onClick={() => open(d)}
        >
          <ProjectMark initials={d.initials} hue={d.hue} />
          <span className={w2.rowBody}>
            <span className={w2.rowTop}>
              <span className={`${w2.kind} type-label`}>{kindOf(d)}</span>
              <b className="type-body-small">{d.headline ?? d.title}</b>
              {st && (
                <span className={`${w2.standing} type-meta`} data-tone={st.tone}>
                  {st.word}
                </span>
              )}
            </span>
            {(d.inShort ?? d.summary) && (
              <span className={`${w2.summary} type-body-small`}>{d.inShort ?? d.summary}</span>
            )}
          </span>
          <span className={`${w2.by} type-meta`}>
            {d.author?.name ?? ''}
            <span className={w2.quiet}>{d.project}</span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <div className={w2.page}>
      <div className={w2.main}>
        <div className={w2.top}>
          <p className={`${w2.voice} type-heading`}>
            <Said text={w.voice.text} emphasis={w.voice.emphasis} />
          </p>
        </div>
        <div className={w2.filters}>
          <Chips
            label="Whose documents"
            value={who}
            onChange={setWho}
            options={[
              {
                value: 'you',
                label: 'For you',
                count: inProject.filter((d) => d.audience !== 'team').length,
              },
              { value: 'all', label: 'Everything the teams wrote', count: inProject.length },
            ]}
          />
          <ProjectPicker
            value={project}
            onChange={setProject}
            options={projects.map((d) => ({
              projectId: d.projectId,
              name: d.project,
              archived: false,
            }))}
          />
        </div>
        {[...days.entries()].map(([key, day]) => {
          const forYou = day.docs.filter((d) => d.audience !== 'team');
          const files = day.docs.filter((d) => d.audience === 'team');
          const showFiles = who === 'all' || openDays.has(key);
          const shown = showFiles ? [...forYou, ...files] : forYou;
          if (!shown.length && !files.length) return null;
          const where = names([...new Set(day.docs.map((d) => short(d.project)))]);
          return (
            <section key={key} className={w2.day} aria-label={day.label}>
              <header className={w2.dayHead}>
                <b className="type-section">{day.label}</b>
                <span className={`${w2.quiet} type-meta`}>{where}</span>
              </header>
              <ul className={w2.rows}>
                {shown.map(row)}
                {!showFiles && files.length > 0 && (
                  <li className={`${w2.filesLine} type-meta`}>
                    <span>
                      {where && forYou.length ? 'Also ' : ''}
                      {said(files.length)} working {files.length === 1 ? 'file' : 'files'} from the
                      team: {files.map((d) => d.headline ?? d.title).join(', ')}
                    </span>
                    <button
                      type="button"
                      className={w2.show}
                      onClick={() => setOpenDays((sDays) => new Set(sDays).add(key))}
                    >
                      Show
                    </button>
                  </li>
                )}
              </ul>
            </section>
          );
        })}
        {days.size === 0 && <p className="type-body">No documents yet.</p>}
      </div>

      <aside className={w2.rail} aria-label="Approvals and projects">
        <section className={w2.box}>
          <h2 className={`${w2.boxHead} type-label`}>Approvals</h2>
          {flagged.map((d) => (
            <div
              key={`${d.projectId}:${d.artifactId}`}
              className={w2.flag}
              data-tone={d.awaitingApproval ? 'yours' : 'changed'}
            >
              <span className={w2.flagTop}>
                <ProjectMark initials={d.initials} hue={d.hue} />
                <b className="type-body-small">
                  {short(d.project)}: {d.headline ?? d.title}
                </b>
              </span>
              <span className="type-meta">
                {d.awaitingApproval
                  ? 'Waits on your approval.'
                  : `Version ${d.latest} since you approved version ${d.approved?.version}.`}
              </span>
              <Button kind={d.awaitingApproval ? 'primary' : 'secondary'} onClick={() => open(d)}>
                {d.awaitingApproval ? 'Review it' : 'See what changed'}
              </Button>
            </div>
          ))}
          {recentlyApproved.map((d) => (
            <span key={`a:${d.projectId}:${d.artifactId}`} className={`${w2.done} type-body-small`}>
              <Icon name="check" size={14} />
              {short(d.project)}: {d.headline ?? d.title}, approved {shortDay(d.approved!.at, tz)}
            </span>
          ))}
          {!flagged.length && !recentlyApproved.length && (
            <span className={`${w2.quiet} type-body-small`}>Nothing waits on your approval.</span>
          )}
        </section>
        <section className={w2.box}>
          <h2 className={`${w2.boxHead} type-label`}>By project</h2>
          {projects.map((p) => {
            const mine = w.documents.filter((d) => d.projectId === p.projectId);
            const last = mine
              .map((d) => d.updatedAt ?? '')
              .sort()
              .at(-1);
            return (
              <button
                key={p.projectId}
                type="button"
                className={w2.proj}
                onClick={() => openProject(p.projectId, 'workbench', { wbView: 'story' })}
              >
                <ProjectMark initials={p.initials} hue={p.hue} />
                <span className={w2.rowBody}>
                  <b className="type-body-small">{p.project}</b>
                  <span className={`${w2.quiet} type-meta`}>
                    {said(mine.length)} {mine.length === 1 ? 'document' : 'documents'}
                    {last ? ` · last on ${shortDay(last, tz)}` : ''}
                  </span>
                </span>
                <Icon name="forward" size={16} className={s.chev} />
              </button>
            );
          })}
        </section>
      </aside>
    </div>
  );
}

/** A document's kind in plain words. */
function kindOf(d: Doc): string {
  switch (d.kind) {
    case 'blueprint':
      return 'Build plan';
    case 'platform_notes':
      return 'Briefing';
    case 'inventory':
      return d.audience === 'director' ? 'Content audit' : 'Inventory';
    case 'report':
      return d.audience === 'director' ? 'Results' : 'Quality check';
    case 'pull_request':
      return 'Code change';
    case 'handover_pack':
      return 'Handover';
    default:
      return 'Document';
  }
}

/** Cypher's sentence with the Director's clause in bold. */
function Said({ text, emphasis }: { text: string; emphasis: string | null }) {
  const i = emphasis ? text.indexOf(emphasis) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <b>{emphasis}</b>
      {text.slice(i + emphasis!.length)}
    </>
  );
}

// -------------------------------------------------------------------------------------- Activity

type SevFilter = 'all' | 'warnings' | 'failures';
const SEVERITY: Record<SevFilter, string | null> = {
  all: null,
  warnings: 'warning,failure',
  failures: 'failure',
};

function ActivityPage() {
  return <Mode bliss={<ActivityBliss />} everything={<ActivityEverything />} />;
}

/** Bliss: Cypher's line on the last hour and the last few beats, failures first in coral. */
function ActivityBliss() {
  const { data, error } = usePoll<PortfolioActivity>('/portfolio/activity?limit=12', 8_000);
  const { openProject } = useApp();
  const tz = useTz();
  const hue = useHues();
  if (!data) return <Loading what="the activity" error={error} />;
  return (
    <div className={s.bliss}>
      <BlissHead voice={data.voice} />
      <section className={s.section} aria-label="The last beats">
        <SectionHeading>The last few beats</SectionHeading>
        <ul className={s.lines}>
          {data.items.slice(0, 8).map((i) => (
            <li key={`${i.projectId}:${i.seq}`}>
              <button
                type="button"
                className={s.line}
                data-tone={i.severity === 'failure' ? 'bad' : undefined}
                onClick={() =>
                  openProject(i.projectId, 'activity', {
                    activity: { sev: 'all', agent: i.agentId ?? 'all' },
                  })
                }
              >
                <ProjectMark initials={i.initials} hue={hue(i.projectId)} />
                <span className={s.stack}>
                  <b>
                    {i.who}: {i.operation ?? i.summary}
                  </b>
                  <span className="type-meta">
                    {i.project} · {i.toolLabel}
                    {i.outcome ? ` · ${i.outcome}` : ''}
                    {i.note ? ` · ${i.note}` : ''}
                  </span>
                </span>
                <span className={`${s.when} type-meta`}>{clock(i.ts, tz)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ActivityEverything() {
  const [sev, setSev] = useState<SevFilter>('all');
  const [project, setProject] = useState('all');
  const q = new URLSearchParams({ limit: '150' });
  if (SEVERITY[sev]) q.set('severity', SEVERITY[sev]!);
  if (project !== 'all') q.set('project', project);
  const { data, error } = usePoll<PortfolioActivity>(`/portfolio/activity?${q}`, 8_000);
  const projects = useOverview().data?.projects ?? [];
  const { openProject } = useApp();
  const tz = useTz();
  const hue = useHues();
  return (
    <div className={s.everything}>
      <Panel
        title="Activity"
        count={data?.items.length}
        chips={
          <Chips
            label="Which rows"
            value={sev}
            onChange={setSev}
            options={[
              { value: 'all', label: 'All' },
              { value: 'warnings', label: 'Warnings and failures' },
              { value: 'failures', label: 'Failures' },
            ]}
          />
        }
        meta={
          <ProjectPicker
            value={project}
            onChange={setProject}
            options={projects.map((p) => ({
              projectId: p.projectId,
              name: p.name,
              archived: p.archived,
            }))}
          />
        }
      >
        {!data ? (
          <Loading what="the log" error={error} />
        ) : (
          <div className={s.tableWrap}>
            <table className={`${s.table} type-table`}>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Project</th>
                  <th>Who</th>
                  <th>Tool</th>
                  <th>What happened</th>
                  <th className={s.num}>Result</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr
                    key={`${i.projectId}:${i.seq}`}
                    className={s.clickable}
                    data-tone={
                      i.severity === 'failure'
                        ? 'bad'
                        : i.severity === 'warning'
                          ? 'warn'
                          : undefined
                    }
                    onClick={() =>
                      openProject(i.projectId, 'activity', {
                        activity: { sev: 'all', agent: i.agentId ?? 'all' },
                      })
                    }
                  >
                    <td className={s.nowrap}>{clock(i.ts, tz)}</td>
                    <td>
                      <ProjectMark initials={i.initials} hue={hue(i.projectId)} name={i.project} />
                    </td>
                    <td className={s.nowrap}>{i.who}</td>
                    <td className={s.quiet}>{i.toolLabel}</td>
                    <td className={s.what}>
                      {i.operation ?? i.summary}
                      {i.note && <span className={`${s.note} type-meta`}>{i.note}</span>}
                    </td>
                    <td className={s.num}>{i.outcome ?? '—'}</td>
                  </tr>
                ))}
                {data.items.length === 0 && (
                  <tr>
                    <td colSpan={6} className={s.quiet}>
                      Nothing matches.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------------------------- Scorecard

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n)}%`);
const human = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ');

function ScorecardPage() {
  const { data, error } = usePoll<PortfolioScorecard>('/portfolio/scorecard', 30_000);
  if (!data) return <Loading what="the scorecard" error={error} />;
  return <Mode bliss={<ScoreBliss sc={data} />} everything={<ScoreEverything sc={data} />} />;
}

/** Bliss: Cypher's line, three numbers across every project, and what kept coming back. */
function ScoreBliss({ sc }: { sc: PortfolioScorecard }) {
  const t = sc.totals;
  const numbers: [string, string, string][] = [
    [
      pct(t.settledWithoutDirectorPct),
      'settled without you',
      `${t.settledWithoutDirector} of the settled cards`,
    ],
    [t.cardsPerTask.toFixed(2), 'cards per task', `${t.cards} cards across ${t.tasks} tasks`],
    [pct(t.recommendedTakenPct), 'of recommendations taken', 'when a card came with one'],
  ];
  return (
    <div className={s.bliss}>
      <BlissHead voice={sc.voice} />
      <section className={s.three} aria-label="Three numbers">
        {numbers.map(([value, label, note]) => (
          <div key={label} className={s.big}>
            <span className={`${s.bigValue} type-number-large`}>{value}</span>
            <span className="type-card-title">{label}</span>
            <span className={`${s.quiet} type-meta`}>{note}</span>
          </div>
        ))}
      </section>
      {sc.repeats.length > 0 && (
        <section className={s.section} aria-label="What kept coming back">
          <SectionHeading>What kept coming back</SectionHeading>
          <ul className={s.lines}>
            {sc.repeats.slice(0, 5).map((r) => (
              <li key={`${r.projectId}-${r.category}-${r.title}`} className={s.plain}>
                <span className={s.grow}>{r.title}</span>
                <span className={`${s.quiet} type-meta`}>
                  {r.project} · {human(r.category)} · {r.count} times
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ScoreEverything({ sc }: { sc: PortfolioScorecard }) {
  const { openProject } = useApp();
  const t = sc.totals;
  return (
    <div className={s.everything}>
      <section className={s.kpis} aria-label="Key numbers">
        <Kpi
          label="Cards per task"
          value={t.cardsPerTask.toFixed(2)}
          note={`${t.cards} cards, ${t.tasks} tasks`}
        />
        <Kpi
          label="Settled without you"
          value={pct(t.settledWithoutDirectorPct)}
          note={`${t.settledWithoutDirector} cards`}
        />
        <Kpi
          label="Recommendations taken"
          value={pct(t.recommendedTakenPct)}
          note="Of cards that had one"
        />
        <Kpi
          label="Sent back"
          value={pct(t.rejectionRate)}
          note={`${t.rejections} of ${t.reviews} reviews · ${usd(t.usd)} spent`}
        />
      </section>

      <Panel title="By project" meta="Each project's numbers, side by side">
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>Project</th>
                <th className={s.num}>Tasks</th>
                <th className={s.num}>Cards per task</th>
                <th className={s.num}>Settled without you</th>
                <th className={s.num}>Recommendations taken</th>
                <th className={s.num}>Sent back</th>
                <th className={s.num}>Spend</th>
              </tr>
            </thead>
            <tbody>
              {sc.projects.map((p) => (
                <tr
                  key={p.projectId}
                  className={s.clickable}
                  onClick={() => openProject(p.projectId, 'scorecard')}
                >
                  <td>
                    <button type="button" className={s.docTitle}>
                      <ProjectMark initials={p.initials} hue={p.hue} name={p.name} />
                    </button>
                  </td>
                  <td className={s.num}>
                    {p.totals.done} of {p.totals.tasks}
                  </td>
                  <td className={s.num}>{p.totals.cardsPerTask.toFixed(2)}</td>
                  <td className={s.num}>{pct(p.totals.settledWithoutDirectorPct)}</td>
                  <td className={s.num}>{pct(p.totals.recommendedTakenPct)}</td>
                  <td className={s.num}>{pct(p.totals.rejectionRate)}</td>
                  <td className={s.num}>{usd(p.totals.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="By category" meta="Who settled each kind of card, every project together">
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>Category</th>
                <th className={s.num}>Raised</th>
                <th className={s.num}>Open</th>
                <th className={s.num}>You</th>
                <th className={s.num}>Leads and rules</th>
                <th className={s.num}>Default</th>
                <th className={s.num}>Recommendation taken</th>
              </tr>
            </thead>
            <tbody>
              {sc.categories.map((c) => (
                <tr key={c.category}>
                  <td>{human(c.category)}</td>
                  <td className={s.num}>{c.raised}</td>
                  <td className={s.num}>{c.open}</td>
                  <td className={s.num}>{c.settled.director ?? 0}</td>
                  <td className={s.num}>{(c.settled.lead ?? 0) + (c.settled.rule ?? 0)}</td>
                  <td className={s.num}>{c.settled.default ?? 0}</td>
                  <td className={s.num}>
                    {c.withRecommendation
                      ? `${c.recommendedTaken} of ${c.withRecommendation}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {sc.repeats.length > 0 && (
        <Panel title="Kept coming back" meta="Cards with the same cause">
          {sc.repeats.map((r) => (
            <div key={`${r.projectId}-${r.category}-${r.title}`} className={`${s.row} type-table`}>
              <span className={s.grow}>{r.title}</span>
              <span className={s.quiet}>
                {r.project} · {human(r.category)}
              </span>
              <b>{r.count}</b>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
