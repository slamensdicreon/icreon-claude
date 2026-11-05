/*
 * Restyled to the Cypher Design System tokens (docs/redesign/cypher-handoff/design-system).
 * Original: affectUI Segmented Control (Clean), see git history.
 *
 * Cypher additions: kind="toggle" renders the Dial (role="group" of real buttons with aria-pressed, arrow keys
 * still move), and tone="onInk" restyles it for the ink shell. With kind="toggle" and no variant, the variant
 * is "tray": a surface pill with a mist border and 4px padding, the active option an ink pill.
 */
'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

/*
 * Segmented Control (Clean) – switch between two to six options, in a single self-contained file.
 * Clean style: "buttons" (the default): separate quiet chips with a hairline, the active one filled light gray;
 * "tray": a compact light-gray track with a white raised pill; "underline": text tabs with a sliding line.
 * The indicator slides to the picked option, short and crisp – its leading edge runs a touch ahead.
 * Labels keep one weight, so nothing shifts; when a label or count changes the control morphs to its new size.
 * Arrow keys, Home and End move and select; press the pill and drag it across the options to pick as you go.
 * If it doesn't fit (phones), it scrolls sideways with soft edges and keeps the active option in view.
 * The styles are injected below, so no extra files are needed.
 */

export type SegmentOption<T extends string = string> = {
  value: T;
  label?: ReactNode;
  icon?: ReactNode;
  /** A small gray number after the label, e.g. unread items */
  count?: number | string;
  /** A small tinted tag after the label, e.g. "Save 20%" */
  badge?: ReactNode;
  disabled?: boolean;
  /** Accessible name – needed when the option only shows an icon */
  ariaLabel?: string;
  /** With kind="tabs": the id of the panel this tab shows */
  controls?: string;
};

export type SegmentedControlProps<T extends string = string> = {
  options: SegmentOption<T>[];
  /** Controlled value */
  value?: T;
  /** Starting value when uncontrolled – defaults to the first enabled option */
  defaultValue?: T;
  onChange?: (value: T) => void;
  size?: 'sm' | 'md' | 'lg';
  /** "buttons" = separate chips, the active one filled; "tray" = light track with a raised pill; "underline" = text tabs with a sliding line.
   *  Defaults to "buttons", or to "tray" with kind="toggle" (the Dial) */
  variant?: 'buttons' | 'tray' | 'underline';
  /** "default" for light grounds; "onInk" inside the ink shell (active option surface with ink text, inactive on-ink-muted) */
  tone?: 'default' | 'onInk';
  /** Fill the container with equal segments */
  fullWidth?: boolean;
  /** "radio" (a radiogroup, the default), "tabs" (a tablist that switches panels) or "toggle" (a group of
   *  buttons with aria-pressed – the Cypher Dial; label it with aria-label, e.g. "How much to show") */
  kind?: 'radio' | 'tabs' | 'toggle';
  disabled?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  className?: string;
  /**
   * Remembers where the pill last stood under this name, so a control that is remounted (the Dial,
   * when the shell swaps Bliss's header for Everything's top bar) glides from there instead of
   * appearing in place.
   */
  memory?: string;
};

/** Where each remembered control's pill last stood: its left edge and width in the track. */
const PILL_MEMORY = new Map<string, { x: number; w: number }>();

