import { useEffect, useRef } from 'react';
import { get } from './lib/api';
import { clock, elapsed, usd, zoneLabel } from './lib/fmt';
import { Icon, Lockup, LOCKUP_SVG } from './lib/icons';
import { useConn } from './lib/live';
import { DemoMenu, MoreSheet, ProjectMenu } from './overlays/Menus';
import { NewProject } from './overlays/NewProject';
import { Palette } from './overlays/Palette';
import { useApp, useMission, useNow, useProjectResource, type Surface } from './state';
import { ApiProblem } from './lib/api';
import { cypher, useCypher } from './lib/cypher';
import { when } from './surfaces/CypherHome';
import type { SinceSummary } from '@lw/contracts';

const HEALTH_DOT = { healthy: 'good', attention: 'warn', blocked: 'bad' } as const;
const HEALTH_WORD = { healthy: 'Healthy', attention: 'Attention', blocked: 'Blocked' } as const;

const NAV: [Surface, string, string][] = [
  ['mission', 'dashboard', 'Mission Control'],
  ['inbox', 'notification', 'Needs you'],
  ['team', 'user-group', 'Team'],
  ['plan', 'milestone', 'Plan'],
  ['workbench', 'document', 'Workbench'],
  ['preview', 'view', 'Site preview'],
  ['activity', 'list', 'Activity'],
  ['scorecard', 'presentation-file', 'Scorecard'],
];

export function Sidebar() {
  const app = useApp();
  const {
    projects,
    projectId,
    surface,
    go,
    home,
    me,
    layout,
    setLayout,
    theme,
    setTheme,
    openOverlay,
  } = app;
  const p = projects.find((x) => x.id === projectId);
  const waiting = p?.waitingCount ?? 0;
  const scenarios = useProjectResource<{ key: string; label: string }[]>('/scenarios').data ?? [];
  const dark =
    theme === 'dark' ||
    (!theme &&
      typeof matchMedia !== 'undefined' &&
      matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <nav className="side" aria-label="Cypher">
      <div className="brand">
        <Lockup />
        <span className="product">Cypher</span>
      </div>
      <button className="projsw" title={p?.name} onClick={() => openOverlay(<ProjectMenu />)}>
        <Icon name="chevron--down" sm style={{ order: 3, color: 'var(--web-fg-2)' }} />
        <span className="ini" aria-hidden="true">
          {p?.initials ?? (projects.length ? <Icon name="dashboard" sm /> : '…')}
        </span>
        <span className="pm">
          <div className="pn">
            {p?.name ?? (projects.length ? 'All projects' : 'Loading projects')}
          </div>
          <div className="ps">
            {p?.demo && <span className="pm-demo first">Demo</span>}
            {p?.subtitle ?? p?.client ?? ''}
          </div>
        </span>
      </button>
      <div className="side-nav">
        <button
          className="nav sl"
          aria-current={!projectId ? 'page' : undefined}
          title="Dashboard"
          onClick={home}
        >
          <Icon name="dashboard" />
          <span className="lbl">Dashboard</span>
        </button>
        {!projectId && <CypherRail />}
        {projectId && <div className="side-label">Project</div>}
        {projectId &&
          NAV.map(([s, icon, label]) => (
            <button
              key={s}
              className="nav sl"
              aria-current={surface === s ? 'page' : undefined}
              title={label}
              onClick={() => go(s)}
            >
              <Icon name={icon} />
              <span className="lbl">{label}</span>
              {s === 'inbox' && waiting > 0 && <span className="count">{waiting}</span>}
            </button>
          ))}
        <div className="side-label">Manage</div>
        {projectId && (
          <button
            className="nav sl"
            aria-current={surface === 'settings' ? 'page' : undefined}
            title="Settings"
            onClick={() => go('settings')}
          >
            <Icon name="gear" />
            <span className="lbl">Settings</span>
          </button>
        )}
        <button className="nav sl" title="New project" onClick={() => openOverlay(<NewProject />)}>
          <Icon name="application" />
          <span className="lbl">New project</span>
        </button>
        {scenarios.length > 0 && (
          <button
            className="nav sl"
            title="Demo scenarios"
            onClick={() => openOverlay(<DemoMenu />)}
          >
            <Icon name="tools" />
            <span className="lbl">Demo scenarios</span>
          </button>
        )}
      </div>
      <div className="side-foot">
        <div className="userchip">
          <span className="avatar" aria-hidden="true">
            {me.name[0]?.toUpperCase()}
          </span>
          <span className="meta">
            <div className="nm">{me.name}</div>
            <div className="rl">Implementation Director</div>
          </span>
        </div>
        <div className="side-tools">
          <div className="seg seg-theme" role="group" aria-label="Theme">
            <button aria-pressed={!dark} onClick={() => setTheme('light')}>
              Light
            </button>
            <button aria-pressed={dark} onClick={() => setTheme('dark')}>
              Dark
            </button>
          </div>
          <button
            className="iconbtn sl"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            style={{ marginLeft: 'auto' }}
            onClick={() =>
              matchMedia('(max-width: 1280px)').matches
                ? setLayout({ sideOpen: !layout.sideOpen })
                : setLayout({ sideCollapsed: !layout.sideCollapsed })
            }
          >
            <Icon name="chevron--left" />
          </button>
        </div>
      </div>
    </nav>
  );
}

