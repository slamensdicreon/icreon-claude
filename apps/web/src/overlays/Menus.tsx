import { useRef, useState, type KeyboardEvent } from 'react';
import { post } from '../lib/api';
import { live } from '../lib/live';
import { MANAGE, useApp, useProjectResource, type Surface } from '../state';
import { Icon, type IconName } from '../theme/icons';
import { Scrim } from './Dialogs';
import s from './overlays.module.css';

const HEALTH = { healthy: 'Healthy', attention: 'Needs attention', blocked: 'Blocked' } as const;

/** The projects opened from the switcher, newest first: its Recent section. */
const RECENT = 'lw-recent-projects';
const recentIds = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const remember = (id: string) => {
  try {
    localStorage.setItem(
      RECENT,
      JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, 8)),
    );
  } catch {
    /* private mode: Recent just stays empty */
  }
};
/** Past this many projects the switcher leads with a search and splits into sections. */
const MANY = 6;

/**
 * The project switcher. A short list reads top to bottom; a long one (30 to 50 projects) leads
 * with a search, then what needs you, what you opened lately, and the rest. Enter opens the first
 * match; the arrow keys move between rows. Archived projects live under the Dashboard's Archived
 * view instead.
 */
export function ProjectMenu() {
  const { projects, projectId, switchProject, home, closeOverlay, newProject } = useApp();
  const [query, setQuery] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const open = (id: string) => {
    remember(id);
    closeOverlay();
    switchProject(id);
  };
  const shown = projects.filter((p) => p.status !== 'archived' || p.id === projectId);
  const many = shown.length > MANY;
  const q = query.trim().toLowerCase();
  const sections: { title: string; items: typeof shown }[] = [];
  if (q) {
    const hits = shown.filter((p) =>
      [p.name, p.client, p.subtitle ?? '', p.platform?.name ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
    sections.push({ title: 'Matches', items: hits });
  } else if (!many) {
    sections.push({ title: 'Projects', items: shown });
  } else {
    const needs = shown.filter((p) => p.waitingCount > 0);
    const recent = recentIds()
      .map((id) => shown.find((p) => p.id === id))
      .filter((p): p is (typeof shown)[number] => !!p && !needs.includes(p))
      .slice(0, 4);
    const rest = shown.filter((p) => !needs.includes(p) && !recent.includes(p));
    if (needs.length) sections.push({ title: 'Needs you', items: needs });
    if (recent.length) sections.push({ title: 'Recent', items: recent });
    if (rest.length)
      sections.push({
        title: needs.length || recent.length ? 'Everything else' : 'Projects',
        items: rest,
      });
  }
  const first = sections.find((x) => x.items.length)?.items[0];
  const rows = () => [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-row]') ?? [])];
  const move = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = rows();
    if (!all.length) return;
    e.preventDefault();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? at < 0
          ? 0
          : Math.min(at + 1, all.length - 1)
        : at <= 0
          ? -1
          : at - 1;
    if (next < 0) list.current?.querySelector<HTMLInputElement>('input')?.focus();
    else all[next]!.focus();
  };

  return (
    <Scrim place="nav-top">
      <div
        ref={list}
        className={`${s.float} ${s.menu}`}
        role="dialog"
        aria-label="Projects"
        onKeyDown={move}
      >
        <button
          data-row=""
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
            <span className="type-meta">
              {many
                ? `All ${shown.length} projects and where they stand`
                : 'Every project and where it stands'}
            </span>
          </span>
        </button>
        {many && (
          <label className={s.menuSearch}>
            <Icon name="search" size={18} />
            <input
              className="type-body-small"
              type="search"
              autoFocus
              placeholder={`Find a project among ${shown.length}`}
              aria-label="Find a project"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && first) open(first.id);
              }}
            />
          </label>
        )}
        {sections.map((sec) => (
          <section key={sec.title} aria-label={sec.title} className={s.menuSection}>
            <h3 className={`${s.menuHead} type-label`}>
              {sec.title}
              {many && <span className={s.menuCount}> {sec.items.length}</span>}
            </h3>
            {sec.items.length === 0 && (
              <p className={`${s.menuEmpty} type-body-small`}>
                Nothing matches. Archived projects are on the Dashboard.
              </p>
            )}
            {sec.items.map((p) => (
              <button
                key={p.id}
                data-row=""
                className={s.row}
                aria-current={p.id === projectId || undefined}
                onClick={() => open(p.id)}
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
                    · {p.platform && many ? `${p.platform.name} · ` : ''}
                    {p.subtitle ?? p.client}
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
          </section>
        ))}
        <div className={s.sep} />
        <button
          data-row=""
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
