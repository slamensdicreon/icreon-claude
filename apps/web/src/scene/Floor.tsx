import type { ActivityItem, PlanSnapshot, TaskView } from '@lw/contracts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useMission, useProjectResource, useTeam } from '../state';
import {
  applyBeat,
  applyTeam,
  beatsFromItems,
  beatsFromPlan,
  createScene,
  layoutFloor,
  packetPos,
  relayout,
  specsOf,
  tick,
  WORKSTREAM_LABEL,
  WORKSTREAMS,
  type Beat,
  type SceneState,
  type Workstream,
} from './model';

/**
 * The agent floor, drawn on a canvas. Takes the Activity surface's rows (newest first, already
 * filtered) and the project's team, plan and Mission Control snapshots; every new row or task
 * change becomes a beat. Opening the floor replays the last minute of rows quickly, so it shows
 * what just happened rather than an empty office.
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

export function Floor({ items }: { items: ActivityItem[] | null }) {
  const { inspect, layout: appLayout } = useApp();
  const team = useTeam().data;
  const plan = useProjectResource<PlanSnapshot>('/plan').data;
  const mc = useMission().data;
  const theme = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const still = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  const present = appLayout.present;

  const cmsLabel = useMemo(() => {
    const servers = new Set((items ?? []).map((i) => i.toolServer ?? ''));
    if ([...servers].some((s) => s.startsWith('optimizely'))) return 'Optimizely';
    if ([...servers].some((s) => s.startsWith('sitecore'))) return 'SitecoreAI';
    return 'CMS';
  }, [items]);

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

  // Beats from new rows: on open, the last minute replays quickly; afterwards each new row.
  const seenSeq = useRef<number | null>(null);
  const pending = useRef<Beat[]>([]);
  useEffect(() => {
    if (!items || !sceneRef.current) return;
    const taskAgent = (id: string) => plan?.tasks.find((t) => t.taskId === id)?.agentId ?? null;
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
    pending.current.push(...beatsFromItems(fresh, taskAgent));
  }, [items, plan]);

  // Beats from plan changes: dispatches, handoffs, cards.
  const prevTasks = useRef<Map<string, TaskView> | null>(null);
  useEffect(() => {
    if (!plan) return;
    if (prevTasks.current) pending.current.push(...beatsFromPlan(prevTasks.current, plan.tasks));
    prevTasks.current = new Map(plan.tasks.map((t) => [t.taskId, t]));
  }, [plan]);

  // The team's working state and task counts.
  useEffect(() => {
    const s = sceneRef.current;
    if (!s || !team) return;
    const running = new Map<string, number>();
    for (const t of plan?.tasks ?? [])
      if (t.state === 'running' || t.state === 'validating')
        running.set(t.agentId, (running.get(t.agentId) ?? 0) + 1);
    s.paused = mc?.project.status === 'paused' || (mc?.project.holds.length ?? 0) > 0;
    applyTeam(s, team.agents, running);
  }, [team, plan, mc]);

  // The loop: release one pending beat every so often, advance, draw.
  const hoverRef = useRef<string | null>(null);
  hoverRef.current = hover;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let nextBeatAt = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const s = sceneRef.current;
      const canvas = canvasRef.current;
      if (!s || !canvas) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (pending.current.length && now >= nextBeatAt) {
        applyBeat(s, pending.current.shift()!);
        // A backlog drains faster than a trickle.
        nextBeatAt = now + (pending.current.length > 8 ? BEAT_GAP_MS / 3 : BEAT_GAP_MS);
      }
      tick(s, dt, now);
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
      const radius = f.spec.tier === 'chief_of_staff' ? 24 : f.spec.tier === 'lead' ? 18 : 15;
      if (d <= radius + 4 && (!best || d < best.d)) best = { id, d };
    }
    return best?.id ?? null;
  };

  const live = Boolean(team && mc && !sceneRef.current?.paused);
  return (
    <div className="floor" ref={wrapRef}>
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
      <div className="floor-state" data-live={live}>
        <i />
        {!team ? 'Connecting' : sceneRef.current?.paused ? 'Paused' : live ? 'Live' : 'Idle'}
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
  );
}

// ---------------------------------------------------------------------------
// Drawing
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
      for (let i = 1; i < f.trail.length; i++) {
        ctx.strokeStyle = alpha(col, (i / f.trail.length) * 0.35);
        ctx.lineWidth = 2;
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
    ctx.arc(pos.x, pos.y, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = col;
    if (p.kind === 'doc') {
      roundRect(ctx, pos.x - 4, pos.y - 5, 8, 10, 1.5);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Figures: specialists, then Leads, then Cypher on top.
  const order = [...s.figures.values()].sort((a, b) => rank(a.spec.tier) - rank(b.spec.tier));
  for (const f of order) {
    const r = f.spec.tier === 'chief_of_staff' ? 22 : f.spec.tier === 'lead' ? 16 : 13;
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
    ctx.font = `600 ${f.spec.tier === 'chief_of_staff' ? 13 : 10.5}px ${th.font}`;
    ctx.fillText(f.spec.initials, f.pos.x, f.pos.y + 0.5);
    // Names: Cypher and Leads always, others on hover.
    if (f.spec.tier !== 'specialist' || hover === f.spec.id) {
      ctx.fillStyle = th.fg2;
      ctx.font = `11px ${th.font}`;
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
