import { post } from '../lib/api';
import { Icon } from '../lib/icons';
import { live } from '../lib/live';
import { useApp, useProjectResource, type Surface } from '../state';
import { NewProject } from './NewProject';
import { Scrim } from './Dialogs';

const DOT = { healthy: 'good', attention: 'warn', blocked: 'bad' } as const;

export function ProjectMenu() {
  const { projects, projectId, switchProject, home, closeOverlay, openOverlay } = useApp();
  return (
    <Scrim style={{ placeItems: 'start start', padding: '120px 0 0 12px' }}>
      <div className="menu pmenu">
        <button
          className={`pm-row ${!projectId ? 'on' : ''}`}
          onClick={() => {
            closeOverlay();
            home();
          }}
        >
          <span className="ini">
            <Icon name="dashboard" sm />
          </span>
          <span className="pm-t">
            <b>Dashboard</b>
            <small>All projects, playbooks and diagnostics</small>
          </span>
        </button>
        <h3>Projects</h3>
        {projects.map((p) => (
          <button
            key={p.id}
            className={`pm-row ${p.id === projectId ? 'on' : ''}`}
            onClick={() => {
              closeOverlay();
              switchProject(p.id);
            }}
          >
            <span className="ini">{p.initials}</span>
            <span className="pm-t">
              <b>
                {p.name}
                {p.demo && <span className="pm-demo">Demo</span>}
              </b>
              <small>
                {p.currentPhase
                  ? `Phase ${p.currentPhase.number}, ${p.currentPhase.name}`
                  : p.status === 'intake'
                    ? 'Ready to start'
                    : p.status}{' '}
                · {p.subtitle ?? p.client}
              </small>
            </span>
            <span className="pm-s">
              <span className={`dot ${DOT[p.health]}`} />
              {p.waitingCount > 0 && <span className="badge">{p.waitingCount}</span>}
            </span>
          </button>
        ))}
        <button onClick={() => openOverlay(<NewProject />)}>+ New project</button>
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
    <Scrim style={{ placeItems: 'end start', padding: '0 0 96px 16px' }}>
      <div className="menu">
        <h3>Demo scenarios for {name}</h3>
        {scenarios.map((s) => (
          <button key={s.key} onClick={() => raise(s.key)}>
            {s.label}
          </button>
        ))}
        <button
          onClick={() => {
            closeOverlay();
            live.simulateDrop();
          }}
        >
          Simulate a connection drop
        </button>
        <button
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
  const items: [Surface, string, string][] = [
    ['workbench', 'document', 'Workbench'],
    ['preview', 'view', 'Site preview'],
    ['activity', 'list', 'Activity'],
    ['settings', 'gear', 'Settings'],
  ];
  const current = projects.find((p) => p.id === projectId);
  return (
    <Scrim className="sheet-scrim">
      <div className="sheet" role="dialog" aria-label="More">
        <div className="sheet-grab" aria-hidden="true" />
        {items.map(([s, icon, label]) => (
          <button
            key={s}
            className="sh-i"
            aria-current={surface === s}
            onClick={() => {
              closeOverlay();
              go(s);
            }}
          >
            <Icon name={icon} />
            <span>{label}</span>
          </button>
        ))}
        <div className="sh-sep" />
        <button className="sh-i" onClick={() => openOverlay(<ProjectMenu />)}>
          <Icon name="chevron--down" />
          <span>Switch project</span>
          <small>{current?.name}</small>
        </button>
        <button className="sh-i" onClick={() => openOverlay(<DemoMenu />)}>
          <Icon name="tools" />
          <span>Demo scenarios</span>
        </button>
        <button
          className="sh-i"
          onClick={() => {
            closeOverlay();
            setTheme(theme === 'dark' ? 'light' : 'dark');
          }}
        >
          <Icon name="information" />
          <span>Light or dark theme</span>
        </button>
      </div>
    </Scrim>
  );
}
