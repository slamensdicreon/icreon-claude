import type { ActivityItem, AgentView, PlanSnapshot, TaskView } from '@lw/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stamp, zoneLabel } from '../lib/fmt';
import { useApp, useMission, useProjectResource, useTeam, useTz } from '../state';
import { Icon } from '../theme/icons';
import { LiveEye } from '../ui/eye/LiveEye';
import { useEyeState } from '../voice/eye';
import fl from './floor.module.css';
import { beatsFromPlan, type Beat, type TaskLookup, type Workstream } from './model';
import {
  advanceOrbit,
  agentAt,
  applyOrbitBeat,
  beatsWithItems,
  cometAt,
  createOrbit,
  endAt,
  gazeTo,
  rebuildOrbit,
  resetOrbit,
  RING_R,
  RINGS,
  STATION_R,
  type OrbitState,
  type Tone,
} from './orbit';
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
 * The Floor: the project's team as an orbit around Cypher. Each team rides its own ring, the
 * systems they use sit on the outer ring, and every row of the feed launches a comet between
 * them: a tool call out to a station, a handoff to a teammate, a result back to the Lead, a card
 * to Cypher. Cypher's eye watches it all; follow someone and the eye, a camera and a caption stay
 * on them. Live, it takes the Activity rows (newest first) and the team, plan and Mission Control
 * snapshots; opening it replays the last minute quickly. Replay plays a window of the project's
 * history at 10x or 60x, with a strip to scrub. Older projects work the same way: agents with no
 * team ride the inner ring, rows from roles no longer on the roster act from the core, and a
 * project that went quiet opens its replay on the whole history instead of an empty hour.
 */

const CATCH_UP_MS = 60_000;
const BEAT_GAP_MS = 320;
const POOL = 30;

interface Theme {
  borderStrong: string;
  fg: string;
  fg3: string;
  accent: string;
  danger: string;
  warning: string;
  font: string;
}

/** The replay strip's palette, read by name from Cypher's tokens (theme/tokens.css). */
function readTheme(): Theme {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    borderStrong: v('--mist'),
    fg: v('--ink'),
    fg3: v('--text-3'),
    accent: v('--ink'),
    danger: v('--coral-text'),
    warning: v('--gold'),
    font: v('--font-sans'),
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
type Variant = 'everything' | 'bliss' | 'hero';

/** Each team's hue, by token. */
const HUE: Record<Workstream | 'none', string> = {
  discovery: 'var(--iris)',
  engineering: 'var(--blue)',
  content: 'var(--teal)',
  quality: 'var(--gold)',
  none: 'var(--text-3)',
};
const RING_LABEL: Record<Workstream, string> = {
  discovery: 'Discovery',
  engineering: 'Engineering',
  content: 'Content',
  quality: 'Quality',
};
function toneColor(tone: Tone, ws: Workstream | 'none'): string {
  return tone === 'team'
    ? HUE[ws]
    : tone === 'good'
      ? 'var(--green)'
      : tone === 'bad' || tone === 'coral'
        ? 'var(--coral)'
        : 'var(--ink)';
}

/** Cypher's sentence with the Director's clause in bold, said once. */
function Said({ text, emphasis }: { text: string; emphasis: string | null }) {
  const i = emphasis ? text.indexOf(emphasis) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <b>{emphasis}</b>
      {text.slice(i + emphasis!.length)}
    </>
  );
}

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
const RUNNING = new Set(['running', 'validating']);

