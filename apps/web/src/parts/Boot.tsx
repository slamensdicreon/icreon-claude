import { useEffect, useRef, useState } from 'react';
import { live } from '../lib/live';
import { useApp, useMission, useNow } from '../state';
import { Button } from '../ui/cypher/parts';
import { ease, lookRange, prefersReducedMotion } from '../ui/eye/geometry';
import { EyeMotion } from '../ui/eye/motion';
import b from './boot.module.css';

/**
 * The first load. The Control API runs on paused, short-lived instances, so the first answer can
 * take seconds: instead of an empty shell with "Loading…" lines, the shell renders blurred under
 * a full-screen overlay with the mark, what is being waited for, and a plain error with a retry
 * when the API doesn't answer. It shows once per page load; switching projects later uses the
 * surfaces' own loading lines.
 */

type Phase = 'api' | 'project' | 'error' | 'done';
type Step = { label: string; state: 'done' | 'active' | 'todo' };

export interface BootState {
  visible: boolean;
  leaving: boolean;
  phase: Phase;
  message: string;
  detail: string | null;
  steps: Step[];
  retry: () => void;
  home: () => void;
}

/** Long enough for the eye to wake on a fast load; the leave lets it open wide and dissolve. */
const MIN_SHOWN_MS = 1100;
const LEAVE_MS = 560;

