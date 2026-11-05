import { post } from '../lib/api';
import { live } from '../lib/live';
import { MANAGE, useApp, useProjectResource, type Surface } from '../state';
import { Icon, type IconName } from '../theme/icons';
import { Scrim } from './Dialogs';
import s from './overlays.module.css';

const HEALTH = { healthy: 'Healthy', attention: 'Needs attention', blocked: 'Blocked' } as const;

export function ProjectMenu() {
  const { projects, projectId, switchProject, home, closeOverlay, newProject } = useApp();
  return (
    <Scrim place="nav-top">
      <div className={`${s.float} ${s.menu}`} role="menu" aria-label="Projects">
        <button
          role="menuitem"
          className={s.row}
          aria-current={!projectId || undefined}
          onClick={() => {
            closeOverlay();
            home();
          }}
        >
          <span className={s.tile} aria-hidden="true">
            <Icon name="home" size={18} />
          </span>
          <span className={s.rowText}>
            <span className="type-body-small">Dashboard</span>
            <span className="type-meta">Every project and where it stands</span>
          </span>
        </button>
        <h3 className={`${s.menuHead} type-label`}>Projects</h3>
        {projects.map((p) => (
          <button
            key={p.id}
            role="menuitem"
            className={s.row}
            aria-current={p.id === projectId || undefined}
            onClick={() => {
              closeOverlay();
              switchProject(p.id);
            }}
          >
            <span className={`${s.tile} type-label`} aria-hidden="true">
              {p.initials}
            </span>
            <span className={s.rowText}>
              <span className="type-body-small">
                {p.name}
                {p.demo && <span className={`${s.tag} type-meta`}>Demo</span>}
              </span>
              <span className="type-meta">
                {p.currentPhase
                  ? `Phase ${p.currentPhase.number}, ${p.currentPhase.name}`
                  : p.status === 'intake'
                    ? 'Ready to start'
                    : p.status}{' '}
                · {p.subtitle ?? p.client}
              </span>
            </span>
            <span className={s.rowEnd}>
              <span
                className={s.dot}
                data-tone={p.health}
                role="img"
                aria-label={HEALTH[p.health]}
              />
              {p.waitingCount > 0 && (
                <span
                  className={`${s.badge} type-label`}
                  aria-label={`${p.waitingCount} waiting on you`}
                >
                  {p.waitingCount}
                </span>
              )}
            </span>
          </button>
        ))}
        <div className={s.sep} />
        <button
          role="menuitem"
          className={s.row}
          onClick={() => {
            closeOverlay();
            newProject();
          }}
        >
          <span className={s.tile} aria-hidden="true">
            <Icon name="plus" size={18} />
          </span>
          <span className={s.rowText}>
            <span className="type-body-small">New project</span>
          </span>
        </button>
      </div>
    </Scrim>
  );
}

/** The header's menu, top right: the pages above any one project. */
export function ManageMenu() {
  const { view, projectId, manage, closeOverlay } = useApp();
  return (
    <Scrim place="nav-bottom">
      <div className={`${s.float} ${s.menu}`} role="menu" aria-label="Settings">
        {MANAGE.map(([page, label, about]) => (
          <button
            key={page}
            role="menuitem"
            className={s.row}
            aria-current={(!projectId && view === page) || undefined}
            onClick={() => {
              closeOverlay();
              manage(page);
            }}
          >
            <span className={s.rowText}>
              <span className="type-body-small">{label}</span>
              <span className="type-meta">{about}</span>
            </span>
          </button>
        ))}
      </div>
    </Scrim>
  );
}

export function DemoMenu() {
  const { projectId, projects, closeOverlay, run, setUi, go } = useApp();
  const scenarios = useProjectResource<{ key: string; label: string }[]>('/scenarios').data ?? [];
  const name = projects.find((p) => p.id === projectId)?.name ?? '';
  const raise = (key: string) => {
    closeOverlay();
    void run(() => post(`/projects/${projectId}/scenarios/${key}`));
  };
  return (
    <Scrim place="nav-bottom">
      <div className={`${s.float} ${s.menu}`} role="menu" aria-label="Demo scenarios">
        <h3 className={`${s.menuHead} type-label`}>Demo scenarios for {name}</h3>
        {scenarios.map((x) => (
          <button
            key={x.key}
            role="menuitem"
            className={`${s.row} type-body-small`}
            onClick={() => raise(x.key)}
          >
            {x.label}
          </button>
        ))}
        <div className={s.sep} />
        <button
          role="menuitem"
          className={`${s.row} type-body-small`}
          onClick={() => {
            closeOverlay();
            live.simulateDrop();
          }}
        >
          Simulate a connection drop
        </button>
        <button
          role="menuitem"
          className={`${s.row} type-body-small`}
          onClick={() => {
            closeOverlay();
            setUi({
              awayLine:
                'Since you were away (41 min): 2 escalations raised, 1 resolved. $14 consumed.',
            });
            go('mission');
          }}
        >
          Show the “since you were away” line
        </button>
      </div>
    </Scrim>
  );
}

export function MoreSheet() {
  const { surface, go, closeOverlay, openOverlay, projects, projectId, theme, setTheme } = useApp();
  const items: [Surface, IconName, string][] = [
    ['workbench', 'workbench', 'Workbench'],
    ['activity', 'activity', 'Activity'],
    ['scorecard', 'scorecard', 'Scorecard'],
    ['settings', 'settings', 'Settings'],
  ];
  const current = projects.find((p) => p.id === projectId);
  return (
    <Scrim place="sheet">
      <div className={`${s.float} ${s.sheet}`} role="dialog" aria-modal="true" aria-label="More">
        <div className={s.grab} aria-hidden="true" />
        {items.map(([x, icon, label]) => (
          <button
            key={x}
            className={`${s.row} type-body`}
            aria-current={surface === x ? 'page' : undefined}
            onClick={() => {
              closeOverlay();
              go(x);
            }}
          >
            <Icon name={icon} className={s.icon} />
            <span>{label}</span>
          </button>
        ))}
        <div className={s.sep} />
        <button className={`${s.row} type-body`} onClick={() => openOverlay(<ProjectMenu />)}>
          <Icon name="projects" className={s.icon} />
          <span>Switch project</span>
          <span className={`${s.end} type-meta`}>{current?.name}</span>
        </button>
        <button className={`${s.row} type-body`} onClick={() => openOverlay(<DemoMenu />)}>
          <Icon name="tools" className={s.icon} />
          <span>Demo scenarios</span>
        </button>
        <button
          className={`${s.row} type-body`}
          onClick={() => setTheme(theme === null ? 'light' : theme === 'light' ? 'dark' : null)}
        >
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} className={s.icon} />
          <span>Theme</span>
          <span className={`${s.end} type-meta`}>
            {theme === null ? 'System' : theme === 'light' ? 'Light' : 'Dark'}
          </span>
        </button>
      </div>
    </Scrim>
  );
}
