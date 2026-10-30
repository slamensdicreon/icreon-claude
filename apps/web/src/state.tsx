import type {
  AgentView,
  ConversationSnapshot,
  MissionControlSnapshot,
  ProjectListItem,
  TeamSnapshot,
} from '@lw/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiProblem, get } from './lib/api';
import { live, useResource } from './lib/live';

export type Surface =
  | 'mission'
  | 'inbox'
  | 'team'
  | 'plan'
  | 'workbench'
  | 'preview'
  | 'activity'
  | 'scorecard'
  | 'settings';
export const SURFACES: Surface[] = [
  'mission',
  'inbox',
  'team',
  'plan',
  'workbench',
  'preview',
  'activity',
  'scorecard',
  'settings',
];
export const SURFACE_LABEL: Record<Surface, string> = {
  mission: 'Mission Control',
  inbox: 'Needs you',
  team: 'Team',
  plan: 'Plan',
  workbench: 'Workbench',
  preview: 'Site preview',
  activity: 'Activity',
  scorecard: 'Scorecard',
  settings: 'Settings',
};

/** What each project remembers while you look at another one. */
export interface ProjectUi {
  wbArtifact: string | null;
  bpFilter: string;
  planView: 'today' | 'engagement' | 'list';
  planFilter: string;
  teamFilter: 'all' | 'working' | 'idle';
  previewPage: string | null;
  breakpoint: 'desktop' | 'tablet' | 'phone';
  activity: { sev: 'all' | 'warn' | 'bad'; agent: string };
  liveTail: boolean;
  /** The card open in the queue. */
  expanded: string | null;
  queueCollapsed: boolean;
  awayLine: string | null;
}

const DEFAULT_UI: ProjectUi = {
  wbArtifact: null,
  bpFilter: 'all',
  planView: 'today',
  planFilter: 'all',
  teamFilter: 'all',
  previewPage: null,
  breakpoint: 'desktop',
  activity: { sev: 'all', agent: 'all' },
  liveTail: true,
  expanded: null,
  queueCollapsed: false,
  awayLine: null,
};

export interface Layout {
  dockOpen: boolean;
  dockCollapsed: boolean;
  sideCollapsed: boolean;
  sideOpen: boolean;
  present: boolean;
}

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

interface AppValue {
  me: { name: string; login: string | null };
  projects: ProjectListItem[];
  projectId: string | null;
  switchProject: (id: string) => void;
  /** The Dashboard: every project, the playbook catalog and diagnostics, above any one project. */
  home: () => void;
  surface: Surface;
  go: (s: Surface, patch?: Partial<ProjectUi>) => void;
  ui: ProjectUi;
  setUi: (patch: Partial<ProjectUi>) => void;
  inspector: { kind: 'agent' | 'task'; id: string } | null;
  inspect: (kind: 'agent' | 'task', id: string) => void;
  closeInspector: () => void;
  overlay: ReactNode;
  openOverlay: (node: ReactNode) => void;
  closeOverlay: () => void;
  toasts: Toast[];
  toast: (text: string, action?: Toast['action']) => void;
  dismissToast: (id: number) => void;
  layout: Layout;
  setLayout: (patch: Partial<Layout>) => void;
  theme: 'light' | 'dark' | null;
  setTheme: (t: 'light' | 'dark') => void;
  composer: { text: string; about: string | null; focus: number };
  setComposer: (c: { text: string; about?: string | null; focus?: boolean }) => void;
  /** Runs a command; refusals become a toast in the API's own words. */
  run: (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;
  /**
   * The first load: whether the project list has arrived, and why not when it hasn't. The boot
   * overlay reads it; background refreshes never touch it once the list is in.
   */
  boot: { projectsLoaded: boolean; error: string | null; retry: () => void };
}

const Ctx = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode: preferences just don't persist */
    }
  },
};

