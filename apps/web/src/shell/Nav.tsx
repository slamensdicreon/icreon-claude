/*
 * The left of the shell (design system §8): the Rail in Bliss, the Sidebar in Everything.
 * Both read the same sections and the same eye. Above any project the sections are the
 * portfolio's (Home or Dashboard, Needs you, Projects, Team, Workbench, Activity, Scorecard); inside
 * one, the project's.
 */
import { DemoMenu, ManageMenu, ProjectMenu } from '../overlays/Menus';
import { isManagePage, useApp, useProjectResource } from '../state';
import { Icon } from '../theme/icons';
import { useRef, useState } from 'react';
import { SmallEye } from '../ui/eye/SmallEye';
import { useGlide } from '../ui/cypher/motion';
import { Ticker } from '../ui/cypher/parts';
import { useEyeState } from '../voice/eye';
import { PORTFOLIO_SECTIONS, PROJECT_SECTIONS } from './sections';
import { ThemeSwitch } from './ThemeSwitch';
import styles from './Shell.module.css';

/** Sections of the Dashboard the portfolio nav jumps to. */
type Spot = 'top' | 'yours' | 'needs' | 'projects';

function useNavState() {
  const app = useApp();
  const p = app.projects.find((x) => x.id === app.projectId);
  const scenarios =
    useProjectResource<{ key: string; label: string }[]>(app.projectId ? '/scenarios' : null)
      .data ?? [];
  const onDashboard = !app.projectId && app.view === 'dashboard';
  /** Opens the Dashboard and brings one of its sections into view. */
  const jump = (spot: Spot) => {
    if (!onDashboard) app.home();
    window.setTimeout(() => {
      const surface = document.querySelector<HTMLElement>('[data-surface]');
      if (spot === 'top') return surface?.scrollTo({ top: 0, behavior: 'smooth' });
      document.getElementById(spot)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };
  // The eye perks up while its button is hovered or focused.
  const [perk, setPerk] = useState(false);
  const perkProps = {
    onPointerEnter: () => setPerk(true),
    onPointerLeave: () => setPerk(false),
    onFocus: () => setPerk(true),
    onBlur: () => setPerk(false),
  };
  return { ...app, p, scenarios, eye: useEyeState(), onDashboard, jump, perk, perkProps };
}

const eyeLabel = (yours: number, state: string) =>
  `Cypher: ${yours ? `${yours} yours` : state === 'watching' ? 'watching' : 'nothing needs you'}`;

/** Bliss: a labelled icon rail on the shell, the eye at the top, a coral dot on Yours. */
export function Rail() {
  const {
    p,
    projectId,
    surface,
    go,
    home,
    openOverlay,
    me,
    scenarios,
    eye,
    onDashboard,
    jump,
    view,
    portfolio,
    perk,
    perkProps,
  } = useNavState();
  const navRef = useRef<HTMLElement>(null);
  const glideRef = useRef<HTMLSpanElement>(null);
  useGlide(navRef, glideRef, `${projectId}:${surface}:${view}`, '[aria-current="page"]');
  const current = (on: boolean) => (on ? 'page' : undefined);
  const item = (
    key: string,
    icon: Parameters<typeof Icon>[0]['name'],
    label: string,
    on: boolean,
    run: () => void,
    dot = false,
  ) => (
    <button key={key} className={styles.railItem} aria-current={current(on)} onClick={run}>
      <Icon name={icon} size={22} />
      <span className="type-rail-label">{label}</span>
      {dot && (
        <span className={styles.railDot}>
          <span className="sr-only">{eye.yours} yours</span>
        </span>
      )}
    </button>
  );
  return (
    <nav ref={navRef} className={styles.rail} aria-label="Cypher">
      <span ref={glideRef} className={styles.navGlide} aria-hidden="true" />
      <button
        className={styles.railEye}
        onClick={home}
        aria-label={`${eyeLabel(eye.yours, eye.state)}. All projects`}
        {...perkProps}
      >
        <SmallEye state={eye.state} blink={eye.blink} size={44} tone="onShell" perk={perk} />
      </button>
      {p
        ? PROJECT_SECTIONS.map((s) =>
            item(
              s.surface,
              s.icon,
              s.short,
              surface === s.surface,
              () => go(s.surface),
              !!s.yours && eye.yours > 0,
            ),
          )
        : [
            item('home', 'home', 'Home', onDashboard, () => jump('top')),
            item('yours', 'inbox', 'Yours', false, () => jump('yours'), eye.yours > 0),
            item('projects', 'projects', 'Projects', false, () => jump('projects')),
            ...PORTFOLIO_SECTIONS.map((x) =>
              item(x.page, x.icon, x.short, view === x.page, () => portfolio(x.page)),
            ),
          ]}
      <span className={styles.grow} />
      {scenarios.length > 0 &&
        item('demo', 'activity', 'Demo', false, () => openOverlay(<DemoMenu />))}
      {projectId && item('all', 'projects', 'All projects', false, home)}
      {item('settings', 'settings', 'Settings', projectId ? surface === 'settings' : false, () =>
        projectId ? go('settings') : openOverlay(<ManageMenu />),
      )}
      <span className={styles.avatar} title={me.name} aria-hidden="true">
        {me.name[0]?.toUpperCase()}
      </span>
    </nav>
  );
}

/** Everything: the full sidebar, with the switcher, sections on row rhythm and the user. */
export function Sidebar() {
  const {
    p,
    projectId,
    surface,
    view,
    go,
    home,
    openOverlay,
    me,
    scenarios,
    eye,
    onDashboard,
    jump,
    portfolio,
    perk,
    perkProps,
  } = useNavState();
  const navRef = useRef<HTMLElement>(null);
  const glideRef = useRef<HTMLSpanElement>(null);
  useGlide(navRef, glideRef, `${projectId}:${surface}:${view}`, '[aria-current="page"]');
  const current = (on: boolean) => (on ? 'page' : undefined);
  const badge =
    eye.yours > 0 ? (
      <span className={`${styles.badge} type-label`}>
        <Ticker value={eye.yours} />
        <span className="sr-only"> yours</span>
      </span>
    ) : null;
  const item = (
    key: string,
    icon: Parameters<typeof Icon>[0]['name'],
    label: string,
    on: boolean,
    run: () => void,
    extra?: React.ReactNode,
    quiet = false,
  ) => (
    <button
      key={key}
      className={`${styles.navItem} ${quiet ? styles.quiet : ''} type-nav`}
      aria-current={current(on)}
      onClick={run}
    >
      <Icon name={icon} />
      {label}
      {extra}
    </button>
  );
  return (
    <nav ref={navRef} className={styles.sidebar} aria-label="Cypher">
      <span ref={glideRef} className={styles.navGlide} aria-hidden="true" />
      <button
        className={styles.brand}
        onClick={home}
        aria-label={`${eyeLabel(eye.yours, eye.state)}. All projects`}
        {...perkProps}
      >
        <SmallEye
          state={eye.state}
          blink={eye.blink}
          size={30}
          tone="onShell"
          perk={perk}
          lively={perk}
        />
        <span className={`${styles.wordmark} type-heading`} aria-hidden="true">
          cypher
        </span>
      </button>
      <ProjectSwitcher onInk />
      <div className={styles.navGap} />
      {p
        ? PROJECT_SECTIONS.map((s) =>
            item(
              s.surface,
              s.icon,
              s.label,
              surface === s.surface,
              () => go(s.surface),
              s.yours ? badge : null,
            ),
          )
        : [
            item('dashboard', 'home', 'Dashboard', onDashboard, () => jump('top')),
            item('needs', 'inbox', 'Needs you', false, () => jump('needs'), badge),
            item('projects', 'projects', 'Projects', false, () => jump('projects')),
            ...PORTFOLIO_SECTIONS.map((x) =>
              item(x.page, x.icon, x.label, view === x.page, () => portfolio(x.page)),
            ),
          ]}
      <span className={styles.grow} />
      {scenarios.length > 0 &&
        item(
          'demo',
          'activity',
          'Demo scenarios',
          false,
          () => openOverlay(<DemoMenu />),
          null,
          true,
        )}
      {projectId && item('all', 'projects', 'All projects', false, home, null, true)}
      {item(
        'settings',
        'settings',
        'Settings',
        projectId ? surface === 'settings' : isManagePage(view),
        () => (projectId ? go('settings') : openOverlay(<ManageMenu />)),
        null,
        true,
      )}
      <div className={styles.user}>
        <span className={styles.avatar} aria-hidden="true">
          {me.name[0]?.toUpperCase()}
        </span>
        <span className={styles.userText}>
          <span className="type-nav">{me.name}</span>
          <span className="type-meta">Director</span>
        </span>
      </div>
      <div className={styles.theme}>
        <ThemeSwitch onShell />
      </div>
    </nav>
  );
}

/**
 * The project switcher: "All projects" above any project, the project's name with its initials
 * tile inside one. A row in the sidebar (on the shell), a pill in Bliss's floating header.
 */
export function ProjectSwitcher({ onInk = false }: { onInk?: boolean }) {
  const { projects, projectId, openOverlay } = useApp();
  const p = projects.find((x) => x.id === projectId);
  const running = projects.filter((x) => x.status === 'running' || x.status === 'paused').length;
  const archived = projects.filter((x) =>
    ['completed', 'cancelled', 'archived'].includes(x.status),
  ).length;
  const sub = p
    ? p.currentPhase
      ? `${p.currentPhase.name}, ${p.currentPhase.percent ?? 0}%`
      : (p.subtitle ?? p.client)
    : `${running} running · ${archived} archived`;
  return (
    <button
      className={onInk ? styles.switcher : styles.switcherPill}
      onClick={() => openOverlay(<ProjectMenu />)}
      aria-haspopup="menu"
      aria-label={`Switch project: ${p?.name ?? 'All projects'}`}
    >
      <span className={`${styles.tile} type-label`} data-all={!p || undefined} aria-hidden="true">
        {p?.initials ?? <Icon name="projects" size={18} />}
      </span>
      <span className={styles.switcherText}>
        <span className="type-nav">{p?.name ?? 'All projects'}</span>
        {onInk && <span className="type-meta">{sub}</span>}
      </span>
      <Icon name="chevron" size={18} className={styles.chev} />
    </button>
  );
}
