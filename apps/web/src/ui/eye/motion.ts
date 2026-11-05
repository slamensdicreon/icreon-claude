/*
 * Moves an eye figure between poses: tweens on requestAnimationFrame, written straight to the
 * SVG (no React render per frame). A move can be one tween or a sequence; a new move starts from
 * wherever the eye is, so nothing jumps when one interrupts another.
 */
import { ease, lidPath, mixPose, pupilRadius, strokeWidth, type EyePose } from './geometry';

export interface EyeParts {
  lids: SVGPathElement;
  pupil: SVGCircleElement;
}

export interface Step {
  to: Partial<EyePose>;
  ms: number;
  ease?: (t: number) => number;
  /** Hold this long after arriving, before the next step. */
  hold?: number;
}

export class EyeMotion {
  pose: EyePose;
  private parts: EyeParts | null = null;
  private frame = 0;
  private token = 0;
  constructor(
    start: EyePose,
    private readonly pupilBase = 5,
    private readonly filled = false,
  ) {
    this.pose = { ...start };
  }

  attach(parts: EyeParts | null) {
    this.parts = parts;
    this.draw();
  }

  set(p: Partial<EyePose>) {
    this.cancel();
    this.pose = { ...this.pose, ...p };
    this.draw();
  }

  cancel() {
    this.token++;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  /** Runs the steps in order; resolves when they finish, or false when interrupted. */
  play(steps: Step[]): Promise<boolean> {
    this.cancel();
    const token = this.token;
    return new Promise((resolve) => {
      let i = 0;
      let from = this.pose;
      let started = performance.now();
      let holdUntil = 0;
      const tick = (now: number) => {
        if (token !== this.token) return resolve(false);
        const step = steps[i];
        if (!step) {
          this.frame = 0;
          return resolve(true);
        }
        if (holdUntil) {
          if (now < holdUntil) {
            this.frame = requestAnimationFrame(tick);
            return;
          }
          holdUntil = 0;
          i++;
          from = this.pose;
          started = now;
          this.frame = requestAnimationFrame(tick);
          return;
        }
        const target = { ...from, ...step.to };
        const t = step.ms <= 0 ? 1 : Math.min(1, (now - started) / step.ms);
        this.pose = mixPose(from, target, (step.ease ?? ease.inOut)(t));
        this.draw();
        if (t >= 1) {
          this.pose = target;
          if (step.hold) holdUntil = now + step.hold;
          else {
            i++;
            from = this.pose;
            started = now;
          }
        }
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    });
  }

  private draw() {
    const p = this.parts;
    if (!p) return;
    const { open, lookX, lookY, dilate } = this.pose;
    p.lids.setAttribute('d', lidPath(open));
    if (!this.filled) p.lids.setAttribute('stroke-width', String(strokeWidth(open)));
    const r = pupilRadius(open, dilate, this.pupilBase);
    p.pupil.setAttribute('r', String(r));
    p.pupil.setAttribute('cx', String(36 + lookX));
    p.pupil.setAttribute('cy', String(36 + lookY * Math.min(1, open)));
  }
}

/** A random wait between two bounds, for blinks and glances that shouldn't feel scheduled. */
export const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
