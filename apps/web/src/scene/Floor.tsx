import type { ActivityItem, PlanSnapshot, TaskView } from '@lw/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../lib/icons';
import { zoneLabel } from '../lib/fmt';
import { useApp, useMission, useProjectResource, useTeam, useTz } from '../state';
import {
  applyBeat,
  applyTeam,
  beatsFromItems,
  beatsFromPlan,
  createScene,
  layoutFloor,
  packetPos,
  relayout,
  resetScene,
  settle,
  specsOf,
  tick,
  WORKSTREAM_LABEL,
  WORKSTREAMS,
  type Beat,
  TRAIL,
  type SceneState,
  type TaskLookup,
  type Workstream,
} from './model';
import {
  advance,
  atEnd,
  createReplay,
  density,
  loadHistory,
  PRESET_LABEL,
  PRESETS,
  presetWindow,
  seekTo,
  SPEEDS,
  type Density,
  type Replay,
  type ReplayPreset,
  type Speed,
} from './replay';

/**
 * The agent floor, drawn on a canvas. Live, it takes the Activity surface's rows (newest first,
 * already filtered) and the project's team, plan and Mission Control snapshots; every new row or
 * task change becomes a beat. Opening the floor replays the last minute of rows quickly, so it
 * shows what just happened rather than an empty office. In replay, a window of the project's
 * history plays back at 10x or 60x on a project-time clock, with a strip to scrub.
 */

const CATCH_UP_MS = 60_000;
const BEAT_GAP_MS = 320;

interface Theme {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  borderStrong: string;
  fg: string;
  fg2: string;
  fg3: string;
  accent: string;
  accentText: string;
  onAccent: string;
  danger: string;
  success: string;
  warning: string;
  ws: Record<Workstream, string>;
  font: string;
}

function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--web-bg', '#f8f8f7'),
    surface: v('--web-surface', '#fff'),
    surface2: v('--web-surface-2', '#f8f8f7'),
    border: v('--web-border', '#e6e6e6'),
    borderStrong: v('--web-border-strong', '#cfcfcf'),
    fg: v('--web-fg', '#000'),
    fg2: v('--web-fg-2', '#474747'),
    fg3: v('--web-fg-3', '#7a7a7a'),
    accent: v('--web-accent', '#386aff'),
    accentText: v('--web-accent-text', '#2752e0'),
    onAccent: v('--web-fg-on-accent', '#fff'),
    danger: v('--danger', '#c8372d'),
    success: v('--success', '#1e8e5a'),
    warning: v('--warning', '#b26a00'),
    ws: {
      discovery: v('--icreon-blue-soft', '#7e9dff'),
      engineering: v('--icreon-blue', '#386aff'),
      content: v('--success', '#1e8e5a'),
      quality: v('--warning', '#b26a00'),
    },
    font: v('--font-sans', 'system-ui, sans-serif'),
  };
}

function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  useEffect(() => {
    const update = () => setTheme(readTheme());
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    return () => {
      mo.disconnect();
      mq.removeEventListener('change', update);
    };
  }, []);
  return theme;
}

type Mode = 'live' | 'replay';

/** Trail length: a short wake normally, a long one on a presentation screen. */
const TRAIL_PRESENT = 72;

