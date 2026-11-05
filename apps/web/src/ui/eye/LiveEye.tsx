/*
 * The hero's eye, alive: Cypher's presence on a Bliss page, moving by what is going on.
 * - resting: the lids closed, breathing slowly; now and then they stir.
 * - watching: open, glancing about and blinking; it follows the pointer.
 * - needs a word: coral and a little wide, looking at the Director, with a pulse whose tempo is
 *   how soon the first clock runs out ("now" under fifteen minutes, "soon" with any clock, "calm"
 *   with none).
 * A new item makes it blink twice. Under reduced motion it holds still in its state's pose.
 */
import { useEffect, useRef } from 'react';
import { EYE_WORDS, type EyeState } from '../../voice/eye';
import { ease, lookRange, prefersReducedMotion, type EyePose } from './geometry';
import { between, EyeMotion } from './motion';
import s from './LiveEye.module.css';

export type Urgency = 'now' | 'soon' | 'calm';

const POSES: Record<EyeState, EyePose> = {
  resting: { open: 0, lookX: 0, lookY: 0, dilate: 0 },
  watching: { open: 1, lookX: 0, lookY: 0, dilate: 0 },
  'needs-a-word': { open: 1.08, lookX: 0, lookY: 0, dilate: 2 },
};

export function LiveEye({
  state,
  blink = false,
  size = 130,
  urgency = 'calm',
}: {
  state: EyeState;
  blink?: boolean;
  size?: number;
  urgency?: Urgency;
}) {
  const box = useRef<HTMLSpanElement>(null);
  const lids = useRef<SVGPathElement>(null);
  const pupil = useRef<SVGCircleElement>(null);
  const motion = useRef<EyeMotion | null>(null);
  if (!motion.current) motion.current = new EyeMotion(POSES[state]);

  useEffect(() => {
    const m = motion.current!;
    m.attach(lids.current && pupil.current ? { lids: lids.current, pupil: pupil.current } : null);
    return () => {
      m.cancel();
      m.attach(null);
    };
  }, []);

  // The state's pose, then its idle life: stirs, blinks and glances at unscheduled moments.
  useEffect(() => {
    const m = motion.current!;
    const pose = POSES[state];
    if (prefersReducedMotion()) {
      m.set(pose);
      return;
    }
    let alive = true;
    let timer = 0;
    const blinkOnce = () =>
      m.play([
        { to: { open: 0 }, ms: 90, ease: ease.in },
        { to: { open: pose.open }, ms: 170, ease: ease.out },
      ]);
    const doubleBlink = () =>
      m.play([
        { to: { open: 0 }, ms: 80, ease: ease.in },
        { to: { open: pose.open }, ms: 120, ease: ease.out, hold: 110 },
        { to: { open: 0 }, ms: 80, ease: ease.in },
        { to: { open: pose.open }, ms: 170, ease: ease.out },
      ]);
    const glance = (x: number, y: number, hold: number) =>
      m.play([
        { to: { lookX: x, lookY: y }, ms: 210, ease: ease.out, hold },
        { to: { lookX: 0, lookY: 0 }, ms: 260, ease: ease.inOut },
      ]);
    const r = lookRange(pose.open);
    const act = async () => {
      if (!alive) return;
      const roll = Math.random();
      if (state === 'resting') {
        if (roll < 0.35) {
          // A peek: the lids half-lift, it looks one way and the other, and settles again.
          await m.play([
            { to: { open: 0.5 }, ms: 520, ease: ease.out, hold: 160 },
            { to: { lookX: -3 }, ms: 320, ease: ease.inOut, hold: 260 },
            { to: { lookX: 3 }, ms: 420, ease: ease.inOut, hold: 260 },
            { to: { lookX: 0, open: 0 }, ms: 900, ease: ease.inOut },
          ]);
        } else {
          await m.play([
            { to: { open: 0.18 }, ms: 800, ease: ease.inOut, hold: 300 },
            { to: { open: 0 }, ms: 1100, ease: ease.inOut },
          ]);
        }
      } else if (state === 'watching') {
        if (roll < 0.5) await glance(between(-r, r), between(-r / 2, r / 2), between(500, 1300));
        else if (roll < 0.85) await blinkOnce();
        else await doubleBlink();
      } else {
        // Needs a word: it keeps looking at the Director, glancing at the cards and back.
        if (roll < 0.4) await blinkOnce();
        else if (roll < 0.6) await doubleBlink();
        else if (roll < 0.85) await glance(between(-r * 0.7, r * 0.7), r * 0.6, between(400, 900));
        else await glance(between(-1.2, 1.2), between(-1, 1), 160);
      }
      schedule();
    };
    const schedule = () => {
      if (!alive) return;
      const wait =
        state === 'resting'
          ? between(4000, 8000)
          : state === 'watching'
            ? between(1200, 3000)
            : between(1800, 4000);
      timer = window.setTimeout(() => void act(), wait);
    };
    void m.play([{ to: pose, ms: 560, ease: ease.spring }]).then((done) => done && schedule());
    return () => {
      alive = false;
      window.clearTimeout(timer);
      m.cancel();
    };
  }, [state]);

  // Awake, it follows the pointer, a few units at most.
  useEffect(() => {
    if (state === 'resting' || prefersReducedMotion()) return;
    let last = 0;
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (now - last < 90 || !box.current) return;
      last = now;
      const b = box.current.getBoundingClientRect();
      const dx = e.clientX - (b.left + b.width / 2);
      const dy = e.clientY - (b.top + b.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const r = lookRange(POSES[state].open) * Math.min(1, d / 600);
      void motion.current!.play([
        { to: { lookX: (dx / d) * r, lookY: (dy / d) * r * 0.6 }, ms: 160, ease: ease.out },
      ]);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [state]);

  // Something new is the Director's: two quick blinks.
  useEffect(() => {
    if (!blink || prefersReducedMotion()) return;
    const open = POSES[state].open;
    void motion.current!.play([
      { to: { open: 0 }, ms: 80, ease: ease.in },
      { to: { open }, ms: 120, ease: ease.out, hold: 90 },
      { to: { open: 0 }, ms: 80, ease: ease.in },
      { to: { open }, ms: 180, ease: ease.spring },
    ]);
  }, [blink, state]);

  return (
    <span
      ref={box}
      className={s.live}
      data-state={state}
      data-urgency={state === 'needs-a-word' ? urgency : undefined}
      style={{ '--eye': `${size}px` } as React.CSSProperties}
      role="img"
      aria-label={`Cypher: ${EYE_WORDS[state]}`}
    >
      <span className={s.ring} aria-hidden="true" />
      <span className={`${s.ring} ${s.ringLate}`} aria-hidden="true" />
      <span className={s.halo} aria-hidden="true" />
      <span className={s.disc} aria-hidden="true" />
      <svg className={s.mark} viewBox="0 0 72 72" aria-hidden="true" focusable="false">
        <circle className={s.ball} cx="36" cy="36" r="31" />
        <path ref={lids} className={s.lids} strokeLinecap="round" strokeLinejoin="round" />
        <circle ref={pupil} className={s.pupil} cx="36" cy="36" r="0" />
      </svg>
    </span>
  );
}