function parsePath(): { projectId: string | null; surface: Surface } {
  const m = /^\/p\/([^/]+)(?:\/([a-z]+))?/.exec(location.pathname);
  const surface = (m?.[2] && SURFACES.includes(m[2] as Surface) ? m[2] : 'mission') as Surface;
  return { projectId: m?.[1] ? decodeURIComponent(m[1]) : null, surface };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const initial = parsePath();
  const [projectId, setProjectId] = useState<string | null>(initial.projectId);
  const [surface, setSurface] = useState<Surface>(initial.surface);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [me, setMe] = useState<{ name: string; login: string | null }>({
    name: 'Director',
    login: null,
  });
  const uis = useRef(new Map<string, ProjectUi>());
  const [uiVersion, setUiVersion] = useState(0);
  const [inspector, setInspector] = useState<AppValue['inspector']>(null);
  const [overlay, setOverlay] = useState<ReactNode>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [layout, setLayoutState] = useState<Layout>({
    dockOpen: false,
    dockCollapsed: store.get('lw-dock') === '1',
    sideCollapsed: store.get('lw-side') === '1',
    sideOpen: false,
    present: false,
  });
  const [theme, setThemeState] = useState<'light' | 'dark' | null>(
    (store.get('lw-theme') as 'light' | 'dark' | null) ?? null,
  );
  const [composer, setComposerState] = useState({
    text: '',
    about: null as string | null,
    focus: 0,
  });

  // Who is signed in. Without sign-in (local development) the API has no /auth routes.
  useEffect(() => {
    get<{ login: string; name: string | null }>('/auth/me')
      .then((u) => setMe({ name: u.name ?? u.login, login: u.login }))
      .catch(() => {});
  }, []);

  // The project list: on load, after each command, and every few seconds for the switcher's
  // health and badges.
  const [boot, setBoot] = useState<{ projectsLoaded: boolean; error: string | null }>({
    projectsLoaded: false,
    error: null,
  });
  const loadProjects = useCallback(
    () =>
      get<ProjectListItem[]>('/projects')
        .then((list) => {
          setProjects(list);
          // No project in the address means the Dashboard; a project that's gone does too.
          setProjectId((cur) => (cur && list.some((p) => p.id === cur) ? cur : null));
          setBoot({ projectsLoaded: true, error: null });
        })
        .catch((err: unknown) => {
          // Only the first load reports: a refresh that fails later shouldn't bring the overlay back.
          setBoot((b) =>
            b.projectsLoaded
              ? b
              : {
                  projectsLoaded: false,
                  error:
                    err instanceof ApiProblem
                      ? err.message
                      : 'The Control API could not be reached.',
                },
          );
        }),
    [],
  );
  useEffect(() => {
    void loadProjects();
    const t = window.setInterval(loadProjects, 8000);
    return () => window.clearInterval(t);
  }, [loadProjects]);

  // Keep the URL in step, and follow the back button.
  useEffect(() => {
    const path = projectId ? `/p/${encodeURIComponent(projectId)}/${surface}` : '/';
    if (location.pathname !== path) history.pushState(null, '', path);
  }, [projectId, surface]);
  useEffect(() => {
    const onPop = () => {
      const p = parsePath();
      setProjectId(p.projectId);
      setSurface(p.surface);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
  }, [theme]);

  const ui = useMemo(
    () => (projectId ? (uis.current.get(projectId) ?? DEFAULT_UI) : DEFAULT_UI),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, uiVersion],
  );
  const setUi = useCallback(
    (patch: Partial<ProjectUi>) => {
      if (!projectId) return;
      uis.current.set(projectId, { ...(uis.current.get(projectId) ?? DEFAULT_UI), ...patch });
      setUiVersion((v) => v + 1);
    },
    [projectId],
  );

  const toast = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, text, action }]);
    window.setTimeout(
      () => setToasts((ts) => ts.filter((t) => t.id !== id)),
      action ? 10_000 : 4000,
    );
  }, []);

  // Back from GitHub after creating the app: say how it went, on Settings, where the app lives.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const outcome = q.get('github');
    if (!outcome) return;
    setSurface('settings');
    toast(
      outcome === 'connected'
        ? 'The GitHub App is set up. Send clients its install link from Settings.'
        : `The GitHub App was not set up: ${q.get('reason') ?? 'GitHub did not finish.'}`,
    );
    history.replaceState(null, '', location.pathname);
  }, [toast]);

  const value: AppValue = {
    me,
    projects,
    projectId,
    switchProject: (id) => {
      if (id === projectId) return;
      setInspector(null);
      // From the Dashboard a project opens on Mission Control.
      if (!projectId) setSurface('mission');
      setProjectId(id);
      const p = projects.find((x) => x.id === id);
      if (p) toast(`Switched to ${p.name}`);
    },
    home: () => {
      setInspector(null);
      setProjectId(null);
      setLayoutState((l) => ({ ...l, dockOpen: false }));
    },
    surface,
    go: (s, patch) => {
      if (patch) setUi(patch);
      setSurface(s);
      setInspector(null);
      setLayoutState((l) => ({ ...l, dockOpen: false }));
    },
    ui,
    setUi,
    inspector,
    inspect: (kind, id) => setInspector({ kind, id }),
    closeInspector: () => setInspector(null),
    overlay,
    openOverlay: setOverlay,
    closeOverlay: () => setOverlay(null),
    toasts,
    toast,
    dismissToast: (id) => setToasts((ts) => ts.filter((t) => t.id !== id)),
    layout,
    setLayout: (patch) =>
      setLayoutState((l) => {
        const next = { ...l, ...patch };
        store.set('lw-dock', next.dockCollapsed ? '1' : '0');
        store.set('lw-side', next.sideCollapsed ? '1' : '0');
        return next;
      }),
    theme,
    setTheme: (t) => {
      store.set('lw-theme', t);
      setThemeState(t);
    },
    composer,
    setComposer: ({ text, about = null, focus = false }) =>
      setComposerState((c) => ({ text, about, focus: focus ? c.focus + 1 : c.focus })),
    boot: { ...boot, retry: () => void loadProjects() },
    run: async (fn, done) => {
      try {
        await fn();
        if (projectId) live.refresh(projectId);
        void loadProjects();
        if (done) toast(done);
        return true;
      } catch (err) {
        toast(
          err instanceof ApiProblem
            ? err.message
            : 'The Control API could not be reached. Check your connection.',
        );
        return false;
      }
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The current project's snapshots. */
export const useProjectResource = <T,>(path: string | null) => {
  const { projectId } = useApp();
  return useResource<T>(
    projectId,
    projectId && path !== null ? `/projects/${projectId}${path}` : null,
  );
};

export const useMission = () => useProjectResource<MissionControlSnapshot>('/mission-control');
export const useTeam = () => useProjectResource<TeamSnapshot>('/team');
export const useConversation = () => useProjectResource<ConversationSnapshot>('/conversation');

/** Roster lookups: agent by id, and by role name (Activity rows name roles). */
export function useRoster() {
  const team = useTeam().data;
  return useMemo(() => {
    const agents = team?.agents ?? [];
    const byId = new Map(agents.map((a) => [a.agentId, a]));
    return {
      agents,
      byId: (id: string | null | undefined): AgentView | undefined =>
        id ? byId.get(id) : undefined,
    };
  }, [team]);
}

/** The project's time zone (New York until the snapshot loads). */
export function useTz(): string {
  return useMission().data?.project.timezone ?? 'America/New_York';
}

/** Re-renders every `ms` (clocks, ages, countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}