export function Floor({
  items,
  hero = false,
  variant: asked = 'everything',
}: {
  items: ActivityItem[] | null;
  hero?: boolean;
  variant?: 'everything' | 'bliss';
}) {
  const variant: Variant = hero ? 'hero' : asked;
  const { inspect, projectId } = useApp();
  const team = useTeam().data;
  const plan = useProjectResource<PlanSnapshot>('/plan').data;
  const mc = useMission().data;
  const tz = useTz();
  const theme = useTheme();
  const eye = useEyeState();
  const still = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  const orbitRef = useRef<OrbitState | null>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const sideRef = useRef(0);
  const [side, setSide] = useState(0);
  const agentEls = useRef(new Map<string, HTMLDivElement>());
  const stationEls = useRef(new Map<string, HTMLDivElement>());
  const cometEls = useRef<(HTMLSpanElement | null)[]>([]);
  const gaze = useRef<{ x: number; y: number } | null>(null);
  const [follow, setFollow] = useState<string | null>(null);
  const followRef = useRef<string | null>(null);
  followRef.current = follow;
  const [cheer, setCheer] = useState(0);
  const [passText, setPassText] = useState<string | null>(null);
  const [, setUiTick] = useState(0);

  // Replay state. The engine lives in a ref (it ticks every frame); `uiTick` wakes the bar.
  const [mode, setMode] = useState<Mode>('live');
  const modeRef = useRef<Mode>('live');
  modeRef.current = mode;
  const [preset, setPreset] = useState<ReplayPreset | null>(null);
  const [speed, setSpeed] = useState<Speed>(60);
  const [loading, setLoading] = useState<number | null>(null);
  const replayRef = useRef<Replay | null>(null);
  const loadToken = useRef(0);

  // A project that went quiet (an older one, or one between phases) opens its replay on the
  // whole history rather than an empty last hour.
  const newest = items?.[0] ? Date.parse(items[0].ts) : null;
  const defaultPreset: ReplayPreset =
    newest !== null && Date.now() - newest < 3_600_000 ? 'hour' : 'start';
  const windowPreset = preset ?? defaultPreset;

  // The CMS station is named for the project's platform.
  const cmsLabel = mc?.project.platform?.name ?? 'CMS';

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

  // The scene's side follows its frame (it is a square).
  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e!.contentRect.width);
      sideRef.current = w;
      setSide(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The orbit: built from the roster; a new roster keeps what is in flight.
  const roster = team?.agents ?? null;
  const [orbitVersion, setOrbitVersion] = useState(0);
  useEffect(() => {
    if (!roster) return;
    orbitRef.current = orbitRef.current
      ? rebuildOrbit(orbitRef.current, roster, cmsLabel)
      : createOrbit(roster, cmsLabel);
    setOrbitVersion((n) => n + 1);
  }, [roster, cmsLabel]);
  const orbit = orbitRef.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const agents = useMemo(() => (orbit ? [...orbit.agents.values()] : []), [orbitVersion]);
  // Someone followed who left the roster is let go.
  useEffect(() => {
    if (follow && orbit && !orbit.agents.has(follow)) setFollow(null);
  }, [follow, orbit, orbitVersion]);

  // Live beats from new rows: on open, the last minute replays quickly; afterwards each new row.
  const seenSeq = useRef<number | null>(null);
  const pending = useRef<{ beat: Beat; item: ActivityItem | null }[]>([]);
  useEffect(() => {
    if (!items || !orbitRef.current) return;
    const oldestFirst = [...items].sort((a, b) => a.seq - b.seq);
    let fresh: ActivityItem[];
    if (seenSeq.current === null) {
      const since = Date.now() - CATCH_UP_MS;
      fresh = oldestFirst.filter((i) => Date.parse(i.ts) >= since);
      // Nothing recent: the caption still says what happened last.
      if (!fresh.length && oldestFirst.length) orbitRef.current.latest = oldestFirst.at(-1)!;
    } else {
      fresh = oldestFirst.filter((i) => i.seq > seenSeq.current!);
    }
    if (oldestFirst.length)
      seenSeq.current = Math.max(seenSeq.current ?? 0, oldestFirst.at(-1)!.seq);
    if (modeRef.current === 'live') pending.current.push(...beatsWithItems(fresh, lookup));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, lookup, orbitVersion]);

  // Live beats from plan changes: dispatches, handoffs, cards.
  const prevTasks = useRef<Map<string, TaskView> | null>(null);
  useEffect(() => {
    if (!plan) return;
    if (prevTasks.current && modeRef.current === 'live')
      for (const beat of beatsFromPlan(prevTasks.current, plan.tasks))
        pending.current.push({ beat, item: null });
    prevTasks.current = new Map(plan.tasks.map((t) => [t.taskId, t]));
  }, [plan]);

  // Who works and whether the project is held (live only; the replay derives its own).
  const syncTeam = useCallback(() => {
    const s = orbitRef.current;
    if (!s || !roster) return;
    s.working.clear();
    for (const t of plan?.tasks ?? []) if (RUNNING.has(t.state)) s.working.add(t.agentId);
    for (const a of roster) {
      const o = s.agents.get(a.agentId);
      if (o) o.state = a.state;
      if (a.state === 'active') s.working.add(a.agentId);
    }
    s.paused = mc?.project.status === 'paused' || (mc?.project.holds.length ?? 0) > 0;
  }, [roster, plan, mc]);
  useEffect(() => {
    if (mode === 'live') syncTeam();
  }, [mode, syncTeam, orbitVersion]);

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
          const s = orbitRef.current;
          if (s) resetOrbit(s);
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
    const s = orbitRef.current;
    if (s) {
      resetOrbit(s);
      pending.current = [];
    }
    syncTeam();
  }, [syncTeam]);

  const seek = useCallback((t: number) => {
    const r = replayRef.current;
    const s = orbitRef.current;
    if (!r || !s) return;
    seekTo(r, t);
    // Rebuild the floor as it stood at `t`: every beat before it, without the flying.
    resetOrbit(s);
    const now = performance.now();
    for (const { beat, item } of beatsWithItems(r.rows.slice(0, r.cursor), lookupRef.current))
      applyOrbitBeat(s, beat, now, { instant: true, item });
    setUiTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (replayRef.current) replayRef.current.speed = speed;
  }, [speed]);

  // How fast the rings turn: still when held or paused, slow when nothing is running.
  const resting = eye.state === 'resting';
  const rateRef = useRef(1);
  rateRef.current = still ? 0 : resting ? 0.3 : 1;
  // Pointing at someone holds the rings, so a moving target is easy to click.
  const holdRef = useRef(false);

  // The loop: release beats (live) or what the clock says (replay), turn the rings, paint.
  const cheerSeen = useRef(0);
  const beatsSeen = useRef(0);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let nextBeatAt = 0;
    let nextUiAt = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const s = orbitRef.current;
      if (!s) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const r = replayRef.current;
      let rate = s.paused || holdRef.current ? 0 : rateRef.current;
      if (modeRef.current === 'replay') {
        if (r) {
          if (!r.playing) rate = 0;
          for (const row of advance(r, dt * 1000, !s.comets.length, now))
            for (const { beat, item } of beatsWithItems([row], lookupRef.current))
              applyOrbitBeat(s, beat, now, { instant: still, item });
          if (now >= nextUiAt) {
            nextUiAt = now + 250;
            setUiTick((n) => n + 1);
          }
        } else rate = 0;
      } else if (pending.current.length && now >= nextBeatAt) {
        const { beat, item } = pending.current.shift()!;
        applyOrbitBeat(s, beat, now, { instant: still, item });
        nextBeatAt = now + (pending.current.length > 8 ? BEAT_GAP_MS / 3 : BEAT_GAP_MS);
      }
      advanceOrbit(s, dt, rate, now);
      paint(s, now);
      // A pass lands: Cypher squints, a ripple, a word on what passed.
      if (s.cheers !== cheerSeen.current && now >= s.cheerAt) {
        cheerSeen.current = s.cheers;
        setCheer(s.cheers);
        setPassText(s.latest?.summary ?? null);
      }
      if (s.beats !== beatsSeen.current && modeRef.current === 'live' && now >= nextUiAt) {
        beatsSeen.current = s.beats;
        nextUiAt = now + 400;
        setUiTick((n) => n + 1);
      }
    };
    const paint = (s: OrbitState, now: number) => {
      const S = sideRef.current;
      if (!S) return;
      for (const [id, el] of agentEls.current) {
        const p = agentAt(s, id);
        if (!p) continue;
        el.style.transform = `translate(${(p.x * S).toFixed(1)}px, ${(p.y * S).toFixed(1)}px)`;
        const working = s.working.has(id) ? '' : null;
        if (working === null) el.removeAttribute('data-working');
        else el.setAttribute('data-working', '');
        const f = s.flash.get(id);
        if (f) el.setAttribute('data-flash', f.tone);
        else el.removeAttribute('data-flash');
      }
      for (const [id, el] of stationEls.current) {
        const g = s.glow.get(id);
        // The glow starts when the comet arrives.
        if (g && now >= g.until - 900) {
          el.setAttribute('data-glow', '');
          el.style.setProperty('--g', toneColor(g.tone, g.ws));
        } else el.removeAttribute('data-glow');
      }
      for (let i = 0; i < POOL; i++) {
        const el = cometEls.current[i];
        if (!el) continue;
        const c = s.comets[i];
        if (!c) {
          el.style.opacity = '0';
          continue;
        }
        const { p, t } = cometAt(s, c, now);
        el.style.transform = `translate(${(p.x * S).toFixed(1)}px, ${(p.y * S).toFixed(1)}px)`;
        el.style.opacity = String(Math.min(1, Math.sin(Math.PI * Math.min(1, t * 1.05)) * 1.6));
        el.style.background = toneColor(c.tone, c.ws);
        el.dataset.shape = c.shape;
      }
      // Cypher's gaze: whoever is followed; else wherever something just landed.
      const fid = followRef.current;
      const fp = fid ? agentAt(s, fid) : null;
      if (fp) gaze.current = gazeTo(fp);
      else if (s.lastTarget && now - s.lastTarget.at < 1600 && now >= s.lastTarget.at - 700)
        gaze.current = gazeTo(endAt(s, s.lastTarget.end));
      else gaze.current = null;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [still]);

  // The word on a pass fades after a few seconds.
  useEffect(() => {
    if (!passText) return;
    const t = window.setTimeout(() => setPassText(null), 3200);
    return () => window.clearTimeout(t);
  }, [passText, cheer]);

  const replay = replayRef.current;
  const paused = Boolean(orbit?.paused);
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
        : paused
          ? 'Paused'
          : resting
            ? 'Quiet'
            : 'Live';

  const current = mc?.phases.find((p) => p.status === 'current') ?? null;
  const followed: AgentView | null =
    (follow && team?.agents.find((a) => a.agentId === follow)) || null;
  const followedRing = follow ? (orbit?.agents.get(follow)?.ring ?? null) : null;
  const latest = orbit?.latest ?? null;
  const theirs = follow ? (items ?? []).filter((i) => i.agentId === follow) : [];
  const nameOf = (id: string | null, actor?: string) => {
    if (!id)
      return actor === 'director' ? 'You' : actor === 'chief-of-staff' ? 'Cypher' : 'The system';
    const a = team?.agents.find((g) => g.agentId === id);
    return a?.tier === 'chief_of_staff' ? 'Cypher' : (a?.persona ?? a?.name ?? 'An agent');
  };
  const caption = followed
    ? {
        who: nameOf(followed.agentId),
        text: followed.now ?? theirs[0]?.summary ?? 'At their desk, waiting for the next task.',
      }
    : latest
      ? { who: nameOf(latest.agentId, latest.actorId), text: latest.summary }
      : null;

  const eyeSize = Math.max(44, Math.min(110, side * (variant === 'hero' ? 0.12 : 0.11)));
  const scale = Math.max(0.72, Math.min(1.25, side / 600));
  const stations = orbit?.stations ?? [];

  const scene = (
    <div
      className={fl.scene}
      ref={sceneRef}
      style={{ '--k': scale } as React.CSSProperties}
      role="group"
      aria-label="The Floor: the team on rings around Cypher, by team, with the systems they use on the outer ring"
    >
      <svg
        className={fl.spokes}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <circle
          cx="50"
          cy="50"
          r={STATION_R * 100}
          className={fl.stationRing}
          vectorEffect="non-scaling-stroke"
        />
        {stations.map((st) => {
          const a = (st.deg * Math.PI) / 180;
          return (
            <line
              key={st.id}
              x1="50"
              y1="50"
              x2={50 + STATION_R * 100 * Math.sin(a)}
              y2={50 - STATION_R * 100 * Math.cos(a)}
              className={fl.spoke}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {RINGS.map((ws) => {
        if (!agents.some((a) => a.ring === ws)) return null;
        const r = RING_R[ws];
        return (
          <div
            key={ws}
            className={fl.ring}
            data-on={followedRing === ws || undefined}
            style={
              {
                left: pct(0.5 - r),
                top: pct(0.5 - r),
                width: pct(2 * r),
                height: pct(2 * r),
                '--hue': HUE[ws],
              } as React.CSSProperties
            }
          >
            <span className={`${fl.ringTag} type-label`}>{RING_LABEL[ws]}</span>
          </div>
        );
      })}
      {stations.map((st) => {
        const a = (st.deg * Math.PI) / 180;
        return (
          <div
            key={st.id}
            className={fl.station}
            data-minor={
              st.id === 'door' || st.id === 'research' || st.id === 'browser' || undefined
            }
            ref={(el) => {
              if (el) stationEls.current.set(st.id, el);
              else stationEls.current.delete(st.id);
            }}
            style={{
              left: pct(0.5 + STATION_R * Math.sin(a)),
              top: pct(0.5 - STATION_R * Math.cos(a)),
            }}
          >
            <span className={fl.stationBox} data-door={st.id === 'door' || undefined} />
            <span className={`${fl.stationLabel} type-meta`}>{st.label}</span>
          </div>
        );
      })}
      <div className={fl.core}>
        <LiveEye state={eye.state} blink={eye.blink} size={eyeSize} gaze={gaze} cheer={cheer} />
        {cheer > 0 && <span key={cheer} className={fl.ripple} aria-hidden="true" />}
      </div>
      {passText && (
        <span key={`pass-${cheer}`} className={`${fl.pass} type-meta`} role="status">
          <Icon name="check" size={14} />
          <span>{passText}</span>
        </span>
      )}
      {Array.from({ length: POOL }, (_, i) => (
        <span
          key={i}
          className={fl.comet}
          aria-hidden="true"
          ref={(el) => {
            cometEls.current[i] = el;
          }}
        />
      ))}
      {agents.map((a) => {
        const isFollowed = a.id === follow;
        const lead = a.tier === 'lead';
        return (
          <div
            key={a.id}
            className={fl.agent}
            data-followed={isFollowed || undefined}
            data-lead={lead || undefined}
            data-state={a.state}
            ref={(el) => {
              if (el) agentEls.current.set(a.id, el);
              else agentEls.current.delete(a.id);
            }}
            style={{ '--hue': HUE[a.ring] } as React.CSSProperties}
          >
            {isFollowed && (
              <span className={fl.cam} aria-hidden="true">
                <i />
                <i />
                <i />
                <i />
              </span>
            )}
            <button
              type="button"
              className={fl.face}
              aria-pressed={isFollowed}
              aria-label={isFollowed ? `Following ${a.name}` : `Follow ${a.name}, ${a.role}`}
              title={`${a.name}, ${a.role}`}
              onClick={() => setFollow(isFollowed ? null : a.id)}
              onPointerEnter={() => (holdRef.current = true)}
              onPointerLeave={() => (holdRef.current = false)}
              onFocus={() => (holdRef.current = true)}
              onBlur={() => (holdRef.current = false)}
            >
              {a.initials}
            </button>
            {(lead || isFollowed) && <span className={`${fl.name} type-meta`}>{a.first}</span>}
          </div>
        );
      })}
      {team && !agents.length && (
        <div className={`${fl.empty} type-body-small`}>No one is on the team yet.</div>
      )}
      {!team && <div className={`${fl.empty} type-body-small`}>Loading the team…</div>}
    </div>
  );

  const followLine = followed && (
    <div className={fl.followLine}>
      <span
        className={fl.ringAvatar}
        style={{ '--hue': HUE[followedRing ?? 'none'] } as React.CSSProperties}
      >
        {orbit?.agents.get(followed.agentId)?.initials}
      </span>
      <span className={fl.followText}>
        <span className="type-body-small">
          <b>Following {orbit?.agents.get(followed.agentId)?.first}</b>
          {followed.now ? <span className={fl.quiet}> · {followed.now}</span> : null}
        </span>
        {followed.step && (
          <span className={fl.bar}>
            <span
              style={{
                width: `${Math.round((followed.step.n / Math.max(1, followed.step.of)) * 100)}%`,
                background: HUE[followedRing ?? 'none'],
              }}
            />
          </span>
        )}
      </span>
      <button type="button" className={`${fl.btn} type-button`} onClick={() => setFollow(null)}>
        Stop following
      </button>
    </div>
  );

  return (
    <div className={fl.floor} data-variant={variant}>
      <div className={fl.stage}>
        <div className={fl.head}>
          <span
            className={`${fl.state} type-meta`}
            data-live={mode === 'live' && !paused && !resting && Boolean(team)}
            data-replay={mode === 'replay'}
          >
            <i />
            {pill}
          </span>
          {current && variant !== 'bliss' && (
            <span className={`${fl.chip} type-meta`}>
              Phase {current.number} · {current.shortName || current.name}
            </span>
          )}
          {followed && variant !== 'bliss' && (
            <span className={`${fl.followChip} type-meta`}>
              <span
                className={fl.dotAvatar}
                style={{ background: HUE[followedRing ?? 'none'] }}
                aria-hidden="true"
              >
                {orbit?.agents.get(followed.agentId)?.initials}
              </span>
              Following {orbit?.agents.get(followed.agentId)?.first}
              <button
                type="button"
                className={fl.x}
                aria-label="Stop following"
                onClick={() => setFollow(null)}
              >
                <Icon name="close" size={14} />
              </button>
            </span>
          )}
          {!followed && agents.length > 0 && (
            <span className={`${fl.hint} type-meta`}>Click anyone to follow them</span>
          )}
        </div>
        {scene}
        {caption && (
          <div className={fl.caption} aria-live="polite">
            <span className={`${fl.captionWho} type-label`}>{caption.who}</span>
            <span className={fl.captionText}>{caption.text}</span>
          </div>
        )}
        {variant === 'bliss' && followLine}
      </div>

      {variant === 'everything' && (
        <aside className={fl.side}>
          {mc?.voice && (
            <p className={`${fl.voice} type-body`}>
              <Said text={mc.voice.text} emphasis={mc.voice.emphasis} />
            </p>
          )}
          {followed ? (
            <section
              className={fl.card}
              data-follow
              aria-label={`Following ${followed.persona ?? followed.name}`}
            >
              <span className={`${fl.label} type-label`}>Following</span>
              <div className={fl.who}>
                <span
                  className={fl.ringAvatar}
                  style={{ '--hue': HUE[followedRing ?? 'none'] } as React.CSSProperties}
                >
                  {orbit?.agents.get(followed.agentId)?.initials}
                </span>
                <span className={fl.whoText}>
                  <b className="type-body-small">{followed.persona ?? followed.name}</b>
                  <span className={`${fl.quiet} type-meta`}>{followed.name}</span>
                </span>
              </div>
              {followed.now && <b className="type-body-small">{followed.now}</b>}
              {followed.step && (
                <>
                  <span className={`${fl.quiet} type-meta`}>
                    Step {followed.step.n} of {followed.step.of}
                  </span>
                  <span className={fl.bar}>
                    <span
                      style={{
                        width: `${Math.round((followed.step.n / Math.max(1, followed.step.of)) * 100)}%`,
                        background: HUE[followedRing ?? 'none'],
                      }}
                    />
                  </span>
                </>
              )}
              {theirs.slice(0, 3).map((i) => (
                <div key={i.seq} className={`${fl.step} type-meta`}>
                  <span>{i.toolLabel ?? i.summary}</span>
                  <span data-sev={i.severity}>{i.outcome ?? stamp(i.ts, tz)}</span>
                </div>
              ))}
              {!theirs.length && !followed.now && (
                <span className={`${fl.quiet} type-meta`}>
                  Nothing from them in the recent log.
                </span>
              )}
              {followed.next && (
                <span className={`${fl.quiet} type-meta`}>
                  Next: {followed.next.title}, {followed.next.when}
                </span>
              )}
              <div className={fl.actions}>
                <button
                  type="button"
                  className={`${fl.btn} type-button`}
                  onClick={() => inspect('agent', followed.agentId)}
                >
                  Details
                </button>
                <button
                  type="button"
                  className={`${fl.btn} type-button`}
                  onClick={() => setFollow(null)}
                >
                  Stop following
                </button>
              </div>
            </section>
          ) : (
            <section className={fl.card}>
              <span className={`${fl.label} type-label`}>Follow someone</span>
              <span className="type-body-small">
                Pick anyone on the floor. The camera stays on them and Cypher keeps an eye on what
                they do.
              </span>
            </section>
          )}
          {mc && (
            <div className={fl.kpis}>
              <div className={fl.kpi}>
                <span className={`${fl.label} type-label`}>Running</span>
                <b className="type-number">{mc.phases.reduce((n, p) => n + p.tasksRunning, 0)}</b>
                <span className="type-meta">tasks right now</span>
              </div>
              <div className={fl.kpi}>
                <span className={`${fl.label} type-label`}>
                  {current ? `Phase ${current.number}` : 'Phases'}
                </span>
                <b className="type-number">
                  {current
                    ? `${Math.round((current.tasksDone / Math.max(1, current.tasksTotal)) * 100)}%`
                    : mc.project.status === 'completed'
                      ? 'Done'
                      : '–'}
                </b>
                <span className="type-meta">
                  {current
                    ? `${current.tasksDone} of ${current.tasksTotal} tasks`
                    : 'No phase running'}
                </span>
              </div>
            </div>
          )}
          {items && items.length > 0 && (
            <section className={fl.signal} aria-label="Just now">
              <span className={`${fl.label} type-label`}>Just now</span>
              {items.slice(0, 4).map((i) => (
                <div key={i.seq} className={fl.sig}>
                  <i data-sev={i.severity} aria-hidden="true" />
                  <span className="type-body-small">
                    <span className={fl.clamp}>{i.summary}</span>
                    <small className="type-meta">
                      {nameOf(i.agentId, i.actorId)} · {stamp(i.ts, tz)}
                    </small>
                  </span>
                </div>
              ))}
            </section>
          )}
        </aside>
      )}

      <ReplayBar
        mode={mode}
        onLive={goLive}
        onReplay={() => startReplay(windowPreset)}
        preset={windowPreset}
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
        phase={orbit?.phase ?? null}
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
    <div className={fl.replay} data-mode={mode}>
      <div className={`${fl.seg} type-meta`} role="group" aria-label="Floor time">
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
            className={`${fl.window} type-meta`}
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
            type="button"
            className={fl.play}
            aria-label={replay?.playing ? 'Pause' : 'Play'}
            disabled={!replay || loading !== null}
            onClick={onToggle}
          >
            {replay?.playing ? <PauseGlyph /> : <PlayGlyph />}
          </button>
          <div className={`${fl.seg} type-meta`} role="group" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} aria-pressed={speed === s} onClick={() => onSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
          <div className={fl.track}>
            {loading !== null ? (
              <div className={`${fl.loading} type-meta`}>
                Loading history… {loading.toLocaleString('en-US')} rows
              </div>
            ) : replay && !replay.rows.length ? (
              <div className={`${fl.loading} type-meta`}>Nothing happened in this window.</div>
            ) : (
              <canvas
                ref={stripRef}
                className={fl.strip}
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
          <div className={`${fl.clock} type-meta`}>
            {replay && loading === null ? (
              <>
                <span className={fl.time}>{projectClock(replay.vt, tz)}</span>
                <span className={fl.sub}>
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
        <span className={`${fl.hint} type-meta`}>
          <Icon name="clock" size={18} /> Replay a window of the project's history at 10× or 60×
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

/** A colour's `rgba(r, g, b, ` prefix, parsed once per colour (the scene draws every frame). */
const rgbaPrefix = new Map<string, string | null>();

function alpha(hex: string, a: number): string {
  let prefix = rgbaPrefix.get(hex);
  if (prefix === undefined) {
    prefix = rgbaOf(hex);
    rgbaPrefix.set(hex, prefix);
  }
  return prefix === null ? hex : `${prefix}${a})`;
}

function rgbaOf(hex: string): string | null {
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
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, `;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(hex);
  if (rgb) {
    const parts = rgb[1]!
      .split(',')
      .slice(0, 3)
      .map((s) => s.trim());
    return `rgba(${parts.join(', ')}, `;
  }
  return null;
}
