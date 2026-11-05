/*
 * The left of the shell (design system §8): the Rail in Bliss, the Sidebar in Everything.
 * Both read the same sections (sections.ts) and the same eye.
 */
import { DemoMenu, ProjectMenu } from '../overlays/Menus';
import { isManagePage, MANAGE, useApp, useProjectResource } from '../state';
import { Icon, type IconName } from '../theme/icons';
import { Eye } from '../ui/Eye';
import { useEyeState } from '../voice/eye';
import { PROJECT_SECTIONS } from './sections';
import { ThemeSwitch } from './ThemeSwitch';
import styles from './Shell.module.css';

const MANAGE_ICON: Record<string, IconName> = {
  settings: 'settings',
  connections: 'projects',
  playbooks: 'plan',
  rules: 'check',
  knowledge: 'workbench',
  diagnostics: 'activity',
};

function useNavState() {
  const app = useApp();
  const p = app.projects.find((x) => x.id === app.projectId);
  const scenarios =
    useProjectResource<{ key: string; label: string }[]>(app.projectId ? '/scenarios' : null)
      .data ?? [];
  return { ...app, p, scenarios, eye: useEyeState() };
}

/** Bliss: a labelled icon rail on ink, the eye at the top, a coral dot on Yours. */
export function Rail() {
  const { p, projectId, surface, view, go, home, manage, openOverlay, me, scenarios, eye } =
    useNavState();
  const current = (on: boolean) => (on ? 'page' : undefined);
  return (
    <nav className={styles.rail} aria-label="Cypher">
      <button className={styles.railEye} onClick={home} aria-label="All projects">
        <Eye
          state={eye.state}
          blink={eye.blink}
          size={44}
          tone="onShell"
          label={`Cypher: ${eye.yours ? `${eye.yours} yours` : eye.state === 'watching' ? 'watching' : 'nothing needs you'}`}
        />
      </button>
      {p ? (
        PROJECT_SECTIONS.map((s) => (
          <button
            key={s.surface}
            className={styles.railItem}
            aria-current={current(surface === s.surface)}
            onClick={() => go(s.surface)}
          >
            <Icon name={s.icon} size={22} />
            <span className="type-rail-label">{s.short}</span>
            {s.yours && eye.yours > 0 && (
              <span className={styles.railDot}>
                <span className="sr-only">{eye.yours} yours</span>
              </span>
            )}
          </button>
        ))
      ) : (
        <button
          className={styles.railItem}
          aria-current={current(view === 'dashboard')}
          onClick={home}
        >
          <Icon name="home" size={22} />
          <span className="type-rail-label">Dashboard</span>
        </button>
      )}
      <span className={styles.grow} />
      {scenarios.length > 0 && (
        <button className={styles.railItem} onClick={() => openOverlay(<DemoMenu />)}>
          <Icon name="activity" size={22} />
          <span className="type-rail-label">Demo</span>
        </button>
      )}
      {projectId && (
        <button className={styles.railItem} onClick={home}>
          <Icon name="projects" size={22} />
          <span className="type-rail-label">All projects</span>
        </button>
      )}
      <button
        className={styles.railItem}
        aria-current={current(projectId ? surface === 'settings' : view === 'settings')}
        onClick={() => (projectId ? go('settings') : manage('settings'))}
      >
        <Icon name="settings" size={22} />
        <span className="type-rail-label">Settings</span>
      </button>
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
    projects,
    projectId,
    surface,
    view,
    go,
    home,
    manage,
    openOverlay,
    me,
    scenarios,
    eye,
  } = useNavState();
  const current = (on: boolean) => (on ? 'page' : undefined);
  return (
    <nav className={styles.sidebar} aria-label="Cypher">
      <button className={styles.brand} onClick={home} aria-label="Cypher, all projects">
        <Eye state={eye.state} blink={eye.blink} size={34} tone="onShell" decorative />
        <span className={`${styles.wordmark} type-heading`} aria-hidden="true">
          cypher
        </span>
      </button>
      <ProjectSwitcher onInk />
      <div className={styles.navGap} />
      {p ? (
        PROJECT_SECTIONS.map((s) => (
          <button
            key={s.surface}
            className={`${styles.navItem} type-nav`}
            aria-current={current(surface === s.surface)}
            onClick={() => go(s.surface)}
          >
            <Icon name={s.icon} />
            {s.label}
            {s.yours && eye.yours > 0 && (
              <span className={`${styles.badge} type-label`}>
                {eye.yours}
                <span className="sr-only"> yours</span>
              </span>
            )}
          </button>
        ))
      ) : (
        <>
          <button
            className={`${styles.navItem} type-nav`}
            aria-current={current(view === 'dashboard')}
            onClick={home}
          >
            <Icon name="home" />
            Dashboard
          </button>
          {projects.length > 0 && <div className={`${styles.navLabel} type-label`}>Manage</div>}
          {MANAGE.map(([page, title, hint]) => (
            <button
              key={page}
              className={`${styles.navItem} type-nav`}
              aria-current={current(isManagePage(view) && view === page)}
              title={hint}
              onClick={() => manage(page)}
            >
              <Icon name={MANAGE_ICON[page] ?? 'settings'} />
              {title}
            </button>
          ))}
        </>
      )}
      <span className={styles.grow} />
      {scenarios.length > 0 && (
        <button
          className={`${styles.navItem} ${styles.quiet} type-nav`}
          onClick={() => openOverlay(<DemoMenu />)}
        >
          <Icon name="activity" />
          Demo scenarios
        </button>
      )}
      {projectId && (
        <>
          <button className={`${styles.navItem} ${styles.quiet} type-nav`} onClick={home}>
            <Icon name="projects" />
            All projects
          </button>
          <button
            className={`${styles.navItem} ${styles.quiet} type-nav`}
            aria-current={current(surface === 'settings')}
            onClick={() => go('settings')}
          >
            <Icon name="settings" />
            Settings
          </button>
        </>
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
 * tile inside one. A row in the sidebar (on ink), a pill in Bliss's floating header.
 */
export function ProjectSwitcher({ onInk = false }: { onInk?: boolean }) {
  const { projects, projectId, openOverlay } = useApp();
  const p = projects.find((x) => x.id === projectId);
  const sub = p
    ? p.currentPhase
      ? `${p.currentPhase.name}, ${p.currentPhase.percent ?? 0}%`
      : (p.subtitle ?? p.client)
    : `${projects.length} projects`;
  return (
    <button
      className={onInk ? styles.switcher : styles.switcherPill}
      onClick={() => openOverlay(<ProjectMenu />)}
      aria-haspopup="menu"
      aria-label={`Switch project: ${p?.name ?? 'All projects'}`}
    >
      <span className={`${styles.tile} type-label`} aria-hidden="true">
        {p?.initials ?? <Icon name="home" size={18} />}
      </span>
      <span className={styles.switcherText}>
        <span className="type-nav">{p?.name ?? 'All projects'}</span>
        {onInk && <span className="type-meta">{sub}</span>}
      </span>
      <Icon name="chevron" size={18} className={styles.chev} />
    </button>
  );
}