/**
 * Saved conversations with Cypher, in the sidebar while the Dashboard is open: New chat first,
 * then each conversation with the title and summary Cypher gave it, newest first. Picking one
 * opens it in the Cypher panel; the new chat is what the page opens on.
 */
function CypherRail() {
  const { toast } = useApp();
  const s = useCypher();
  useEffect(() => {
    if (!s.loaded) void cypher.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (s.loaded && !s.available) return null;
  const open = (id: string) =>
    cypher.open(id).catch((err: unknown) => {
      toast(err instanceof ApiProblem ? err.message : 'That conversation could not be opened.');
    });
  const remove = (id: string, title: string) =>
    cypher
      .remove(id)
      .then(() => toast(`Deleted “${title}”`))
      .catch((err: unknown) => {
        toast(err instanceof ApiProblem ? err.message : 'The conversation could not be deleted.');
      });
  return (
    <div className="side-convos">
      <div className="side-label">Conversations</div>
      <button
        className="nav sl"
        aria-current={!s.activeId ? 'page' : undefined}
        title="New chat with Cypher"
        onClick={() => cypher.fresh()}
      >
        <Icon name="chat" />
        <span className="lbl">New chat</span>
      </button>
      {s.conversations.length > 0 && (
        <ul className="cv-list">
          {s.conversations.map((c) => {
            const title = c.title ?? 'Untitled conversation';
            return (
              <li key={c.id} className="cv-row">
                <button
                  className="nav sl cv-item"
                  aria-current={s.activeId === c.id ? 'page' : undefined}
                  title={c.summary ? `${title}: ${c.summary}` : title}
                  onClick={() => void open(c.id)}
                >
                  <Icon name="time" />
                  <span className="lbl">
                    <span className="cv-title">{title}</span>
                    <span className="cv-sum">{c.summary ?? when(c.updatedAt)}</span>
                  </span>
                </button>
                <button
                  className="cv-del"
                  title="Delete conversation"
                  aria-label={`Delete conversation ${title}`}
                  onClick={() => void remove(c.id, title)}
                >
                  <Icon name="close" sm />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Strip() {
  const app = useApp();
  const { layout, setLayout, go, openOverlay, setUi, toast } = app;
  const mc = useMission().data;
  const now = useNow(15_000);
  const conn = useConn();
  if (!mc) return <header className="top" />;
  const p = mc.project;
  const tz = p.timezone;
  const pct = p.spent.usd / p.budgets.usd;
  const phase = p.currentPhase;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const narrow = matchMedia('(max-width: 900px)').matches;
  const first = mc.waitingOnYou.find((x) => x.status === 'open');
  return (
    <header className="top">
      <button
        className="top-item mproj"
        aria-label="Switch project"
        onClick={() => openOverlay(<ProjectMenu />)}
      >
        <span className="ini">{p.initials}</span>
      </button>
      {layout.present && (
        <>
          <span className="present-lock" dangerouslySetInnerHTML={{ __html: LOCKUP_SVG }} />
          <span className="top-sep" />
          <div className="top-item proj">
            <b>{p.name}</b>
            <span>{p.target?.site ?? p.source.repo ?? ''} on SitecoreAI</span>
          </div>
          <span className="top-sep" />
        </>
      )}
      <button className="top-item" title="Open the plan at this phase" onClick={() => go('plan')}>
        <span>
          {phase
            ? `Phase ${phase.number}: ${phase.name}`
            : p.status === 'completed'
              ? 'Complete'
              : 'Not started'}
        </span>
        <span className="phase-bar">
          <i style={{ width: `${phase?.percent ?? 0}%` }} />
        </span>
        <span className="muted tnum">{phase?.percent ?? 0}%</span>
      </button>
      <div className="top-item" title={p.healthReason ?? undefined}>
        <span className={`dot ${HEALTH_DOT[p.health]}`} />
        <span>{HEALTH_WORD[p.health]}</span>
      </div>
      <button
        className="top-item hide-present"
        data-action="focus-waiting"
        onClick={() => {
          if (!first) return toast('Nothing is waiting on you');
          go('inbox', { expanded: first.escalationId });
        }}
      >
        <span className={`waiting ${p.waitingCount ? '' : 'none'}`}>
          {p.waitingCount ? `Waiting on you: ${p.waitingCount}` : 'Nothing waiting on you'}
        </span>
      </button>
      <span className="top-sep meta" />
      <div className="top-item" title={tz}>
        {clock(now, tz)} {zoneLabel(tz)}
      </div>
      <div className="top-item meta muted" title="Elapsed">
        {elapsed(p.startedAt, now)}
      </div>
      <div className="top-item meta" title="Cost against budget">
        <span
          className="muted"
          style={
            pct >= 1
              ? { color: 'var(--danger)' }
              : pct >= 0.8
                ? { color: 'var(--warning)' }
                : undefined
          }
        >
          {usd(p.spent.usd)} of {usd(p.budgets.usd)}
        </span>
      </div>
      <div className="top-right">
        {conn.kind !== 'live' && (
          <span className="strip-note">
            <span className="dot warn" />
            {conn.kind === 'reconnecting'
              ? 'Reconnecting'
              : `Catching up${conn.n ? `: ${conn.n} event${conn.n === 1 ? '' : 's'}` : ''}`}
          </span>
        )}
        {p.holds.length > 0 && (
          <span className="strip-note">
            <span className="dot warn" />
            Paused: {p.holds.map((h) => h.label).join(', ')}
          </span>
        )}
        {p.status === 'paused' && (
          <span className="strip-note">
            <span className="dot warn" />
            Project paused
          </span>
        )}
        <button className="searchbtn hide-present" onClick={() => openOverlay(<Palette />)}>
          <Icon name="search" sm />
          <span className="lbl">Search or run a command</span>
          <span className="kbd">{mac ? '⌘K' : 'Ctrl K'}</span>
        </button>
        <button
          className="iconbtn sl"
          data-action="present"
          title={layout.present ? 'Exit presentation (Esc)' : 'Presentation mode'}
          aria-label={layout.present ? 'Exit presentation' : 'Presentation mode'}
          onClick={() => {
            setLayout({ present: !layout.present });
            go('mission');
          }}
        >
          <Icon name={layout.present ? 'close' : 'presentation-file'} />
        </button>
        <button
          className="iconbtn sl dock-toggle"
          title="Cypher"
          aria-label="Open Cypher"
          style={{ display: narrow ? 'grid' : 'none' }}
          onClick={() => setLayout({ dockOpen: !layout.dockOpen })}
        >
          <Icon name="chat" />
        </button>
      </div>
    </header>
  );
}

export function MobileNav() {
  const { surface, go, layout, setLayout, openOverlay, projects, projectId } = useApp();
  const waiting = projects.find((p) => p.id === projectId)?.waitingCount ?? 0;
  // The Dashboard has no project surfaces to switch between.
  if (!projectId) return null;
  const item = (s: Surface, icon: string, label: string) => (
    <button className="mn" aria-current={surface === s ? 'page' : undefined} onClick={() => go(s)}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  );
  return (
    <nav className="mnav" aria-label="Sections">
      {item('mission', 'dashboard', 'Mission')}
      {item('team', 'user-group', 'Team')}
      {item('plan', 'milestone', 'Plan')}
      <button className="mn mn-cy" onClick={() => setLayout({ dockOpen: !layout.dockOpen })}>
        <Icon name="chat" />
        <span>Cypher</span>
        {waiting > 0 && <span className="badge">{waiting}</span>}
      </button>
      <button className="mn" onClick={() => openOverlay(<MoreSheet />)}>
        <Icon name="overflow-menu--vertical" />
        <span>More</span>
      </button>
    </nav>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          {t.text}
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * "Since you were away": when the page comes back after a while, or opens on a project seen
 * before, sum up what changed since the last event the Director saw.
 */
export function useAwayLine() {
  const { projectId, setUi } = useApp();
  const seq = useMission().data?.seq ?? null;
  const seqRef = useRef(seq);
  seqRef.current = seq;

  useEffect(() => {
    if (!projectId || seq === null) return;
    const key = `lw-seen-${projectId}`;
    let seen: number | null = null;
    try {
      seen = Number(localStorage.getItem(key)) || null;
    } catch {
      /* no storage: no away line on reload */
    }
    const summarize = (from: number, label?: string) =>
      get<SinceSummary>(`/projects/${projectId}/since?seq=${from}`)
        .then((s) => {
          if (!s.events) return;
          const parts = [
            `${s.raised} escalation${s.raised === 1 ? '' : 's'} raised, ${s.resolved} resolved.`,
            s.phase ? `${s.phase.name} moved to ${s.phase.percent}%.` : '',
            s.usd ? `$${s.usd} consumed.` : '',
          ];
          setUi({
            awayLine: `Since you were away (${label ?? `${s.minutes} min`}): ${parts.filter(Boolean).join(' ')}`,
          });
        })
        .catch(() => {});
    if (seen !== null && seen < seq - 20) void summarize(seen);
    let hiddenAt: { t: number; seq: number } | null = null;
    const onVis = () => {
      if (document.hidden) hiddenAt = { t: Date.now(), seq: seqRef.current ?? 0 };
      else if (hiddenAt && Date.now() - hiddenAt.t > 20_000) {
        void summarize(hiddenAt.seq, `${Math.round((Date.now() - hiddenAt.t) / 60_000)} min`);
        hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // Only when the project changes: later snapshots just move the bookmark below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    if (!projectId || seq === null) return;
    try {
      localStorage.setItem(`lw-seen-${projectId}`, String(seq));
    } catch {
      /* no storage */
    }
  }, [projectId, seq]);
}
