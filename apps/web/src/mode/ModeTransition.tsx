/*
 * The scene between Bliss and Everything. The screen blurs and the eye comes up in the middle:
 * going to Everything it wakes (the lids flutter, open, and widen as the pupil dilates); going to
 * Bliss it settles (wide, then easing, drowsy, and closing to its resting lid). The mode changes
 * behind the blur, then the blur lifts. About a second; nothing to click while it plays.
 */
import { useEffect, useRef, useState } from 'react';
import { ease, POSE } from '../ui/eye/geometry';
import { EyeMotion, type Step } from '../ui/eye/motion';
import { useEyeState } from '../voice/eye';
import type { ModeName } from './mode';
import { hostModeTransitions, type ModeChange } from './transition';
import s from './ModeTransition.module.css';

const APPLY_AT = 260;
const OUT_MS = 320;

const WAKE: Step[] = [
  { to: { open: 0 }, ms: 120, hold: 40 },
  { to: { open: 0.38 }, ms: 150, ease: ease.out },
  { to: { open: 0.12 }, ms: 90, ease: ease.in },
  { to: { open: 1, dilate: 0 }, ms: 230, ease: ease.spring },
  { to: { open: 1.32, dilate: 1.4 }, ms: 210, ease: ease.spring, hold: 170 },
];

const SETTLE: Step[] = [
  { to: { open: 1.32, dilate: 1.4 }, ms: 120, hold: 60 },
  { to: { open: 1, dilate: 0 }, ms: 260, ease: ease.out },
  { to: { open: 0.42 }, ms: 300, ease: ease.inOut },
  { to: { open: 0.56 }, ms: 160, ease: ease.inOut },
  { to: { open: 0 }, ms: 380, ease: ease.inOut, hold: 130 },
];

type Phase = 'in' | 'out';

export function ModeTransition() {
  const [scene, setScene] = useState<{ to: ModeName; phase: Phase; key: number } | null>(null);
  const running = useRef(false);
  const lids = useRef<SVGPathElement>(null);
  const pupil = useRef<SVGCircleElement>(null);
  const motion = useRef(new EyeMotion(POSE.resting));
  const pending = useRef<ModeChange | null>(null);
  const eye = useEyeState();

  useEffect(
    () =>
      hostModeTransitions((c) => {
        if (running.current) return false;
        running.current = true;
        pending.current = c;
        setScene({ to: c.to, phase: 'in', key: Date.now() });
        return true;
      }),
    [],
  );

  // Once the scene is on screen: play the eye, change the mode under the blur, then lift it.
  useEffect(() => {
    if (!scene || scene.phase !== 'in') return;
    const m = motion.current;
    m.attach(lids.current && pupil.current ? { lids: lids.current, pupil: pupil.current } : null);
    m.set(scene.to === 'everything' ? POSE.resting : POSE.wide);
    const apply = window.setTimeout(() => {
      pending.current?.apply();
      pending.current = null;
    }, APPLY_AT);
    let done = 0;
    void m.play(scene.to === 'everything' ? WAKE : SETTLE).then(() => {
      setScene((cur) => (cur ? { ...cur, phase: 'out' } : cur));
      done = window.setTimeout(() => {
        running.current = false;
        setScene(null);
      }, OUT_MS);
    });
    return () => {
      window.clearTimeout(apply);
      window.clearTimeout(done);
    };
    // Only when a new scene starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene?.key]);

  // A scene that is cut short (unmount) still changes the mode.
  useEffect(
    () => () => {
      pending.current?.apply();
      motion.current.cancel();
    },
    [],
  );

  if (!scene) return null;
  return (
    <div
      className={s.scene}
      data-phase={scene.phase}
      data-to={scene.to}
      data-state={eye.state}
      aria-hidden="true"
    >
      <div className={s.center}>
        <span className={s.halo} />
        <svg className={s.mark} viewBox="0 0 72 72" focusable="false">
          <circle className={s.ball} cx="36" cy="36" r="31" />
          <path ref={lids} className={s.lids} strokeLinecap="round" strokeLinejoin="round" />
          <circle ref={pupil} className={s.pupil} cx="36" cy="36" r="0" />
        </svg>
        <span className={`${s.word} type-label`}>
          {scene.to === 'everything' ? 'Everything' : 'Bliss'}
        </span>
      </div>
    </div>
  );
}
