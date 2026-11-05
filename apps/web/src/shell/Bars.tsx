/*
 * The top of the shell (design system §8). Everything: a top bar on surface with the page title
 * and a one-line subtitle, search, the dial and the presence pill. Bliss: no bar, just the project
 * switcher pill, the date and the dial floating on bliss.
 */
import { clock, longDay, usd, zoneLabel } from '../lib/fmt';
import { count, useOverview } from '../lib/overview';
import { useConn } from '../lib/live';
import { Dial } from '../mode/Dial';
import { Palette } from '../overlays/Palette';
import { MANAGE, SURFACE_LABEL, useApp, useMission, useNow } from '../state';
import { Icon } from '../theme/icons';
import { Eye } from '../ui/Eye';
import { EYE_WORDS, useEyeState } from '../voice/eye';
import { ProjectSwitcher } from './Nav';
import styles from './Shell.module.css';

const HEALTH_WORD = {
  healthy: 'healthy',
  attention: 'needs attention',
  blocked: 'blocked',
} as const;

/** The page's name, as the top bar titles it. */
function usePageTitle(): [string, string | null] {
  const { projectId, surface, view } = useApp();
  if (projectId) return [SURFACE_LABEL[surface], null];
  if (view === 'dashboard') return ['Dashboard', 'Every project and where it stands'];
  if (view === 'new') return ['New project', 'Pick the platform and the playbook, then the source'];
  const page = MANAGE.find(([p]) => p === view);
  return page ? [page[1], page[2]] : ['Cypher', null];
}

/** Facts under the title inside a project: phase, health, spend, the time there; and the line's state. */
function useProjectLine(): string[] {
  const mc = useMission().data;
  const now = useNow(15_000);
  const conn = useConn();
  if (!mc) return [];
  const p = mc.project;
  const phase = p.currentPhase;
  const parts = [
    p.name,
    phase
      ? `${phase.name} at ${phase.percent ?? 0}%`
      : p.status === 'completed'
        ? 'complete'
        : 'not started',
    HEALTH_WORD[p.health],
    `${usd(p.spent.usd)} of ${usd(p.budgets.usd)}`,
    `${clock(now, p.timezone)} ${zoneLabel(p.timezone)}`,
  ];
  if (p.status === 'paused') parts.push('paused');
  if (p.holds.length) parts.push(`held: ${p.holds.map((h) => h.label).join(', ')}`);
  if (conn.kind === 'reconnecting') parts.push('reconnecting');
  if (conn.kind === 'catching-up') parts.push(`catching up${conn.n ? `, ${conn.n} events` : ''}`);
  return parts;
}

/** The Dashboard's line: "Tuesday, November 3 · 11:42 AM ET · four projects, 61 agents". */
function useDashboardLine(on: boolean): string | null {
  const now = useNow(15_000);
  const o = useOverview().data;
  if (!on || !o) return null;
  const tz = o.timezone;
  return [
    longDay(now, tz),
    `${clock(now, tz)} ${zoneLabel(tz)}`,
    `${count(o.counts.running, 'project')}, ${count(o.counts.agents, 'agent')}`,
  ].join(' · ');
}

export function TopBar() {
  const { projectId, openOverlay, view } = useApp();
  const [title, hint] = usePageTitle();
  const line = useProjectLine();
  const dash = useDashboardLine(!projectId && view === 'dashboard');
  const subtitle = projectId ? line.join(' · ') : (dash ?? hint);
  const mac = /Mac|iPhone|iPad/.test(navigator.userAgent);
  return (
    <header className={styles.topbar}>
      <span className={styles.titles}>
        <h1 className="type-title">{title}</h1>
        {subtitle && <span className="type-meta">{subtitle}</span>}
      </span>
      <button
        className={`${styles.search} type-body-small`}
        onClick={() => openOverlay(<Palette />)}
        aria-keyshortcuts={mac ? 'Meta+K' : 'Control+K'}
      >
        <Icon name="search" size={18} />
        <span>Search, or a command</span>
        <span className={`${styles.kbd} type-meta`} aria-hidden="true">
          {mac ? '⌘K' : 'Ctrl K'}
        </span>
      </button>
      <Dial />
      <Presence />
    </header>
  );
}

/** The presence pill: the eye in its state and what that means for the Director. */
function Presence() {
  const { projectId, go, toast, projects } = useApp();
  const mc = useMission().data;
  const eye = useEyeState();
  const yours = eye.state === 'needs-a-word';
  const word = yours ? `${eye.yours} yours` : EYE_WORDS[eye.state];
  const first = mc?.waitingOnYou.find((x) => x.status === 'open');
  const open = () => {
    if (projectId) {
      if (first) go('inbox', { expanded: first.escalationId });
      else toast('Nothing is waiting on you');
      return;
    }
    if (!projects.some((p) => p.waitingCount > 0)) toast('Nothing is waiting on you');
  };
  return (
    <button
      className={`${styles.presence} type-button`}
      data-yours={yours || undefined}
      onClick={open}
      aria-label={`Cypher: ${word}`}
    >
      <Eye state={eye.state} blink={eye.blink} size={26} decorative />
      <span aria-hidden="true">{word}</span>
    </button>
  );
}

export function BlissHeader() {
  const { projects, projectId, layout, setLayout } = useApp();
  const mc = useMission().data;
  const o = useOverview().data;
  const now = useNow(15_000);
  const p = projects.find((x) => x.id === projectId);
  // Inside a project, its own time; above them all, the running projects' zone.
  const tz =
    (projectId ? mc?.project.timezone : o?.timezone) ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const where = p?.subtitle ?? p?.client ?? null;
  const when = projectId
    ? `${longDay(now, tz).split(',')[0]} ${clock(now, tz)}`
    : `${longDay(now, tz)} · ${clock(now, tz)}`;
  return (
    <header className={styles.blissHeader}>
      <ProjectSwitcher />
      <span className="type-body-small">{where ? `${where} · ${when}` : when}</span>
      {layout.present ? (
        <button
          className={`${styles.exitPresent} type-button`}
          onClick={() => setLayout({ present: false })}
        >
          Exit presentation
        </button>
      ) : (
        <span className={styles.dialSlot}>
          <Dial />
        </span>
      )}
    </header>
  );
}