export function Floor({ items, hero = false }: { items: ActivityItem[] | null; hero?: boolean }) {
  const { inspect, layout: appLayout, projectId } = useApp();
  const team = useTeam().data;
  const plan = useProjectResource<PlanSnapshot>('/plan').data;
  const mc = useMission().data;
  const tz = useTz();
  const theme = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const still = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const present = appLayout.present;

  // Replay state. The engine lives in a ref (it ticks every frame); `uiTick` wakes the bar.
  const [mode, setMode] = useState<Mode>('live');
  const modeRef = useRef<Mode>('live');
  modeRef.current = mode;
  const [preset, setPreset] = useState<ReplayPreset>('hour');
  const [speed, setSpeed] = useState<Speed>(60);
  const [loading, setLoading] = useState<number | null>(null);
  const replayRef = useRef<Replay | null>(null);
  const loadToken = useRef(0);
  const [, setUiTick] = useState(0);

  const cmsLabel = useMemo(() => {
    const servers = new Set((items ?? []).map((i) => i.toolServer ?? ''));
    if ([...servers].some((s) => s.startsWith('optimizely'))) return 'Optimizely';
    if ([...servers].some((s) => s.startsWith('sitecore'))) return 'SitecoreAI';
    return 'CMS';
  }, [items]);

  // Task lookups from the plan: who runs a task, who waits on it.
  const lookup = useMemo<TaskLookup>(() => {
    const agentOf = new Map<string, string>();
    const heirs = new Map<string, Set<string>>();
    for (const t of plan?.tasks ?? []) {
      agentOf.set(t.taskId, t.agentId);
      for (const dep of t.dependsOn) {
        if (!heirs.has(dep)) heirs.set(dep, new Set());
        heirs.get(dep)!.add(t.agentId);
      }
    }
    return {
      agentOf: (id) => agentOf.get(id) ?? null,
      heirsOf: (id) => [...(heirs.get(id) ?? [])],
    };
  }, [plan]);
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;

  // Size follows the frame.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The scene: built from the roster and the frame; kept across relayouts.
  const specs = useMemo(() => (team ? specsOf(team.agents) : []), [team]);
  useEffect(() => {
    if (!specs.length || !size.w) return;
    const layout = layoutFloor(specs, size.w, size.h, cmsLabel);
    sceneRef.current = sceneRef.current
      ? relayout(sceneRef.current, layout, specs)
      : createScene(layout, specs, still);
  }, [specs, size, cmsLabel, still]);

  // Live beats from new rows: on open, the last minute replays quickly; afterwards each new row.
  const seenSeq = useRef<number | null>(null);
  const pending = useRef<Beat[]>([]);
  useEffect(() => {
    if (!items || !sceneRef.current) return;
    const oldestFirst = [...items].sort((a, b) => a.seq - b.seq);
    let fresh: ActivityItem[];
    if (seenSeq.current === null) {
      const since = Date.now() - CATCH_UP_MS;
      fresh = oldestFirst.filter((i) => Date.parse(i.ts) >= since);
    } else {
      fresh = oldestFirst.filter((i) => i.seq > seenSeq.current!);
    }
    if (oldestFirst.length)
      seenSeq.current = Math.max(seenSeq.current ?? 0, oldestFirst.at(-1)!.seq);
    if (modeRef.current === 'live') pending.current.push(...beatsFromItems(fresh, lookup));
  }, [items, lookup]);

  // Live beats from plan changes: dispatches, handoffs, cards.
  const prevTasks = useRef<Map<string, TaskView> | null>(null);
  useEffect(() => {
    if (!plan) return;
    if (prevTasks.current && modeRef.current === 'live')
      pending.current.push(...beatsFromPlan(prevTasks.current, plan.tasks));
    prevTasks.current = new Map(plan.tasks.map((t) => [t.taskId, t]));
  }, [plan]);

  // The team's working state and task counts (live only; the replay derives its own).
  const syncTeam = useCallback(() => {
    const s = sceneRef.current;
    if (!s || !team) return;
    const running = new Map<string, number>();
    for (const t of plan?.tasks ?? [])
      if (t.state === 'running' || t.state === 'validating')
        running.set(t.agentId, (running.get(t.agentId) ?? 0) + 1);
    s.paused = mc?.project.status === 'paused' || (mc?.project.holds.length ?? 0) > 0;
    applyTeam(s, team.agents, running);
  }, [team, plan, mc]);
  useEffect(() => {
    if (mode === 'live') syncTeam();
  }, [mode, syncTeam]);

  // Replay: load the window, then play it on the loop.
  const startReplay = useCallback(
    (p: ReplayPreset) => {
      if (!projectId) return;
      const current = plan?.phases.find((ph) => ph.status === 'current') ?? null;
      const w = presetWindow(p, {
        now: Date.now(),
        tz,
        startedAt: mc?.project.startedAt ?? null,
        phaseEnteredAt: current?.enteredAt ?? null,
      });
      const token = ++loadToken.current;
      replayRef.current = null;
      setMode('replay');
      setLoading(0);
      void loadHistory(
        projectId,
        w,
        (n) => token === loadToken.current && setLoading(n),
        () => token !== loadToken.current,
      )
        .then((rows) => {
          if (token !== loadToken.current) return;
          const s = sceneRef.current;
          if (s) resetScene(s);
          replayRef.current = createReplay(rows, w, speed);
          setLoading(null);
        })
        .catch(() => {
          if (token !== loadToken.current) return;
          setLoading(null);
          replayRef.current = createReplay([], w, speed);
        });
    },
    [projectId, plan, mc, tz, speed],
  );

  const goLive = useCallback(() => {
    loadToken.current++;
    replayRef.current = null;
    setLoading(null);
    setMode('live');
    const s = sceneRef.current;
    if (s) {
      resetScene(s);
      pending.current = [];
    }
    // The next team snapshot (or the effect above) restores who works.
    syncTeam();
  }, [syncTeam]);

  const seek = useCallback((t: number) => {
    const r = replayRef.current;
    const s = sceneRef.current;
    if (!r || !s) return;
    seekTo(r, t);
    // Rebuild the floor as it stood at `t`: every beat before it, then end the walks in place.
    resetScene(s);
    const before = r.rows.slice(0, r.cursor);
    for (const b of beatsFromItems(before, lookupRef.current)) applyBeat(s, b);
    settle(s);
    setUiTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (replayRef.current) replayRef.current.speed = speed;
  }, [speed]);

  // The loop: release one pending beat every so often (live) or what the clock says (replay),
  // advance, draw.
  const hoverRef = useRef<string | null>(null);
  hoverRef.current = hover;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let nextBeatAt = 0;
    let nextUiAt = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const s = sceneRef.current;
      const canvas = canvasRef.current;
      if (!s || !canvas) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const r = replayRef.current;
      if (modeRef.current === 'replay') {
        if (r) {
          const settled =
            [...s.figures.values()].every((f) => !f.trips.length) && !s.packets.length;
          for (const row of advance(r, dt * 1000, settled, now))
            for (const b of beatsFromItems([row], lookupRef.current)) applyBeat(s, b);
          if (now >= nextUiAt) {
            nextUiAt = now + 250;
            setUiTick((n) => n + 1);
          }
        }
      } else if (pending.current.length && now >= nextBeatAt) {
        applyBeat(s, pending.current.shift()!);
        // A backlog drains faster than a trickle.
        nextBeatAt = now + (pending.current.length > 8 ? BEAT_GAP_MS / 3 : BEAT_GAP_MS);
      }
      tick(s, dt, now, present ? TRAIL_PRESENT : TRAIL);
      draw(canvas, s, theme, now, present, hoverRef.current);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [theme, present]);

  const figureAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = sceneRef.current;
    const canvas = canvasRef.current;
    if (!s || !canvas) return null;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best: { id: string; d: number } | null = null;
    for (const [id, f] of s.figures) {
      const d = Math.hypot(f.pos.x - x, f.pos.y - y);
      const radius =
        (f.spec.tier === 'chief_of_staff' ? 24 : f.spec.tier === 'lead' ? 18 : 15) *
        (present ? 1.18 : 1);
      if (d <= radius + 4 && (!best || d < best.d)) best = { id, d };
    }
    return best?.id ?? null;
  };

  const replay = replayRef.current;
  const live = Boolean(team && mc && !sceneRef.current?.paused);
  const pill =
    mode === 'replay'
      ? loading !== null
        ? 'Loading history'
        : replay && atEnd(replay)
          ? 'End of window'
          : replay?.playing
            ? `Replay ${speed}×`
            : 'Replay paused'
      : !team
        ? 'Connecting'
        : sceneRef.current?.paused
          ? 'Paused'
          : live
            ? 'Live'
            : 'Idle';
  return (
    <div className={hero ? 'floor floor-hero' : 'floor'}>
      <div className="floor-canvas" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="The team at work: agents moving between their desks, their Leads, Cypher and the systems they use"
          style={{ cursor: hover ? 'pointer' : 'default' }}
          onMouseMove={(e) => setHover(figureAt(e))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const id = figureAt(e);
            if (id) inspect('agent', id);
          }}
        />
        {!team && <div className="floor-empty">Loading the team…</div>}
        <div
          className="floor-state"
          data-live={mode === 'live' && live}
          data-replay={mode === 'replay'}
        >
          <i />
          {pill}
        </div>
        <div className="floor-legend" aria-hidden="true">
          {WORKSTREAMS.map((ws) => (
            <span key={ws}>
              <i style={{ background: theme.ws[ws] }} />
              {WORKSTREAM_LABEL[ws]}
            </span>
          ))}
          <span>
            <i style={{ background: theme.accent }} />
            Cypher
          </span>
          <span>Click an agent for details</span>
        </div>
      </div>
      <ReplayBar
        mode={mode}
        onLive={goLive}
        onReplay={() => startReplay(preset)}
        preset={preset}
        onPreset={(p) => {
          setPreset(p);
          if (mode === 'replay') startReplay(p);
        }}
        speed={speed}
        onSpeed={setSpeed}
        replay={mode === 'replay' ? replay : null}
        loading={loading}
        onToggle={() => {
          const r = replayRef.current;
          if (!r) return;
          if (atEnd(r)) seek(r.window.since);
          r.playing = !r.playing || atEnd(r);
          setUiTick((n) => n + 1);
        }}
        onSeek={seek}
        tz={tz}
        theme={theme}
        phase={sceneRef.current?.phase ?? null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The replay bar
// ---------------------------------------------------------------------------

const clockFmt = new Map<string, Intl.DateTimeFormat>();
function projectClock(t: number, tz: string): string {
  let f = clockFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
    clockFmt.set(tz, f);
  }
  return `${f.format(new Date(t))} ${zoneLabel(tz)}`;
}

