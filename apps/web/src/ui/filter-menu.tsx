/*
 * Restyled to the Cypher Design System tokens (docs/redesign/cypher-handoff/design-system).
 * Original: affectUI Filter Menu (MIT), https://www.affectui.com/r/filter-menu.json.
 *
 * In Cypher this filters the Blueprint in Workbench Everything: a surface-quiet tray with a mist
 * line, the surface card inside it, ink checkboxes and pill chips for what is picked. Rows are 44px
 * so every option is tappable; nothing is under 13px; motion stops under prefers-reduced-motion.
 */
'use client';

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

/*
 * Filter Menu – grouped filters with chips, in a single self-contained file.
 * Active filters sit on top as removable chips; below, collapsible groups list their options as checkboxes
 * with a count of what's picked. Arrow keys move through groups and options, Enter or Space picks,
 * ← and → fold a group. Heights glide when groups open or chips come and go.
 * The styles are injected below, so no extra files are needed.
 */

export type FilterOption = { id: string; label: string };

export type FilterGroup = {
  id: string;
  label: string;
  options: FilterOption[];
  /** Put in front of the option on its chip, e.g. "Score: " → "Score: 80–90" */
  chipPrefix?: string;
};

/** Picked option ids per group id */
export type FilterValue = Record<string, string[]>;

export type FilterMenuProps = {
  groups: FilterGroup[];
  /** Controlled value */
  value?: FilterValue;
  /** Starting value when uncontrolled */
  defaultValue?: FilterValue;
  onChange?: (value: FilterValue) => void;
  /** Groups that start open – by default the first one */
  defaultOpen?: string[];
  title?: string;
  /** Show the keyboard hints at the bottom */
  hints?: boolean;
  className?: string;
};

type Row =
  | { kind: 'group'; group: FilterGroup; gi: number }
  | { kind: 'option'; group: FilterGroup; option: FilterOption; gi: number; oi: number };

