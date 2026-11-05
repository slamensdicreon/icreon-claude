/*
 * The timelines' zoom: remembered per browser (localStorage `lw.planZoom`), set with − and +, a
 * range, Fit, or Ctrl/⌘ and the scroll wheel, always keeping the moment under the cursor (or the
 * middle of the view) where it was. Positions are read from the track itself, so no column width
 * is repeated here.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import s from './plan.module.css';

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 8;
const STEP = 1.5;
const WHEEL_STEP = 1.15;
const KEY = 'lw.planZoom';
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));

export function useZoom() {
  const [zoom, setZoomState] = useState(() => {
    try {
      return clampZoom(Number(localStorage.getItem(KEY)) || 1);
    } catch {
      return 1;
    }
  });
  const setZoom = (z: number) => {
    const next = clampZoom(z);
    setZoomState(next);
    try {
      localStorage.setItem(KEY, String(next));
    } catch {
      /* not remembered */
    }
  };
  return [zoom, setZoom] as const;
}

/** Where the track sits inside the scrolling timeline, in pixels, as laid out right now. */
function trackBox(scroll: HTMLElement | null, track: HTMLElement | null) {
  if (!scroll || !track) return null;
  return { el: scroll, left: track.offsetLeft, width: Math.max(1, track.offsetWidth) };
}

/**
 * Zoom about a point of the track. `scroll` is the scrolling box; `track` is any element that
 * spans the time axis exactly (the header's tick row). Returns `zoomTo` (about the middle of the
 * view) and `reveal` (scroll a fraction of the axis to a third of the way in).
 */
export function useTimelineZoom(
  scroll: RefObject<HTMLDivElement | null>,
  track: RefObject<HTMLDivElement | null>,
  zoom: number,
  setZoom: (z: number) => void,
) {
  const anchor = useRef<{ pos: number; offset: number } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const setRef = useRef(setZoom);
  setRef.current = setZoom;

  useLayoutEffect(() => {
    const box = trackBox(scroll.current, track.current);
    const a = anchor.current;
    anchor.current = null;
    if (!box || !a) return;
    box.el.scrollLeft = box.left + a.pos * box.width - a.offset;
  }, [zoom, scroll, track]);

  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const box = trackBox(el, track.current);
      if (!box) return;
      const offset = e.clientX - el.getBoundingClientRect().left;
      anchor.current = { pos: (el.scrollLeft + offset - box.left) / box.width, offset };
      setRef.current(zoomRef.current * (e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [scroll, track]);

  const zoomTo = (z: number) => {
    const box = trackBox(scroll.current, track.current);
    if (box) {
      const offset = box.el.clientWidth / 2;
      anchor.current = { pos: (box.el.scrollLeft + offset - box.left) / box.width, offset };
    }
    setZoom(z);
  };
  const reveal = (pct: number) => {
    const box = trackBox(scroll.current, track.current);
    if (box)
      box.el.scrollLeft = Math.max(0, box.left + (box.width * pct) / 100 - box.el.clientWidth / 3);
  };
  return { zoomTo, reveal };
}

export function ZoomControl({ zoom, set }: { zoom: number; set: (z: number) => void }) {
  return (
    <span className={s.zoom} role="group" aria-label="Timeline zoom">
      <button
        type="button"
        className={`${s.zoomButton} type-button`}
        aria-label="Zoom out"
        onClick={() => set(zoom / STEP)}
        disabled={zoom <= ZOOM_MIN}
      >
        <span aria-hidden="true">−</span>
      </button>
      <input
        type="range"
        className={s.zoomRange}
        aria-label="Zoom"
        aria-valuetext={`${Math.round(zoom * 100)}%`}
        min={Math.log2(ZOOM_MIN)}
        max={Math.log2(ZOOM_MAX)}
        step={0.05}
        value={Math.log2(zoom)}
        onChange={(e) => set(2 ** Number(e.target.value))}
      />
      <button
        type="button"
        className={`${s.zoomButton} type-button`}
        aria-label="Zoom in"
        onClick={() => set(zoom * STEP)}
        disabled={zoom >= ZOOM_MAX}
      >
        <span aria-hidden="true">+</span>
      </button>
      <button
        type="button"
        className={`${s.fit} type-button`}
        onClick={() => set(1)}
        disabled={zoom === 1}
        title="Back to the default zoom"
      >
        Fit
      </button>
      <span className={`${s.zoomValue} type-meta`} aria-live="polite">
        {Math.round(zoom * 100)}%
      </span>
    </span>
  );
}

/** An element's width in pixels, kept current as it resizes (to choose how dense ticks can be). */
export function useWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.offsetWidth);
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