export function SegmentedControl<T extends string = string>({
  options: rawOptions,
  value,
  defaultValue,
  onChange,
  size: sizeProp = 'md',
  variant: variantProp,
  tone = 'default',
  fullWidth = false,
  kind = 'radio',
  disabled = false,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  className,
  memory,
}: SegmentedControlProps<T>) {
  // Gaps and repeated values are dropped – one value, one option
  const options = useMemo(() => {
    const seen = new Set<string>();
    return (Array.isArray(rawOptions) ? rawOptions : []).filter((o): o is SegmentOption<T> => {
      if (!o || o.value == null || seen.has(String(o.value))) return false;
      seen.add(String(o.value));
      return true;
    });
  }, [rawOptions]);
  // Unknown sizes and variants fall back to the defaults
  const size = sizeProp === 'sm' || sizeProp === 'lg' ? sizeProp : 'md';
  const variant =
    variantProp === 'tray' || variantProp === 'underline' || variantProp === 'buttons'
      ? variantProp
      : kind === 'toggle'
        ? 'tray'
        : 'buttons';
  const [inner, setInner] = useState<T | undefined>(
    () => defaultValue ?? options.find((o) => !o.disabled)?.value,
  );
  const current = value !== undefined ? value : inner;

  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  // Latest value without waiting for a render – dragging picks several options in one frame
  const latest = useRef(current);
  latest.current = current;
  const gliding = useRef(false);
  const glideTimer = useRef(0);
  const placed = useRef<T | undefined>(undefined);
  const press = useRef<{
    id: number;
    touch: boolean;
    drag: boolean;
    x: number;
    moved: boolean;
  } | null>(null);

  const buttons = () =>
    Array.from(track.current?.querySelectorAll<HTMLElement>(':scope > .ui-segc__opt') ?? []);
  const activeIndex = options.findIndex((o) => o.value === current);
  const tabbable = activeIndex >= 0 ? activeIndex : options.findIndex((o) => !o.disabled);

  const select = (v: T) => {
    const opt = options.find((o) => o.value === v);
    if (!opt || opt.disabled || disabled || v === latest.current) return;
    latest.current = v;
    if (value === undefined) setInner(v);
    onChange?.(v);
  };

  /** Buttons get the width of their content, so a changed label or count makes them – and the control – glide to the new size */
  const measure = () => {
    const els = buttons();
    const first = els[0];
    if (!first || !track.current) return;
    const cs = getComputedStyle(first);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const widths = els.map((b) => (b.firstElementChild as HTMLElement).offsetWidth + pad);
    if (fullWidth) {
      track.current.style.setProperty('--ui-segc-min', `${Math.max(...widths)}px`);
      els.forEach((b) => (b.style.width = ''));
    } else els.forEach((b, i) => (b.style.width = `${widths[i]}px`));
  };

  /** Moves the pill (or line) under the active option. Without `animate` it follows at once – unless a glide is still running */
  const place = (animate: boolean) => {
    const t = track.current;
    const p = pill.current;
    if (!t || !p) return;
    const btn = t.querySelector<HTMLElement>(':scope > .ui-segc__opt[data-active]');
    if (!btn || !btn.offsetWidth) {
      p.style.opacity = '0';
      return;
    }
    let x = btn.offsetLeft;
    let w = btn.offsetWidth;
    // The line sits under the text only, not under the whole button
    if (variant === 'underline') {
      const content = btn.firstElementChild as HTMLElement;
      x += content.offsetLeft;
      w = content.offsetWidth;
    }
    // First placement of a remembered control: start from where its pill last stood, then glide
    const from = !p.dataset.ready && memory ? PILL_MEMORY.get(memory) : undefined;
    if (memory) PILL_MEMORY.set(memory, { x, w });
    if (from && (from.x !== x || from.w !== w) && !reducedMotion()) {
      p.style.transition = 'none';
      p.style.opacity = '1';
      p.style.left = `${from.x}px`;
      p.style.right = `${t.clientWidth - from.x - from.w}px`;
      p.dataset.ready = '1';
      void p.offsetWidth;
      p.style.transition = '';
      p.dataset.dir = x > from.x ? 'right' : 'left';
      p.style.left = `${x}px`;
      p.style.right = `${t.clientWidth - x - w}px`;
      return;
    }
    const instant = !p.dataset.ready || (!animate && !gliding.current);
    const prev = parseFloat(p.style.left) || 0;
    // The edge facing the target leads, the other one trails – the stretch
    if (!instant && x !== prev) p.dataset.dir = x > prev ? 'right' : 'left';
    if (instant) p.style.transition = 'none';
    p.style.opacity = '1';
    p.style.left = `${x}px`;
    p.style.right = `${t.clientWidth - x - w}px`;
    if (instant) {
      p.dataset.ready = '1';
      void p.offsetWidth;
      p.style.transition = '';
    }
  };

  /** Soft edges only on the sides that can scroll */
  const fades = () => {
    const s = scroller.current;
    if (!s) return;
    const max = s.scrollWidth - s.clientWidth;
    root.current?.toggleAttribute('data-overflow', max > 1);
    s.style.setProperty('--ui-segc-fade-l', s.scrollLeft > 1 ? '24px' : '0px');
    s.style.setProperty('--ui-segc-fade-r', s.scrollLeft < max - 1 ? '24px' : '0px');
  };

  /** Keeps the active option in view when the control scrolls */
  const reveal = (smooth: boolean) => {
    const s = scroller.current;
    const t = track.current;
    const btn = t?.querySelector<HTMLElement>(':scope > .ui-segc__opt[data-active]');
    if (!s || !t || !btn || s.scrollWidth <= s.clientWidth + 1) return;
    const left = t.offsetLeft + btn.offsetLeft - (s.clientWidth - btn.offsetWidth) / 2;
    s.scrollTo({
      left: Math.max(0, left),
      behavior: smooth && !reducedMotion() ? 'smooth' : 'auto',
    });
  };

  // Sizes: measured on mount and whenever a label, the container or the font changes
  useLayoutEffect(() => {
    const t = track.current;
    const s = scroller.current;
    if (!t || !s) return;
    const sync = () => {
      measure();
      place(false);
      fades();
    };
    sync();
    // Width transitions only after the first measure, so nothing grows in on load
    const ready = requestAnimationFrame(() => root.current?.setAttribute('data-ready', ''));
    // One frame later, so setting widths inside the observer never loops
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sync);
    });
    ro.observe(s);
    ro.observe(t);
    t.querySelectorAll('.ui-segc__opt, .ui-segc__content').forEach((el) => ro.observe(el));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(ready);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.length, fullWidth, variant, size]);

  // A new value: the pill glides there, focus follows if it was inside, and a scrolling control brings it into view
  useLayoutEffect(() => {
    if (placed.current === current) return;
    const first = placed.current === undefined;
    placed.current = current;
    if (!first) {
      gliding.current = true;
      clearTimeout(glideTimer.current);
      glideTimer.current = window.setTimeout(() => (gliding.current = false), 460);
    }
    place(!first);
    reveal(!first);
    const t = track.current;
    if (!first && t && t.contains(document.activeElement))
      buttons()[activeIndex]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => () => clearTimeout(glideTimer.current), []);

  /* ---------- Keyboard ---------- */

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const enabled = options.filter((o) => !o.disabled);
    if (!enabled.length || disabled) return;
    // Radio and toggle groups move on both axes; a horizontal tablist only on left and right
    const prevKeys = kind === 'tabs' ? ['ArrowLeft'] : ['ArrowLeft', 'ArrowUp'];
    const nextKeys = kind === 'tabs' ? ['ArrowRight'] : ['ArrowRight', 'ArrowDown'];
    const at = enabled.findIndex((o) => o.value === latest.current);
    let target: SegmentOption<T> | undefined;
    if (prevKeys.includes(e.key)) target = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (nextKeys.includes(e.key)) target = enabled[(at + 1) % enabled.length];
    else if (e.key === 'Home') target = enabled[0];
    else if (e.key === 'End') target = enabled[enabled.length - 1];
    if (!target) return;
    e.preventDefault();
    select(target.value);
    buttons()[options.indexOf(target)]?.focus();
  };

  /* ---------- Pointer: press feedback and dragging across options ---------- */

  /** The option under (or nearest to) a horizontal pointer position */
  const optionAt = (clientX: number) => {
    let best = -1;
    let dist = Infinity;
    buttons().forEach((b, i) => {
      const r = b.getBoundingClientRect();
      const d = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
      if (d < dist) {
        dist = d;
        best = i;
      }
    });
    return options[best];
  };

  const endPress = () => {
    press.current = null;
    root.current?.removeAttribute('data-pressed');
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    const opt = optionAt(e.clientX);
    if (!opt || opt.disabled) return;
    const touch = e.pointerType === 'touch';
    // Touch: picks on lift (so swiping to scroll doesn't pick), but the pill itself can be dragged right away
    const drag = !touch || opt.value === latest.current;
    press.current = { id: e.pointerId, touch, drag, x: e.clientX, moved: false };
    if (drag) root.current?.setAttribute('data-pressed', '');
    if (!touch) {
      select(opt.value);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is a nicety */
      }
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.moved && Math.abs(e.clientX - p.x) < (p.touch ? 8 : 3)) return;
    p.moved = true;
    if (!p.drag) return;
    const opt = optionAt(e.clientX);
    if (opt && !opt.disabled) select(opt.value);
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (p.touch && !p.moved) {
      const opt = optionAt(e.clientX);
      if (opt) select(opt.value);
    }
    endPress();
  };

  const isTabs = kind === 'tabs';
  const isToggle = kind === 'toggle';

  return (
    <div
      ref={root}
      className={['ui-segc', className].filter(Boolean).join(' ')}
      data-size={size}
      data-variant={variant}
      data-tone={tone === 'onInk' ? 'on-ink' : undefined}
      data-full={fullWidth || undefined}
      data-disabled={disabled || undefined}
    >
      {/* React 19 hoists this into <head> once, no matter how many controls render */}
      <style href="ui-segmented-control-clean" precedence="default">
        {css}
      </style>

      <div ref={scroller} className="ui-segc__scroller" onScroll={fades}>
        <div
          ref={track}
          className="ui-segc__track"
          role={isTabs ? 'tablist' : isToggle ? 'group' : 'radiogroup'}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledby}
          aria-disabled={disabled || undefined}
          aria-orientation={isTabs ? 'horizontal' : undefined}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={endPress}
          onLostPointerCapture={endPress}
        >
          <span ref={pill} className="ui-segc__pill" aria-hidden="true" />
          {options.map((o, i) => {
            const active = i === activeIndex;
            // Without a label or icon the value names the option; NaN counts show nothing
            const label = o.label ?? (o.icon ? null : String(o.value));
            const count = countText(o.count);
            return (
              <button
                key={String(o.value)}
                type="button"
                className="ui-segc__opt"
                role={isTabs ? 'tab' : isToggle ? undefined : 'radio'}
                aria-checked={isTabs || isToggle ? undefined : active}
                aria-selected={isTabs ? active : undefined}
                aria-pressed={isToggle ? active : undefined}
                aria-controls={isTabs ? o.controls : undefined}
                aria-label={o.ariaLabel}
                data-active={active || undefined}
                disabled={o.disabled || disabled}
                tabIndex={i === tabbable ? 0 : -1}
                // Keyboard (Enter / Space) and screen readers – pointers are handled on the track
                onClick={() => select(o.value)}
              >
                <span className="ui-segc__content">
                  {o.icon && (
                    <span
                      className="ui-segc__icon"
                      onErrorCapture={(e) =>
                        ((e.target as HTMLElement).style.visibility = 'hidden')
                      }
                    >
                      {o.icon}
                    </span>
                  )}
                  {/* One weight for both states – only the color changes, so nothing shifts */}
                  {label != null && (
                    <span className="ui-segc__label" dir="auto">
                      {label}
                    </span>
                  )}
                  {count != null && count !== '' && (
                    <span key={String(count)} className="ui-segc__count">
                      {count}
                    </span>
                  )}
                  {o.badge != null && <span className="ui-segc__badge">{o.badge}</span>}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The scroll that keeps the active option in view jumps instead of gliding when motion is reduced */
const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** 1284 → "1,284"; NaN and Infinity show nothing */
const countText = (c: number | string | undefined) =>
  typeof c === 'number' ? (Number.isFinite(c) ? c.toLocaleString('en-US') : null) : c;

const css = /* css */ `
/* Animatable custom properties: the equal segment width and the soft edges glide too */
@property --ui-segc-min { syntax: "<length>"; inherits: true; initial-value: 0px; }
@property --ui-segc-fade-l { syntax: "<length>"; inherits: false; initial-value: 0px; }
@property --ui-segc-fade-r { syntax: "<length>"; inherits: false; initial-value: 0px; }

/* Cypher tokens (tokens.css): on light grounds the active option is an ink pill with on-ink text */
.ui-segc {
  --ui-segc-ink: var(--ink);
  --ui-segc-text: var(--text-3);
  --ui-segc-hover-text: var(--text-2);
  --ui-segc-line: var(--mist);
  --ui-segc-wash: var(--surface-quiet);
  --ui-segc-fill: var(--ink);
  --ui-segc-on-fill: var(--on-ink);
  --ui-segc-track: var(--surface);
  --ui-segc-tag: var(--mist-2);
  --ui-segc-tag-text: var(--text-2);
  --ui-segc-tag-on: color-mix(in srgb, var(--on-ink) 20%, transparent);
  --ui-segc-tag-on-text: var(--on-ink);
  --ui-segc-focus: color-mix(in srgb, var(--blue) 40%, transparent);
  --ui-segc-ease: var(--ease-spring, ease-out);
  /* Size: md – 44px, the Dial; labels in the button style (15px / 700) */
  --ui-segc-h: 44px;
  --ui-segc-px: var(--space-4);
  --ui-segc-fs: 15px;
  --ui-segc-lh: 20px;
  --ui-segc-icon: 18px;
  --ui-segc-gap: var(--space-2);
  --ui-segc-pad: var(--space-1);
  --ui-segc-ring: 3px;
  box-sizing: border-box;
  display: inline-flex;
  max-width: 100%;
  min-width: 0;
  vertical-align: middle;
  border-radius: var(--radius-pill);
  font-family: var(--font-sans);
  font-size: var(--ui-segc-fs);
  font-weight: 700;
  line-height: var(--ui-segc-lh);
  font-variant-numeric: tabular-nums;
  color: var(--ui-segc-text);
  -webkit-font-smoothing: antialiased;
}
/* Inside the shell (both themes): an on-shell pill with shell text on an ink-2 track with an ink-3 line */
.ui-segc[data-tone="on-ink"] {
  --ui-segc-ink: var(--on-shell);
  --ui-segc-text: var(--on-ink-muted);
  --ui-segc-hover-text: var(--on-shell);
  --ui-segc-line: var(--ink-3);
  --ui-segc-wash: var(--ink-3);
  --ui-segc-fill: var(--on-shell);
  --ui-segc-on-fill: var(--shell);
  --ui-segc-track: var(--ink-2);
  --ui-segc-tag: var(--ink-3);
  --ui-segc-tag-text: var(--on-ink-muted);
  --ui-segc-tag-on: var(--ink-3);
  --ui-segc-tag-on-text: var(--on-shell);
}
.ui-segc[data-size="sm"] { --ui-segc-h: 36px; --ui-segc-px: var(--space-3); --ui-segc-fs: 13px; --ui-segc-lh: 18px; --ui-segc-icon: 16px; --ui-segc-gap: var(--space-1); }
.ui-segc[data-size="lg"] { --ui-segc-h: 48px; --ui-segc-px: 20px; --ui-segc-fs: 16px; --ui-segc-icon: 20px; }
.ui-segc[data-full] { display: flex; width: 100%; }
.ui-segc[data-disabled] { opacity: 0.5; pointer-events: none; }
.ui-segc *, .ui-segc *::before, .ui-segc *::after { box-sizing: border-box; }
:where(.ui-segc) button { margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
:where(.ui-segc) svg { display: block; flex: none; }

/* Scrolls sideways only when it doesn't fit; the padding keeps focus rings from being cut off.
   The mask reads alpha only, so the opaque stop is any token */
.ui-segc__scroller {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  padding: var(--ui-segc-pad);
  border-radius: inherit;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(to right, transparent, var(--ink) var(--ui-segc-fade-l), var(--ink) calc(100% - var(--ui-segc-fade-r)), transparent);
  mask-image: linear-gradient(to right, transparent, var(--ink) var(--ui-segc-fade-l), var(--ink) calc(100% - var(--ui-segc-fade-r)), transparent);
  transition: --ui-segc-fade-l 160ms ease-out, --ui-segc-fade-r 160ms ease-out;
}
.ui-segc__scroller::-webkit-scrollbar { display: none; }

.ui-segc__track {
  position: relative;
  display: flex;
  width: max-content;
  min-width: 100%;
  /* Horizontal drags move the indicator; vertical ones still scroll the page */
  touch-action: pan-y;
  -webkit-user-select: none;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
/* When it scrolls, swipes scroll it instead of dragging the indicator */
.ui-segc[data-overflow] .ui-segc__track { touch-action: pan-x pan-y; }
/* Equal segments, each as wide as the widest one needs */
.ui-segc[data-full] .ui-segc__track { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(var(--ui-segc-min), 1fr); }
.ui-segc[data-ready] .ui-segc__track { transition: --ui-segc-min 200ms var(--ui-segc-ease); }

/* An option */
.ui-segc__opt {
  position: relative;
  z-index: 1;
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  height: var(--ui-segc-h);
  padding: 0 var(--ui-segc-px);
  overflow: clip;
  border-radius: var(--radius-pill);
  white-space: nowrap;
  transition: color 300ms var(--ease-out, ease-out) 60ms, background-color 200ms ease-out;
}
.ui-segc[data-ready]:not([data-full]) .ui-segc__opt { transition: color 300ms var(--ease-out, ease-out) 60ms, background-color 200ms ease-out, width 240ms var(--ui-segc-ease); }
.ui-segc__opt[data-active] { color: var(--ui-segc-on-fill); }
.ui-segc__opt:disabled { opacity: 0.4; cursor: not-allowed; }
/* Focus: 3px of blue at 40%, outside the control */
.ui-segc__opt:focus-visible { outline: var(--ui-segc-ring) solid var(--ui-segc-focus); outline-offset: 0; }
@media (hover: hover) {
  .ui-segc__opt:not([data-active]):not(:disabled):hover { background-color: var(--ui-segc-wash); color: var(--ui-segc-hover-text); }
}

.ui-segc__content { display: inline-flex; flex: none; align-items: center; gap: var(--space-2); }
.ui-segc[data-size="sm"] .ui-segc__content { gap: 6px; }
/* Icons take the option's text color, so they follow its state */
.ui-segc__icon { display: grid; place-items: center; width: var(--ui-segc-icon); height: var(--ui-segc-icon); color: inherit; }
.ui-segc__icon svg, .ui-segc__icon img { width: 100%; height: 100%; }
/* Images fill the tile without leaving it, whatever their shape */
.ui-segc__icon { overflow: hidden; }
.ui-segc__icon img { display: block; object-fit: contain; }
.ui-segc__label { display: block; }

.ui-segc__count {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--ui-segc-tag);
  font-size: var(--type-label-size);
  line-height: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--ui-segc-tag-text);
  animation: ui-segc-in 200ms var(--ui-segc-ease) both;
}
.ui-segc__badge {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--ui-segc-tag);
  font-size: var(--type-label-size);
  line-height: 18px;
  font-weight: 600;
  color: var(--ui-segc-tag-text);
}
.ui-segc[data-size="sm"] .ui-segc__count { min-width: 18px; height: 18px; padding: 0 5px; line-height: 18px; }
.ui-segc[data-size="sm"] .ui-segc__badge { height: 18px; padding: 0 6px; }
/* On the filled pill, counts and tags turn to the pill's own text color */
.ui-segc:not([data-variant="underline"]) .ui-segc__opt[data-active] :is(.ui-segc__count, .ui-segc__badge) { background: var(--ui-segc-tag-on); color: var(--ui-segc-tag-on-text); }

/* The indicator: left and right edges slide separately – the one facing the target leads a touch. Short and crisp */
.ui-segc__pill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 100%;
  z-index: 0;
  border-radius: var(--radius-pill);
  background: var(--ui-segc-fill);
  opacity: 0;
  pointer-events: none;
  transition: left 380ms var(--ui-segc-ease), right 380ms var(--ui-segc-ease), scale 240ms var(--ui-segc-ease), opacity 120ms ease-out;
}
/* The edge facing the target leads and the far edge follows, so the pill stretches as it travels, then settles */
.ui-segc__pill[data-dir="right"] { transition-duration: 440ms, 340ms, 240ms, 120ms; }
.ui-segc__pill[data-dir="left"] { transition-duration: 340ms, 440ms, 240ms, 120ms; }
/* Press feedback: the indicator gives a little while held or dragged */
.ui-segc[data-pressed]:not([data-variant="underline"]) .ui-segc__pill { scale: 0.97; }

/* Buttons (default): separate pills with a mist line; the ink fill slides to the active one.
   The control reaches a few px past its box so focus rings are never clipped, and still lines up with its neighbours */
.ui-segc[data-variant="buttons"] { --ui-segc-pad: var(--ui-segc-ring); margin: calc(var(--ui-segc-ring) * -1); max-width: calc(100% + var(--ui-segc-ring) * 2); }
.ui-segc[data-variant="buttons"][data-full] { width: calc(100% + var(--ui-segc-ring) * 2); }
.ui-segc[data-variant="buttons"] .ui-segc__track { gap: var(--ui-segc-gap); }
.ui-segc[data-variant="buttons"] .ui-segc__opt:not([data-active]) { box-shadow: inset 0 0 0 1px var(--ui-segc-line); }

/* Tray – the Dial: a surface pill with a mist line and 4px of padding; the ink pill glides inside it */
.ui-segc[data-variant="tray"] { background: var(--ui-segc-track); border: 1px solid var(--ui-segc-line); }
.ui-segc[data-variant="tray"] .ui-segc__opt { height: calc(var(--ui-segc-h) - var(--ui-segc-pad) * 2 - 2px); }

/* Underline: text tabs on a mist line; the active one in ink with an ink line under it */
.ui-segc[data-variant="underline"] { --ui-segc-px: 2px; --ui-segc-gap: var(--space-5); border-radius: 0; box-shadow: inset 0 -1px 0 var(--ui-segc-line); }
.ui-segc[data-variant="underline"] .ui-segc__scroller { padding: 0; }
.ui-segc[data-variant="underline"]:not([data-full]) .ui-segc__track { gap: var(--ui-segc-gap); }
.ui-segc[data-variant="underline"][data-full] { --ui-segc-px: var(--space-3); }
.ui-segc[data-variant="underline"] .ui-segc__opt { border-radius: var(--radius-sm); }
.ui-segc[data-variant="underline"] .ui-segc__opt[data-active] { color: var(--ui-segc-ink); }
.ui-segc[data-variant="underline"] .ui-segc__opt:focus-visible { outline-offset: calc(var(--ui-segc-ring) * -1); }
.ui-segc[data-variant="underline"] .ui-segc__pill { top: auto; height: 2px; border-radius: var(--radius-pill) var(--radius-pill) 0 0; background: var(--ui-segc-ink); }
@media (hover: hover) {
  .ui-segc[data-variant="underline"] .ui-segc__opt:not([data-active]):not(:disabled):hover { background-color: transparent; color: var(--ui-segc-hover-text); }
}

@keyframes ui-segc-in { from { opacity: 0; transform: translateY(2px); filter: blur(2px); } to { opacity: 1; transform: none; filter: none; } }

/* Touch screens: nothing tappable under 44px */
@media (hover: none) and (pointer: coarse) {
  .ui-segc[data-size="sm"] { --ui-segc-h: 44px; }
}
/* Reduced motion: the pill jumps, nothing fades, grows or glides */
@media (prefers-reduced-motion: reduce) {
  .ui-segc, .ui-segc *, .ui-segc *::before, .ui-segc *::after { animation: none !important; transition: none !important; }
}
`;