export function FilterMenu({
  groups: rawGroups,
  value,
  defaultValue = {},
  onChange,
  defaultOpen,
  title = 'Filters',
  hints = true,
  className,
}: FilterMenuProps) {
  // Gaps, groups without an options list and options without a label are skipped; ids stay as given
  const groups = (Array.isArray(rawGroups) ? rawGroups : [])
    .filter((g): g is FilterGroup => !!g && typeof g === 'object')
    .map((g) => ({
      ...g,
      label: String(g.label ?? ''),
      options: (Array.isArray(g.options) ? g.options : [])
        .filter((o): o is FilterOption => !!o && typeof o === 'object')
        .map((o) => ({ ...o, label: String(o.label ?? '') })),
    }));
  const uid = useId();
  const [inner, setInner] = useState<FilterValue>(defaultValue);
  const picked = value ?? inner;
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(defaultOpen ?? groups.slice(0, 1).map((g) => g.id)),
  );
  const [focus, setFocus] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const chipsInner = useRef<HTMLDivElement>(null);
  const chipsOuter = useSmoothHeight(chipsInner);

  const commit = (next: FilterValue) => {
    if (value === undefined) setInner(next);
    onChange?.(next);
  };
  // Only lists count – a string or a stray value in `value` picks nothing
  const pickedIn = (g: string): string[] => {
    const list = picked[g];
    return Array.isArray(list) ? list : [];
  };
  const isOn = (g: string, o: string) => pickedIn(g).includes(o);
  const toggle = (g: string, o: string) => {
    const cur = pickedIn(g);
    commit({ ...picked, [g]: cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o] });
  };
  const toggleGroup = (g: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  // Chips in the order of the groups and their options – one per picked id, even if an id repeats
  const seen = new Set<string>();
  const chips = groups.flatMap((g) =>
    g.options
      .filter(
        (o) =>
          isOn(g.id, o.id) &&
          !seen.has(`${g.id}\u0000${o.id}`) &&
          !!seen.add(`${g.id}\u0000${o.id}`),
      )
      .map((o) => ({ group: g, option: o, label: `${g.chipPrefix ?? ''}${o.label}` })),
  );

  // Everything the arrow keys can reach, top to bottom
  // Keys come from positions, so groups or options that share an id stay reachable
  const rows: Row[] = groups.flatMap((g, gi) => [
    { kind: 'group', group: g, gi } as Row,
    ...(open.has(g.id)
      ? g.options.map((o, oi) => ({ kind: 'option', group: g, option: o, gi, oi }) as Row)
      : []),
  ]);
  const keyOf = (r: Row) => (r.kind === 'group' ? `g:${r.gi}` : `o:${r.gi}:${r.oi}`);

  const moveTo = (row: Row | undefined) => {
    if (!row) return;
    const key = keyOf(row);
    setFocus(key);
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => keyOf(r) === focus);
    const row = rows[i];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveTo(
        rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))] ??
          rows[0],
      );
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      moveTo(rows[e.key === 'Home' ? 0 : rows.length - 1]);
    } else if (row && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const g = row.group.id;
      if (e.key === 'ArrowRight' && !open.has(g)) toggleGroup(g);
      if (e.key === 'ArrowLeft') {
        if (open.has(g)) toggleGroup(g);
        moveTo(rows.find((r) => r.kind === 'group' && r.gi === row.gi));
      }
    } else if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      if (row.kind === 'group') toggleGroup(row.group.id);
      else toggle(row.group.id, row.option.id);
    }
  };

  return (
    <div className={['ui-fm', className].filter(Boolean).join(' ')}>
      <style href="ui-filter-menu" precedence="default">
        {css}
      </style>

      <div className="ui-fm__card">
        <div className="ui-fm__head">
          <span className="ui-fm__title" dir="auto" title={title}>
            {title}
          </span>
          <button
            type="button"
            className="ui-fm__clear"
            disabled={chips.length === 0}
            onClick={() => commit({})}
          >
            Clear all
          </button>
        </div>

        {/* Active filters – the box glides to its new height as chips come and go */}
        <div className="ui-fm__chips-outer" ref={chipsOuter}>
          <div className="ui-fm__chips" ref={chipsInner} aria-live="polite">
            {chips.map((c, i) => (
              <span key={i} className="ui-fm__chip">
                <span className="ui-fm__chip-label" dir="auto" title={c.label}>
                  {c.label}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${c.label}`}
                  onClick={() => toggle(c.group.id, c.option.id)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="ui-fm__groups" ref={listRef} onKeyDown={onKeyDown}>
          {groups.map((g, gi) => {
            const isOpen = open.has(g.id);
            const count = new Set(pickedIn(g.id).filter((id) => g.options.some((o) => o.id === id)))
              .size;
            const gKey = `g:${gi}`;
            return (
              <section
                key={`${g.id}#${gi}`}
                className="ui-fm__group"
                data-open={isOpen ? '' : undefined}
              >
                <button
                  type="button"
                  className="ui-fm__group-head"
                  data-key={gKey}
                  tabIndex={focus === gKey || (focus === null && gi === 0) ? 0 : -1}
                  aria-expanded={isOpen}
                  aria-controls={`${uid}-${gi}`}
                  onFocus={() => setFocus(gKey)}
                  onClick={() => toggleGroup(g.id)}
                >
                  <svg className="ui-fm__chevron" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6.5 9.5 12 15l5.5-5.5" />
                  </svg>
                  <span className="ui-fm__group-label" dir="auto" title={g.label}>
                    {g.label}
                  </span>
                  <span className="ui-fm__group-count">
                    {g.options.length.toLocaleString('en-US')}
                  </span>
                  <span className="ui-fm__group-picked" aria-live="polite">
                    {count > 0 ? `${count} filter${count === 1 ? '' : 's'}` : ''}
                  </span>
                </button>
                {/* Opens and closes by animating its grid row from 0 to the content height */}
                <div className="ui-fm__panel" id={`${uid}-${gi}`} role="group" aria-label={g.label}>
                  <div className="ui-fm__panel-inner">
                    {g.options.map((o, oi) => {
                      const key = `o:${gi}:${oi}`;
                      const on = isOn(g.id, o.id);
                      return (
                        <button
                          key={`${o.id}#${oi}`}
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          className="ui-fm__option"
                          data-key={key}
                          tabIndex={isOpen && focus === key ? 0 : -1}
                          onFocus={() => setFocus(key)}
                          onClick={() => toggle(g.id, o.id)}
                        >
                          <span className="ui-fm__box" aria-hidden="true">
                            <svg viewBox="0 0 24 24">
                              <path d="m6 12.5 4 4 8-9" />
                            </svg>
                          </span>
                          <span className="ui-fm__option-label" dir="auto" title={o.label}>
                            {o.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      </div>

      {hints && (
        <div className="ui-fm__hints" aria-hidden="true">
          <span className="ui-fm__hint">
            <kbd>
              <svg viewBox="0 0 24 24">
                <path d="M12 5v14m0 0-5-5m5 5 5-5" />
              </svg>
            </kbd>
            <kbd>
              <svg viewBox="0 0 24 24">
                <path d="M12 19V5m0 0-5 5m5-5 5 5" />
              </svg>
            </kbd>
            To navigate
          </span>
          <span className="ui-fm__hint">
            <kbd>
              <svg viewBox="0 0 24 24">
                <path d="M18 6v6.5a2 2 0 0 1-2 2H7m0 0 3.5-3.5M7 14.5 10.5 18" />
              </svg>
            </kbd>
            To select
          </span>
        </div>
      )}
    </div>
  );
}

/** The outer box follows the inner box's height, with a transition after the first frame */
function useSmoothHeight(inner: RefObject<HTMLElement | null>) {
  const outer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const sync = () => {
      o.style.height = `${i.offsetHeight}px`;
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(i);
    const frame = requestAnimationFrame(() => o.setAttribute('data-smooth', ''));
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [inner]);
  return outer;
}

/* ---------- Styles ---------- */

const css = /* css */ `
/* Cypher tokens (tokens.css): a quiet tray, the surface card inside it, ink for what is picked */
.ui-fm {
  --ui-fm-tray: var(--surface-quiet);
  --ui-fm-card: var(--surface);
  --ui-fm-card-line: var(--mist);
  --ui-fm-ink: var(--ink);
  --ui-fm-text: var(--text-2);
  --ui-fm-muted: var(--text-3);
  --ui-fm-chip: var(--surface-quiet);
  --ui-fm-chip-hover: var(--mist-2);
  --ui-fm-box: var(--surface);
  --ui-fm-box-line: var(--mist);
  --ui-fm-check: var(--on-ink);
  --ui-fm-row-hover: var(--surface-quiet);
  --ui-fm-kbd: var(--surface);
  --ui-fm-focus: color-mix(in srgb, var(--blue) 40%, transparent);
  --ui-fm-ease: ease-out;
  box-sizing: border-box;
  width: 100%;
  padding: var(--space-1);
  border: 1px solid var(--ui-fm-card-line);
  border-radius: var(--radius-lg);
  background: var(--ui-fm-tray);
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  color: var(--ui-fm-ink);
  -webkit-font-smoothing: antialiased;
}
.ui-fm *, .ui-fm *::before, .ui-fm *::after { box-sizing: border-box; }
.ui-fm button { font: inherit; color: inherit; margin: 0; cursor: pointer; -webkit-tap-highlight-color: transparent; }
/* Focus: 3px of blue at 40%, outside the control */
.ui-fm button:focus-visible { outline: 3px solid var(--ui-fm-focus); outline-offset: 0; }

.ui-fm__card {
  padding: var(--space-3) var(--space-4) var(--space-2);
  border: 1px solid var(--ui-fm-card-line);
  border-radius: var(--radius-md);
  background: var(--ui-fm-card);
}

/* ---------- Header ---------- */

.ui-fm__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: calc(var(--row) - var(--space-3)); }
.ui-fm__title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: start; font-size: var(--type-body-small-size); font-weight: 700; line-height: 1.3; }
.ui-fm__clear {
  flex: none;
  min-height: calc(var(--row) - var(--space-3));
  padding: 0 var(--space-2);
  margin-right: calc(var(--space-2) * -1) !important;
  border: 0;
  border-radius: var(--radius-pill);
  background: none;
  font-size: var(--type-meta-size);
  font-weight: 600;
  color: var(--ui-fm-muted) !important;
  transition: color 200ms ease-out, background-color 200ms ease-out, opacity 200ms ease-out;
}
.ui-fm__clear:hover:not(:disabled) { color: var(--ui-fm-ink) !important; background: var(--ui-fm-row-hover); }
.ui-fm__clear:disabled { opacity: 0.5; cursor: default; }

/* ---------- Chips ---------- */

.ui-fm__chips-outer { overflow: hidden; }
.ui-fm__chips-outer[data-smooth] { transition: height 200ms var(--ui-fm-ease); }
.ui-fm__chips { display: flex; flex-wrap: wrap; gap: var(--space-2); padding-top: var(--space-2); }
.ui-fm__chips:empty { padding-top: 0; }
.ui-fm__chip {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;
  align-items: center;
  gap: var(--space-1);
  min-height: calc(var(--space-6) + var(--space-1));
  padding: 0 var(--space-1) 0 var(--space-3);
  border: 1px solid var(--ui-fm-card-line);
  border-radius: var(--radius-pill);
  background: var(--ui-fm-chip);
  font-size: var(--type-meta-size);
  font-weight: 600;
  color: var(--ui-fm-ink);
  white-space: nowrap;
  animation: ui-fm-chip-in 200ms var(--ui-fm-ease) both;
}
.ui-fm__chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-fm__chip button {
  display: grid;
  flex: none;
  place-items: center;
  width: calc(var(--space-5) + var(--space-1));
  height: calc(var(--space-5) + var(--space-1));
  padding: 0;
  border: 0;
  border-radius: var(--radius-pill);
  background: none;
  color: var(--ui-fm-muted);
  transition: background-color 200ms ease-out, color 200ms ease-out;
}
.ui-fm__chip button:hover { background: var(--ui-fm-chip-hover); color: var(--ui-fm-ink); }
.ui-fm__chip svg { width: var(--space-4); height: var(--space-4); fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }

/* ---------- Groups ---------- */

.ui-fm__groups { display: grid; grid-template-columns: minmax(0, 1fr); padding-top: var(--space-1); }
.ui-fm__group-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: calc(100% + var(--space-3));
  min-height: 44px;
  margin: 0 calc(var(--space-2) * -0.75) !important;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-md);
  background: none;
  text-align: left;
  transition: background-color 200ms ease-out;
}
.ui-fm__group-head:hover { background: var(--ui-fm-row-hover); }
.ui-fm__chevron {
  width: var(--space-4);
  height: var(--space-4);
  flex: none;
  fill: none;
  stroke: var(--ui-fm-muted);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  transform: rotate(-90deg);
  transition: transform 200ms var(--ui-fm-ease);
}
.ui-fm__group[data-open] .ui-fm__chevron { transform: none; }
.ui-fm__group-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: start; font-size: var(--type-table-size); font-weight: 600; }
.ui-fm__group-count { flex: none; font-size: var(--type-meta-size); color: var(--ui-fm-muted); font-variant-numeric: tabular-nums; }
.ui-fm__group-picked { flex: none; margin-left: auto; white-space: nowrap; font-size: var(--type-meta-size); color: var(--ui-fm-ink); font-weight: 600; }

.ui-fm__panel {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 200ms var(--ui-fm-ease);
}
.ui-fm__group[data-open] .ui-fm__panel { grid-template-rows: 1fr; }
.ui-fm__panel-inner {
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 0;
  padding: 0;
  opacity: 0;
  transition: opacity 200ms ease-out, padding 200ms var(--ui-fm-ease);
}
.ui-fm__group[data-open] .ui-fm__panel-inner { opacity: 1; padding: 0 0 var(--space-2); }
/* A long list scrolls inside the open group, so the card keeps a sane height */
.ui-fm__group[data-open] .ui-fm__panel-inner { max-height: calc(var(--row) * 6); overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }

.ui-fm__option {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: calc(100% + var(--space-3));
  min-height: 44px;
  margin: 0 calc(var(--space-2) * -0.75) !important;
  padding: 0 var(--space-2);
  border: 0;
  border-radius: var(--radius-md);
  background: none;
  font-size: var(--type-table-size);
  color: var(--ui-fm-text) !important;
  text-align: left;
  transition: background-color 200ms ease-out;
}
.ui-fm__option-label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: start; }
.ui-fm__option:hover { background: var(--ui-fm-row-hover); }
.ui-fm__option[aria-checked="true"] { color: var(--ui-fm-ink) !important; font-weight: 600; }
.ui-fm__option:focus-visible { outline-offset: -3px; }
.ui-fm__box {
  display: grid;
  place-items: center;
  width: calc(var(--space-5) - var(--space-1));
  height: calc(var(--space-5) - var(--space-1));
  flex: none;
  border-radius: calc(var(--radius-sm) / 2);
  background: var(--ui-fm-box);
  box-shadow: inset 0 0 0 1px var(--ui-fm-box-line);
  transition: background-color 200ms ease-out, box-shadow 200ms ease-out;
}
.ui-fm__box svg {
  width: var(--space-4);
  height: var(--space-4);
  fill: none;
  stroke: var(--ui-fm-check);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 20;
  stroke-dashoffset: 20;
  transition: stroke-dashoffset 200ms var(--ui-fm-ease);
}
.ui-fm__option[aria-checked="true"] .ui-fm__box { background: var(--ui-fm-ink); box-shadow: inset 0 0 0 1px var(--ui-fm-ink); }
.ui-fm__option[aria-checked="true"] .ui-fm__box svg { stroke-dashoffset: 0; }

/* ---------- Keyboard hints on the tray ---------- */

.ui-fm__hints { display: flex; justify-content: space-between; gap: var(--space-3); padding: var(--space-2) var(--space-2) var(--space-1); }
.ui-fm__hint { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--type-label-size); color: var(--ui-fm-muted); }
.ui-fm__hint kbd {
  display: grid;
  place-items: center;
  width: var(--space-5);
  height: var(--space-5);
  border-radius: calc(var(--radius-sm) / 2);
  background: var(--ui-fm-kbd);
  box-shadow: 0 0 0 1px var(--ui-fm-card-line);
}
.ui-fm__hint kbd:last-of-type { margin-right: var(--space-1); }
.ui-fm__hint svg { width: var(--space-4); height: var(--space-4); fill: none; stroke: var(--ui-fm-text); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

@keyframes ui-fm-chip-in { from { opacity: 0; transform: scale(0.94); } }

/* Reduced motion: groups and chips snap, nothing glides or draws */
@media (prefers-reduced-motion: reduce) {
  .ui-fm, .ui-fm *, .ui-fm *::before, .ui-fm *::after { animation: none !important; transition: none !important; }
}
`;
