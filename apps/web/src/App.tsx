import type { EscalationView } from '@lw/contracts';
import { useEffect, useRef } from 'react';
import { Dock } from './dock/Dock';
import { Inspector } from './Inspector';
import { Sprite } from './lib/icons';
import { live } from './lib/live';
import { Palette } from './overlays/Palette';
import { useCardActions } from './parts/Card';
import { MobileNav, Sidebar, Strip, Toasts, useAwayLine } from './Shell';
import { AppProvider, useApp, useMission, type Surface } from './state';
import { Activity } from './surfaces/Activity';
import { Mission } from './surfaces/Mission';
import { Plan } from './surfaces/Plan';
import { Preview } from './surfaces/Preview';
import { Settings } from './surfaces/Settings';
import { Team } from './surfaces/Team';
import { Workbench } from './surfaces/Workbench';

const SURFACE: Record<Surface, () => React.JSX.Element> = {
  mission: Mission,
  team: Team,
  plan: Plan,
  workbench: Workbench,
  preview: Preview,
  activity: Activity,
  settings: Settings,
};

const CHORD: Record<string, Surface> = {
  m: 'mission',
  t: 'team',
  p: 'plan',
  w: 'workbench',
  s: 'preview',
  a: 'activity',
};

export function App() {
  return (
    <AppProvider>
      <Sprite />
      <Frame />
    </AppProvider>
  );
}

function Frame() {
  const app = useApp();
  const { projectId, projects, surface, layout, overlay } = app;
  const mc = useMission().data;
  useAwayLine();
  useKeys();

  // One live stream for the project on screen, opened after its first snapshot.
  const seq = mc?.seq ?? null;
  useEffect(() => {
    if (projectId && seq !== null) live.watch(projectId, seq);
    // Only on project change: the stream carries on from there.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, seq !== null]);

  const surfaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    surfaceRef.current?.scrollTo(0, 0);
  }, [surface, projectId]);

  const cls = [
    'app',
    layout.dockCollapsed && 'dock-collapsed',
    layout.sideCollapsed && 'side-collapsed',
    layout.sideOpen && 'side-open',
    layout.dockOpen && 'dock-open',
    layout.present && 'present',
  ]
    .filter(Boolean)
    .join(' ');

  const Body = SURFACE[surface];
  return (
    <>
      <div className={cls}>
        <Sidebar />
        <main className="canvas">
          <Strip />
          <div className="surface" ref={surfaceRef} tabIndex={-1}>
            {projectId ? <Body key={projectId} /> : <Empty loaded={projects.length > 0} />}
          </div>
          <Inspector />
        </main>
        {projectId && <Dock />}
      </div>
      <MobileNav />
      {overlay}
      <Toasts />
    </>
  );
}

function Empty({ loaded }: { loaded: boolean }) {
  return (
    <div className="page-head">
      <div>
        <h1>{loaded ? 'Choose a project' : 'No projects yet'}</h1>
        <p>
          {loaded
            ? 'Pick a project from the switcher at the top of the sidebar.'
            : 'Start one from the project switcher: name, client, the source site and its repository.'}
        </p>
      </div>
    </div>
  );
}

/**
 * The prototype's keyboard: Ctrl or Cmd K for the palette, Ctrl or Cmd / for the composer, G then a
 * letter to change surface, 1 to 4 to choose on the open card, D to defer it, A to approve a gate,
 * Esc to close the top layer.
 */
function useKeys() {
  const app = useApp();
  const mc = useMission().data;
  const open =
    mc?.waitingOnYou.find((x) => x.escalationId === app.ui.expanded && x.status === 'open') ?? null;
  const act = useCardActionsOrNull(open);
  const state = useRef({ app, open, act, chord: 0 });
  state.current.app = app;
  state.current.open = open;
  state.current.act = act;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { app: a, open: o, act: c } = state.current;
      const el = document.activeElement;
      const inField = !!el && /INPUT|TEXTAREA|SELECT/.test(el.tagName);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        a.openOverlay(<Palette />);
        return;
      }
      if (mod && e.key === '/') {
        e.preventDefault();
        a.setLayout({ dockOpen: true, dockCollapsed: false });
        a.setComposer({ text: a.composer.text, about: a.composer.about, focus: true });
        return;
      }
      if (e.key === 'Escape') {
        if (a.overlay) return a.closeOverlay();
        if (a.inspector) return a.closeInspector();
        if (a.layout.present) return a.setLayout({ present: false });
        if (a.layout.dockOpen || a.layout.sideOpen)
          a.setLayout({ dockOpen: false, sideOpen: false });
        return;
      }
      if (inField || mod || e.altKey || a.overlay) return;
      if (e.key === 'g') {
        state.current.chord = Date.now();
        return;
      }
      if (Date.now() - state.current.chord < 1200) {
        state.current.chord = 0;
        const s = CHORD[e.key];
        if (s) a.go(s);
        return;
      }
      if (e.key === '?') {
        a.toast(
          'Shortcuts: Ctrl or Cmd K opens the palette. G then M, T, P, W, S or A changes surface. 1 to 4 chooses on the open card, D defers, A approves a gate, Esc closes.',
        );
        return;
      }
      if (!o || !c) return;
      if (/^[1-4]$/.test(e.key) && o.type !== 'gate') {
        const opt = o.options[Number(e.key) - 1];
        if (opt) void c.choose(opt.id);
        return;
      }
      if (e.key.toLowerCase() === 'd' && o.type !== 'gate') {
        void c.defer();
        return;
      }
      if (e.key.toLowerCase() === 'a' && o.type === 'gate') c.approve(mc?.project.name ?? '');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

const NONE = { escalationId: '', options: [], type: 'decision' } as unknown as EscalationView;

/** useCardActions needs an escalation on every render; the keyboard only uses it when one is open. */
function useCardActionsOrNull(x: EscalationView | null) {
  const act = useCardActions(x ?? NONE);
  return x ? act : null;
}
