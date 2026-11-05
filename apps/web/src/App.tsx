import type { EscalationView } from '@lw/contracts';
import { useEffect, useRef } from 'react';
import { Inspector } from './Inspector';
import { live } from './lib/live';
import { NewProjectPage as NewProject } from './surfaces/intake/NewProjectPage';
import { Palette } from './overlays/Palette';
import { Boot, useBootState } from './parts/Boot';
import { useCardActions } from './lib/escalation';
import { useMode } from './mode/mode';
import { ModeTransition } from './mode/ModeTransition';
import { BlissHeader, TopBar } from './shell/Bars';
import { MobileNav, Toasts, useAwayLine } from './shell/Chrome';
import { CypherLauncher, CypherSheet } from './shell/Cypher';
import { Rail, Sidebar } from './shell/Nav';
import styles from './shell/Shell.module.css';
import { Button } from './ui/cypher/parts';
import { Eye } from './ui/Eye';
import {
  AppProvider,
  isManagePage,
  isPortfolioPage,
  useApp,
  useMission,
  type Surface,
} from './state';
import { PortfolioPageView } from './surfaces/portfolio/PortfolioPages';
import { ActivityPage } from './surfaces/activity/ActivityPage';
import { GithubAppPanel } from './surfaces/manage/GithubApp';
import { ManagePage as Manage } from './surfaces/manage/ManagePage';
import { Dashboard } from './surfaces/dashboard/Dashboard';
import { MissionControl } from './surfaces/mission/MissionControl';
import { NeedsYou } from './surfaces/inbox/NeedsYou';
import { PlanPage, WorkbenchPage } from './surfaces/quiet/QuietFaces';
import { SitePreview } from './surfaces/preview/PreviewPage';
import { ScorecardPage } from './surfaces/scorecard/ScorecardPage';
import { SettingsPage as Settings } from './surfaces/settings/SettingsPage';
import { TeamPage } from './surfaces/team/TeamPage';

const SURFACE: Record<Surface, () => React.JSX.Element> = {
  mission: MissionControl,
  inbox: NeedsYou,
  team: TeamPage,
  plan: PlanPage,
  workbench: WorkbenchPage,
  preview: SitePreview,
  activity: ActivityPage,
  scorecard: ScorecardPage,
  settings: Settings,
};

const CHORD: Record<string, Surface> = {
  m: 'mission',
  n: 'inbox',
  t: 'team',
  p: 'plan',
  w: 'workbench',
  s: 'preview',
  a: 'activity',
  c: 'scorecard',
};

export function App() {
  return (
    <AppProvider>
      <Frame />
    </AppProvider>
  );
}

function Frame() {
  const app = useApp();
  const { projectId, projects, surface, layout, overlay, view, newProjectIntent } = app;
  const mc = useMission().data;
  const boot = useBootState();
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

  const { mode } = useMode();
  const everything = mode === 'everything';

  const Body = SURFACE[surface];
  return (
    <>
      {/* While the first load runs, the shell renders underneath the boot overlay (blurred) and
          takes no focus or clicks. */}
      <div
        className={styles.shell}
        data-mode={mode}
        data-present={layout.present || undefined}
        inert={boot.visible || undefined}
        aria-busy={boot.visible || undefined}
      >
        {everything ? <Sidebar /> : <Rail />}
        <main className={styles.main}>
          {everything && !layout.present ? <TopBar /> : <BlissHeader />}
          <div className={styles.surface} ref={surfaceRef} tabIndex={-1} data-surface>
            <div className={styles.measure}>
              {projectId ? (
                <Body key={projectId} />
              ) : view === 'new' ? (
                <NewProject key={newProjectIntent.key} />
              ) : isPortfolioPage(view) ? (
                <PortfolioPageView key={view} page={view} />
              ) : isManagePage(view) ? (
                <Manage key={view} page={view} />
              ) : projects.length ? (
                <Dashboard />
              ) : (
                <Empty />
              )}
            </div>
          </div>
          <Inspector />
        </main>
        {/* Cypher chats only in Everything, from the eye button; nothing docks beside the page. */}
        {everything && (
          <>
            <CypherSheet />
            <CypherLauncher />
          </>
        )}
      </div>
      <MobileNav />
      {overlay}
      <Toasts />
      <ModeTransition />
      {boot.visible && <Boot state={boot} />}
    </>
  );
}

function Empty() {
  const { newProject } = useApp();
  return (
    <div className={styles.empty}>
      <Eye state="resting" size={72} decorative />
      <h1 className="type-heading">No projects yet</h1>
      <p className="type-body">
        Start one from the catalog: pick the platform and the playbook, then the client&rsquo;s
        source, their environment and its credentials, and budgets.
      </p>
      <div>
        <Button kind="primary" onClick={() => newProject()}>
          New project
        </Button>
      </div>
      <GithubAppPanel />
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
          'Shortcuts: Ctrl or Cmd K opens the palette. G then M, N, T, P, W, S, A or C changes surface. In Needs you, J and K move between items; 1 to 4 chooses, D defers, A approves a gate. Esc closes.',
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