function ReplayBar({
  mode,
  onLive,
  onReplay,
  preset,
  onPreset,
  speed,
  onSpeed,
  replay,
  loading,
  onToggle,
  onSeek,
  tz,
  theme,
  phase,
}: {
  mode: Mode;
  onLive: () => void;
  onReplay: () => void;
  preset: ReplayPreset;
  onPreset: (p: ReplayPreset) => void;
  speed: Speed;
  onSpeed: (s: Speed) => void;
  replay: Replay | null;
  loading: number | null;
  onToggle: () => void;
  onSeek: (t: number) => void;
  tz: string;
  theme: Theme;
  phase: number | null;
}) {
  const stripRef = useRef<HTMLCanvasElement>(null);
  const dens = useMemo<Density | null>(() => (replay ? density(replay) : null), [replay]);
  const skipped =
    replay?.skippedAt !== null && replay !== null && performance.now() - replay.skippedAt < 1600;

  useEffect(() => {
    const canvas = stripRef.current;
    if (!canvas || !replay || !dens) return;
    drawStrip(canvas, replay, dens, theme);
  });

  const seekFrom = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!replay) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    onSeek(replay.window.since + at * (replay.window.until - replay.window.since));
  };

  return (
    <div className="replay" data-mode={mode}>
      <div className="act-view" role="group" aria-label="Floor time">
        <button aria-pressed={mode === 'live'} onClick={onLive}>
          Live
        </button>
        <button aria-pressed={mode === 'replay'} onClick={onReplay}>
          Replay
        </button>
      </div>
      {mode === 'replay' && (
        <>
          <select
            className="select rp-window"
            aria-label="Replay window"
            value={preset}
            onChange={(e) => onPreset(e.target.value as ReplayPreset)}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {PRESET_LABEL[p]}
              </option>
            ))}
          </select>
          <button
            className="rp-play"
            aria-label={replay?.playing ? 'Pause' : 'Play'}
            disabled={!replay || loading !== null}
            onClick={onToggle}
          >
            {replay?.playing ? <PauseGlyph /> : <PlayGlyph />}
          </button>
          <div className="act-view rp-speed" role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} aria-pressed={speed === s} onClick={() => onSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
          <div className="rp-track">
            {loading !== null ? (
              <div className="rp-loading">
                Loading history… {loading.toLocaleString('en-US')} rows
              </div>
            ) : replay && !replay.rows.length ? (
              <div className="rp-loading">Nothing happened in this window.</div>
            ) : (
              <canvas
                ref={stripRef}
                className="rp-strip"
                role="slider"
                aria-label="Replay position"
                aria-valuemin={replay?.window.since}
                aria-valuemax={replay?.window.until}
                aria-valuenow={replay?.vt}
                tabIndex={0}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  seekFrom(e);
                }}
                onPointerMove={(e) => {
                  if (e.buttons & 1) seekFrom(e);
                }}
                onKeyDown={(e) => {
                  if (!replay) return;
                  const step = (replay.window.until - replay.window.since) / 50;
                  if (e.key === 'ArrowLeft') onSeek(replay.vt - step);
                  if (e.key === 'ArrowRight') onSeek(replay.vt + step);
                }}
              />
            )}
          </div>
          <div className="rp-clock">
            {replay && loading === null ? (
              <>
                <span className="rp-time">{projectClock(replay.vt, tz)}</span>
                <span className="rp-sub">
                  {skipped
                    ? 'Quiet stretch skipped'
                    : phase !== null
                      ? `Phase ${phase} · ${replay.rows.length.toLocaleString('en-US')} rows`
                      : `${replay.rows.length.toLocaleString('en-US')} rows`}
                </span>
              </>
            ) : null}
          </div>
        </>
      )}
      {mode === 'live' && (
        <span className="rp-hint">
          <Icon name="time" sm /> Replay a window of the project's history at 10× or 60×
        </span>
      )}
    </div>
  );
}

const PlayGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
  </svg>
);
const PauseGlyph = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" fill="currentColor" />
  </svg>
);

function drawStrip(canvas: HTMLCanvasElement, r: Replay, d: Density, th: Theme) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = canvas.clientWidth;
  const H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const span = Math.max(1, r.window.until - r.window.since);
  const px = (t: number) => ((t - r.window.since) / span) * W;
  const base = H - 6;
  // Bars: log-scaled so a burst doesn't flatten the rest; failures tinted on top.
  const bw = W / d.bins;
  for (let i = 0; i < d.bins; i++) {
    const c = d.counts[i]!;
    if (!c) continue;
    const h = Math.max(2, (Math.log1p(c) / Math.log1p(d.max)) * (base - 10));
    const x = i * bw;
    const played = x + bw <= px(r.vt);
    ctx.fillStyle = alpha(th.accent, played ? 0.55 : 0.22);
    ctx.fillRect(x + 0.5, base - h, Math.max(1, bw - 1), h);
    const bad = d.bad[i]!;
    if (bad) {
      const bh = Math.max(2, (bad / c) * h);
      ctx.fillStyle = alpha(th.danger, played ? 0.9 : 0.5);
      ctx.fillRect(x + 0.5, base - h, Math.max(1, bw - 1), bh);
    }
  }
  // Baseline.
  ctx.fillStyle = th.borderStrong;
  ctx.fillRect(0, base, W, 1);
  // Phase starts.
  ctx.font = `600 9px ${th.font}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  let lastLabelX = -Infinity;
  for (const p of d.phases) {
    const x = Math.round(p.at * W) + 0.5;
    ctx.strokeStyle = th.fg3;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 2);
    ctx.lineTo(x, base);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = th.fg3;
    // Two phases starting close together: the second label steps down a line.
    const crowded = x - lastLabelX < 22;
    ctx.fillText(`P${p.phase}`, x + 3, crowded ? 11 : 1);
    lastLabelX = crowded ? -Infinity : x;
  }
  // Cards raised.
  for (const at of d.cards) {
    const x = at * W;
    ctx.fillStyle = th.warning;
    ctx.beginPath();
    ctx.moveTo(x, base + 2);
    ctx.lineTo(x + 3.5, base + 5.5);
    ctx.lineTo(x, H);
    ctx.lineTo(x - 3.5, base + 5.5);
    ctx.closePath();
    ctx.fill();
  }
  // Playhead.
  const x = Math.round(px(r.vt)) + 0.5;
  ctx.strokeStyle = th.fg;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, H);
  ctx.stroke();
  ctx.fillStyle = th.fg;
  ctx.beginPath();
  ctx.moveTo(x - 4, 0);
  ctx.lineTo(x + 4, 0);
  ctx.lineTo(x, 5);
  ctx.closePath();
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Drawing the floor
// ---------------------------------------------------------------------------

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function alpha(hex: string, a: number): string {
  // Accepts #rgb/#rrggbb and rgb()/rgba(); anything else is returned as is.
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (m) {
    const h =
      m[1]!.length === 3
        ? m[1]!
            .split('')
            .map((c) => c + c)
            .join('')
        : m[1]!;
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(hex);
  if (rgb) {
    const parts = rgb[1]!
      .split(',')
      .slice(0, 3)
      .map((s) => s.trim());
    return `rgba(${parts.join(', ')}, ${a})`;
  }
  return hex;
}

function draw(
  canvas: HTMLCanvasElement,
  s: SceneState,
  th: Theme,
  now: number,
  present: boolean,
  hover: string | null,
) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = s.layout.width;
  const H = s.layout.height;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = `11px ${th.font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const dim = s.paused ? 0.55 : 1;
  // On a presentation screen everything that moves is a little larger and brighter.
  const k = present ? 1.18 : 1;

  // Islands.
  for (const isl of s.layout.islands) {
    ctx.fillStyle = alpha(th.ws[isl.ws], 0.06);
    roundRect(ctx, isl.x, isl.y, isl.w, isl.h, 16);
    ctx.fill();
    ctx.strokeStyle = alpha(th.ws[isl.ws], 0.28);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = th.fg3;
    ctx.textAlign = 'left';
    ctx.font = `600 10.5px ${th.font}`;
    ctx.fillText(isl.label.toUpperCase(), isl.x + 12, isl.y + 14);
    ctx.textAlign = 'center';
    ctx.font = `11px ${th.font}`;
  }

  // The Director's door.
  ctx.fillStyle = th.fg;
  roundRect(ctx, s.layout.door.x - 46, s.layout.door.y - 4, 92, 6, 3);
  ctx.fill();
  ctx.fillStyle = th.fg2;
  ctx.fillText('Director', s.layout.door.x, s.layout.door.y - 14);

  // Stations, the Workbench and the live site.
  for (const st of s.layout.stations) {
    const busy = [...s.figures.values()].some((f) => f.at === st.id);
    if (busy && present) {
      ctx.fillStyle = alpha(th.accent, 0.1);
      ctx.beginPath();
      ctx.arc(st.pos.x, st.pos.y, 34, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = busy ? alpha(th.accent, 0.14) : th.surface2;
    ctx.strokeStyle = busy ? th.accent : th.borderStrong;
    roundRect(ctx, st.pos.x - 22, st.pos.y - 14, 44, 28, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = th.fg2;
    ctx.fillText(st.label, st.pos.x, st.pos.y + 28);
  }
  const corner = (p: { x: number; y: number }, label: string) => {
    ctx.strokeStyle = th.borderStrong;
    ctx.setLineDash([3, 3]);
    roundRect(ctx, p.x - 28, p.y - 14, 56, 28, 8);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = th.fg3;
    ctx.fillText(label, p.x, p.y + (p.y < H / 2 ? 28 : -24));
  };
  corner(s.layout.workbench, 'Workbench');
  corner(s.layout.site, 'Live site');

  // Trails (presentation only).
  if (present && !s.still) {
    for (const f of s.figures.values()) {
      if (f.trail.length < 2) continue;
      const col =
        f.spec.tier === 'chief_of_staff'
          ? th.accent
          : f.spec.workstream
            ? th.ws[f.spec.workstream]
            : th.fg3;
      ctx.lineCap = 'round';
      for (let i = 1; i < f.trail.length; i++) {
        const t = i / f.trail.length;
        ctx.strokeStyle = alpha(col, t * 0.45);
        ctx.lineWidth = 1 + t * 3;
        ctx.beginPath();
        ctx.moveTo(f.trail[i - 1]!.x, f.trail[i - 1]!.y);
        ctx.lineTo(f.trail[i]!.x, f.trail[i]!.y);
        ctx.stroke();
      }
    }
  }

  // Packets.
  for (const p of s.packets) {
    const pos = packetPos(p);
    const col =
      p.kind === 'release'
        ? th.success
        : p.kind === 'answer'
          ? th.fg
          : p.kind === 'doc'
            ? th.fg2
            : th.accent;
    ctx.fillStyle = alpha(col, 0.22);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 9 * k, 0, Math.PI * 2);
    ctx.fill();
    if (present) {
      ctx.shadowColor = alpha(col, 0.7);
      ctx.shadowBlur = 14;
    }
    ctx.fillStyle = col;
    if (p.kind === 'doc') {
      roundRect(ctx, pos.x - 4 * k, pos.y - 5 * k, 8 * k, 10 * k, 1.5);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 4 * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // Figures: specialists, then Leads, then Cypher on top.
  const order = [...s.figures.values()].sort((a, b) => rank(a.spec.tier) - rank(b.spec.tier));
  for (const f of order) {
    const r = (f.spec.tier === 'chief_of_staff' ? 22 : f.spec.tier === 'lead' ? 16 : 13) * k;
    const col =
      f.spec.tier === 'chief_of_staff'
        ? th.accent
        : f.spec.workstream
          ? th.ws[f.spec.workstream]
          : th.fg2;
    const faint = f.spec.inactive;
    ctx.globalAlpha = (faint ? 0.3 : 1) * dim;

    // Working pulse.
    if (f.working && !s.still && !s.paused) {
      const ph = (((now / 1600 + f.pos.x * 0.001) % 1) + 1) % 1;
      ctx.strokeStyle = alpha(col, 0.45 * (1 - ph));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(f.pos.x, f.pos.y, r + 4 + ph * 12, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Orbiting tasks.
    if (f.tasks > 0 && !s.still) {
      for (let i = 0; i < f.tasks; i++) {
        const a = now / 2400 + (i / f.tasks) * Math.PI * 2;
        const ox = f.pos.x + Math.cos(a) * (r + 9);
        const oy = f.pos.y + Math.sin(a) * (r + 9) * 0.7;
        ctx.fillStyle = alpha(col, 0.85);
        ctx.beginPath();
        ctx.arc(ox, oy, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Flash ring after a review or a failure.
    if (f.flash > 0) {
      ctx.strokeStyle = alpha(f.flashBad ? th.danger : th.success, f.flash);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(f.pos.x, f.pos.y, r + 3 + (1 - f.flash) * 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Disc.
    ctx.fillStyle = f.spec.tier === 'lead' ? th.surface : col;
    ctx.beginPath();
    ctx.arc(f.pos.x, f.pos.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (f.spec.tier === 'lead') {
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    if (hover === f.spec.id) {
      ctx.strokeStyle = th.fg;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(f.pos.x, f.pos.y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = f.spec.tier === 'lead' ? col : th.onAccent;
    ctx.font = `600 ${(f.spec.tier === 'chief_of_staff' ? 13 : 10.5) * k}px ${th.font}`;
    ctx.fillText(f.spec.initials, f.pos.x, f.pos.y + 0.5);
    // Names: Cypher and Leads always, others on hover.
    if (f.spec.tier !== 'specialist' || hover === f.spec.id) {
      ctx.fillStyle = th.fg2;
      ctx.font = `${11 * k}px ${th.font}`;
      const label = f.spec.tier === 'chief_of_staff' ? 'Cypher' : f.spec.name;
      ctx.fillText(label, f.pos.x, f.pos.y + r + 11);
      if (hover === f.spec.id && f.spec.tier !== 'chief_of_staff') {
        ctx.fillStyle = th.fg3;
        ctx.fillText(f.spec.role, f.pos.x, f.pos.y + r + 23);
      }
    }
    ctx.globalAlpha = 1;
  }

  if (s.paused) {
    ctx.fillStyle = th.fg3;
    ctx.font = `12px ${th.font}`;
    ctx.fillText('Paused: everyone is at their desk', W / 2, H - 14);
  }
}

function rank(t: string): number {
  return t === 'chief_of_staff' ? 2 : t === 'lead' ? 1 : 0;
}
