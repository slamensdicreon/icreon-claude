/*
 * The eye as one shape with an openness, so it can move between its marks instead of swapping
 * them. At openness 0 the lids meet on the resting mark's curve (theme/marks/eye-resting.svg:
 * M20 36 Q36 50 52 36); at 1 they are the watching mark's almond (M18 36 Q36 20 54 36 Q36 52 18 36
 * Z) with its 5-unit pupil; past 1 the eye is wide, the upper lid lifting further and the pupil
 * dilating toward the needs-a-word mark's 7. Nothing here draws a shape the marks don't have.
 */

export interface EyePose {
  /** 0 closed (resting), 1 open (watching), up to ~1.35 wide. */
  open: number;
  /** Pupil offset from centre, in mark units (the mark is 72 wide). */
  lookX: number;
  lookY: number;
  /** Extra pupil dilation on top of what openness gives, in mark units. */
  dilate: number;
}

export const POSE: Record<'resting' | 'watching' | 'wide', EyePose> = {
  resting: { open: 0, lookX: 0, lookY: 0, dilate: 0 },
  watching: { open: 1, lookX: 0, lookY: 0, dilate: 0 },
  wide: { open: 1.32, lookX: 0, lookY: 0, dilate: 1.2 },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The lids' path for an openness. */
export function lidPath(open: number): string {
  const o = Math.max(0, open);
  const base = clamp01(o);
  const extra = Math.max(0, o - 1);
  const x1 = lerp(20, 18, base);
  const x2 = lerp(52, 54, base);
  const upper = 50 - 30 * base - 26 * extra;
  const lower = 50 + 2 * base + 5 * extra;
  const f = (n: number) => +n.toFixed(2);
  return `M${f(x1)} 36 Q36 ${f(upper)} ${f(x2)} 36 Q36 ${f(lower)} ${f(x1)} 36 Z`;
}

/** The pupil's radius for an openness: none while the lids are nearly shut. */
export function pupilRadius(open: number, dilate = 0, base = 5): number {
  const o = Math.max(0, open);
  if (o < 0.28) return 0;
  const shown = clamp01((o - 0.28) / 0.4);
  return +(base * shown + Math.max(0, o - 1) * 4 + dilate * shown).toFixed(2);
}

/** How far the pupil may travel inside the lids at an openness. */
export function lookRange(open: number): number {
  return 6 * clamp01(open);
}

/** The stroke width: the resting curve's 4 easing to the watching almond's 3.5. */
export function strokeWidth(open: number): number {
  return +lerp(4, 3.5, clamp01(open)).toFixed(2);
}

export function mixPose(a: EyePose, b: EyePose, t: number): EyePose {
  return {
    open: lerp(a.open, b.open, t),
    lookX: lerp(a.lookX, b.lookX, t),
    lookY: lerp(a.lookY, b.lookY, t),
    dilate: lerp(a.dilate, b.dilate, t),
  };
}

/** Ease functions for the eye's moves: lids snap shut and open with a soft overshoot. */
export const ease = {
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  in: (t: number) => t * t * t,
  /** Overshoots a little and settles: a lid lifting. */
  spring: (t: number) => {
    const c = 1.55;
    return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
  },
};

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
