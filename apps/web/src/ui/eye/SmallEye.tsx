/*
 * The eye at the sizes the shell uses it (the logo, the rail, the Cypher button), alive but
 * quiet: it blinks and glances at unscheduled moments, a coral ring breathes behind it when
 * something is the Director's, and it perks up toward the pointer when the pointer comes near or
 * its control is hovered. The button's eye does more: it turns to the open sheet, and looks about
 * while Cypher is thinking. Drawn from the marks' own geometry (ui/eye/geometry.ts), with a small
 * catch-light so it reads as an eye at 30-odd pixels. Still under reduced motion.
 */
import { useEffect, useRef } from 'react';
import type { MarkTone } from '../../theme/marks';
import type { EyeState } from '../../voice/eye';
import { ease, lookRange, prefersReducedMotion, type EyePose } from './geometry';
import { between, EyeMotion } from './motion';
import s from './SmallEye.module.css';

const BASE: Record<EyeState, EyePose> = {
  resting: { open: 0, lookX: 0, lookY: 0, dilate: 0 },
  watching: { open: 1, lookX: 0, lookY: 0, dilate: 0 },
  'needs-a-word': { open: 1.06, lookX: 0, lookY: 0, dilate: 1.2 },
};

export interface SmallEyeProps {
  state: EyeState;
  size: number;
  tone?: MarkTone;
  /** A new item arrived: blink twice. */
  blink?: boolean;
  /** How lively: the logo stays quiet, the button reacts more. */
  lively?: boolean;
  /** Its control is hovered or focused: the eye opens a little and looks out. */
  perk?: boolean;
  /** The sheet it opens is open: the eye turns up toward it. */
  attending?: boolean;
  /** Cypher is composing a reply: the eye looks about. */
  thinking?: boolean;
}

export function SmallEye({
  state,
  size,
  tone = 'light',
  blink = false,
  lively = false,
  perk = false,
  attending = false,
  thinking = false,
}: SmallEyeProps) {
  const box = useRef<HTMLSpanElement>(null);
  const lids = useRef<SVGPathElement>(null);
  const pupil = useRef<SVGCircleElement>(null);
  const glint = useRef<SVGCircleElement>(null);
  const motion = useRef<EyeMotion | null>(null);
  if (!motion.current) motion.current = new EyeMotion(BASE[state]);
  // The pose it rests in now, from its state and what's going on around it.
  const awake = state === 'resting' && (perk || attending || thinking) ? 'watching' : state;
  const rest: EyePose = {
    ...BASE[awake],
    open: BASE[awake].open + (perk ? 0.14 : 0),
    lookX: attending ? -lookRange(1) * 0.55 : 0,
    lookY: attending ? -lookRange(1) * 0.55 : 0,
  };
  const restRef = useRef(rest);
  restRef.current = rest;

  useEffect(() => {
    const m = motion.current!;
    m.attach(
      lids.current && pupil.current
        ? { lids: lids.current, pupil: pupil.current, glint: glint.current }
        : null,
    );
    return () => {
      m.cancel();
      m.attach(null);
    };
  }, []);

  // Into the pose, then its idle life.
  const key = `${awake}|${perk}|${attending}|${thinking}`;
  useEffect(() => {
    const m = motion.current!;
    const pose = restRef.current;
    if (prefersReducedMotion()) {
      m.set(pose);
      return;
    }
    let alive = true;
    let timer = 0;
    const act = async () => {
      if (!alive) return;
      const p = restRef.current;
      if (thinking) {
        const r = lookRange(p.open);
        await m.play([
          {
            to: { lookX: between(-r, r), lookY: between(-r * 0.6, 0) },
            ms: 220,
            ease: ease.out,
            hold: between(250, 600),
          },
        ]);
      } else if (p.open === 0) {
        await m.play([
          { to: { open: 0.16 }, ms: 700, ease: ease.inOut, hold: 200 },
          { to: { open: 0 }, ms: 900, ease: ease.inOut },
        ]);
      } else if (lively && !attending && Math.random() < 0.5) {
        const r = lookRange(p.open) * 0.8;
        await m.play([
          {
            to: { lookX: between(-r, r), lookY: between(-r / 2, r / 2) },
            ms: 220,
            ease: ease.out,
            hold: between(500, 1200),
          },
          { to: { lookX: p.lookX, lookY: p.lookY }, ms: 260, ease: ease.inOut },
        ]);
      } else {
        await m.play([
          { to: { open: 0 }, ms: 85, ease: ease.in },
          { to: { open: p.open }, ms: 160, ease: ease.out },
        ]);
      }
      schedule();
    };
    const schedule = () => {
      if (!alive) return;
      const wait = thinking
        ? between(500, 1100)
        : restRef.current.open === 0
          ? between(8000, 14000)
          : lively
            ? between(2200, 5000)
            : between(5000, 9500);
      timer = window.setTimeout(() => void act(), wait);
    };
    void m.play([{ to: pose, ms: 420, ease: ease.spring }]).then((ok) => ok && schedule());
    return () => {
      alive = false;
      window.clearTimeout(timer);
      m.cancel();
    };
    // restRef carries the pose; the key says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, lively]);

  // Awake and lively: the pupil follows the pointer while it is near.
  useEffect(() => {
    if (!lively || awake === 'resting' || attending || thinking || prefersReducedMotion()) return;
    let last = 0;
    let away = 0;
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - last < 80 || !box.current) return;
      last = now;
      const b = box.current.getBoundingClientRect();
      const dx = e.clientX - (b.left + b.width / 2);
      const dy = e.clientY - (b.top + b.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const m = motion.current!;
      if (d > 420) {
        window.clearTimeout(away);
        away = window.setTimeout(
          () => void m.play([{ to: { lookX: 0, lookY: 0 }, ms: 300, ease: ease.inOut }]),
          400,
        );
        return;
      }
      const r = lookRange(restRef.current.open) * Math.min(1, d / 160);
      void m.play([
        { to: { lookX: (dx / d) * r, lookY: (dy / d) * r * 0.7 }, ms: 140, ease: ease.out },
      ]);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.clearTimeout(away);
    };
  }, [lively, awake, attending, thinking]);

  // A new item: two quick blinks.
  useEffect(() => {
    if (!blink || prefersReducedMotion()) return;
    const open = restRef.current.open;
    void motion.current!.play([
      { to: { open: 0 }, ms: 75, ease: ease.in },
      { to: { open }, ms: 110, ease: ease.out, hold: 80 },
      { to: { open: 0 }, ms: 75, ease: ease.in },
      { to: { open }, ms: 170, ease: ease.spring },
    ]);
  }, [blink]);

  return (
    <span
      ref={box}
      className={s.eye}
      data-state={state}
      data-tone={tone}
      data-lively={lively || undefined}
      style={{ '--size': `${size}px` } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className={s.ring} />
      <svg className={s.mark} viewBox="0 0 72 72" focusable="false">
        <circle className={s.ball} cx="36" cy="36" r="31" />
        <path ref={lids} className={s.lids} strokeLinecap="round" strokeLinejoin="round" />
        <circle ref={pupil} className={s.pupil} cx="36" cy="36" r="0" />
        <circle ref={glint} className={s.glint} cx="36" cy="36" r="0" />
      </svg>
    </span>
  );
}