export function useBootState(): BootState {
  const { boot, projectId, projects, home } = useApp();
  const mission = useMission();
  // The project in the address when the page opened: its first snapshot is part of the boot.
  const initial = useRef(projectId);
  const needProject = initial.current !== null && projectId === initial.current;
  const projectReady = !needProject || mission.data !== undefined;
  const projectError = needProject && mission.data === undefined ? mission.error : null;

  const phase: Phase = !boot.projectsLoaded
    ? boot.error
      ? 'error'
      : 'api'
    : projectError
      ? 'error'
      : !projectReady
        ? 'project'
        : 'done';

  // Stay at least a moment (no flash), fade out, then leave for good.
  const [stage, setStage] = useState<'showing' | 'leaving' | 'gone'>('showing');
  const shownAt = useRef(Date.now());
  // Once the overlay has gone, nothing here needs the time: stop re-rendering every second.
  const now = useNow(stage === 'gone' ? null : 1000);
  const waited = (now - shownAt.current) / 1000;
  useEffect(() => {
    if (stage !== 'showing' || phase !== 'done') return;
    const t = window.setTimeout(
      () => setStage('leaving'),
      Math.max(0, MIN_SHOWN_MS - (Date.now() - shownAt.current)),
    );
    return () => window.clearTimeout(t);
  }, [phase, stage]);
  useEffect(() => {
    if (stage !== 'leaving') return;
    const t = window.setTimeout(() => setStage('gone'), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [stage]);

  const name = projects.find((p) => p.id === projectId)?.name ?? null;
  let message: string;
  let detail: string | null = null;
  if (phase === 'error') {
    message = boot.error ?? projectError?.message ?? 'The Control API could not be reached.';
    detail = boot.error ? 'Retrying every few seconds.' : null;
  } else if (phase === 'api') {
    message =
      waited < 4
        ? 'Waking the Control API…'
        : waited < 12
          ? 'Still waking the Control API. A cold start can take a few seconds.'
          : 'This is taking longer than usual. Retrying every few seconds…';
  } else if (phase === 'project') {
    message = `Opening ${name ?? 'your project'}…`;
  } else {
    message = 'Ready';
  }

  const steps: Step[] = [
    { label: 'Control API', state: boot.projectsLoaded ? 'done' : 'active' },
    ...(needProject
      ? [
          {
            label: 'Project',
            state: (!boot.projectsLoaded
              ? 'todo'
              : projectReady
                ? 'done'
                : 'active') as Step['state'],
          },
        ]
      : []),
  ];

  return {
    visible: stage !== 'gone',
    leaving: stage === 'leaving',
    phase,
    message,
    detail,
    steps,
    retry: () => {
      if (!boot.projectsLoaded) boot.retry();
      else if (projectId) live.refresh(projectId);
    },
    home,
  };
}

export function Boot({ state }: { state: BootState }) {
  const { leaving, phase, message, detail, steps, retry, home } = state;
  const done = steps.filter((x) => x.state === 'done').length;
  const progress = phase === 'done' || leaving ? 1 : steps.length ? done / steps.length : 0;
  return (
    <div
      className={b.boot}
      role="status"
      aria-live="polite"
      data-phase={phase}
      data-leaving={leaving || undefined}
    >
      <div className={b.card}>
        <BootEye phase={phase} progress={progress} leaving={leaving} />
        <p className={`${b.title} type-heading`}>Cypher</p>
        <p className={`${b.line} type-body`}>{message}</p>
        {detail && <p className={`${b.detail} type-meta`}>{detail}</p>}
        <div className={b.steps} aria-hidden="true">
          {steps.map((s) => (
            <span key={s.label} className={b.step} data-state={s.state} title={s.label} />
          ))}
        </div>
        {phase === 'error' && (
          <div className={b.actions}>
            <Button kind="primary" onClick={retry}>
              Try again
            </Button>
            {steps.length > 1 && (
              <Button kind="secondary" onClick={home}>
                Dashboard
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const RING = 2 * Math.PI * 56;

/**
 * The eye waking while the app loads: closed and breathing at first, the lids lifting as each step
 * lands, the pupil reading side to side while it waits; wide and blinking when ready; coral and
 * concerned, looking straight out, when something failed. The ring around it is the progress.
 */
function BootEye({
  phase,
  progress,
  leaving,
}: {
  phase: string;
  progress: number;
  leaving: boolean;
}) {
  const lids = useRef<SVGPathElement>(null);
  const pupil = useRef<SVGCircleElement>(null);
  const motion = useRef<EyeMotion | null>(null);
  if (!motion.current) motion.current = new EyeMotion({ open: 0, lookX: 0, lookY: 0, dilate: 0 });

  useEffect(() => {
    const m = motion.current!;
    m.attach(lids.current && pupil.current ? { lids: lids.current, pupil: pupil.current } : null);
    return () => {
      m.cancel();
      m.attach(null);
    };
  }, []);

  useEffect(() => {
    const m = motion.current!;
    const still = prefersReducedMotion();
    if (leaving || phase === 'done') {
      const wide = { open: 1.3, lookX: 0, lookY: 0, dilate: 1.4 };
      if (still) return m.set(wide);
      void m.play([
        { to: { open: 1, lookX: 0 }, ms: 160, ease: ease.out },
        { to: { open: 0 }, ms: 80, ease: ease.in },
        { to: wide, ms: 260, ease: ease.spring },
      ]);
      return;
    }
    if (phase === 'error') {
      const concerned = { open: 0.72, lookX: 0, lookY: 0, dilate: 2 };
      if (still) return m.set(concerned);
      void m.play([{ to: concerned, ms: 380, ease: ease.out }]);
      return;
    }
    // Waiting: the lids lift with progress, then the pupil reads side to side, with a blink now and then.
    const open = 0.32 + 0.6 * progress;
    if (still) return m.set({ open, lookX: 0, lookY: 0, dilate: 0 });
    let alive = true;
    const range = lookRange(open) * 0.8;
    const loop = async () => {
      await m.play([{ to: { open, lookY: 0 }, ms: 520, ease: ease.spring }]);
      let side = 1;
      while (alive) {
        const ok = await m.play([
          { to: { lookX: range * side }, ms: 700, ease: ease.inOut, hold: 120 },
        ]);
        if (!ok || !alive) return;
        side = -side;
        if (Math.random() < 0.25) {
          await m.play([
            { to: { open: 0 }, ms: 90, ease: ease.in },
            { to: { open }, ms: 150, ease: ease.out },
          ]);
        }
      }
    };
    void loop();
    return () => {
      alive = false;
    };
  }, [phase, progress, leaving]);

  return (
    <div className={b.mark} aria-hidden="true">
      <span className={b.halo} />
      <svg className={b.ring} viewBox="0 0 120 120">
        <circle className={b.track} cx="60" cy="60" r="56" />
        <circle
          className={b.arc}
          cx="60"
          cy="60"
          r="56"
          style={{ strokeDasharray: RING, strokeDashoffset: RING * (1 - Math.max(0.06, progress)) }}
        />
      </svg>
      <svg className={b.eye} viewBox="0 0 72 72" focusable="false">
        <circle className={b.ball} cx="36" cy="36" r="31" />
        <path ref={lids} className={b.lids} strokeLinecap="round" strokeLinejoin="round" />
        <circle ref={pupil} className={b.pupil} cx="36" cy="36" r="0" />
      </svg>
    </div>
  );
}
