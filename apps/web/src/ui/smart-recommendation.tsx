/*
 * Restyled to the Cypher Design System tokens (docs/redesign/cypher-handoff/design-system).
 * Original: affectUI Smart Recommendation, see git history.
 *
 * In Cypher this is the base of the Yours card: a surface card on radius-xl with shadow-card, Cypher's
 * recommendation in a surface-quiet well, the pick as the ink primary button, the alternative in surface.
 */
'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/*
 * Smart Recommendation – a suggestion card with a confidence signal, alternatives and one-click accept, in a single
 * self-contained file. Fold it away, pick an alternative instead, accept and undo.
 * The styles are injected below, so no extra files are needed.
 */

export type Recommendation = {
  id: string;
  /** Short name, used in the accept button, e.g. "Incremental sync" */
  label: string;
  /** One sentence why – shown in the card */
  reason: ReactNode;
  /** 0 = no signal, 1 = weak, 2 = good, 3 = strong */
  signal: 0 | 1 | 2 | 3;
};

export type SmartRecommendationProps = {
  title?: string;
  /** First entry is the recommendation, the rest are offered as alternatives */
  options: Recommendation[];
  onAccept?: (option: Recommendation) => void;
  onUndo?: (option: Recommendation) => void;
  defaultOpen?: boolean;
  className?: string;
};

const signalText = ['No signal', 'Weak signal', 'Good signal', 'Strong signal'];
/** Any signal outside 0–3 (NaN, "3", 7, -1) is read as the nearest valid level, NaN as no signal */
const level = (s: unknown): 0 | 1 | 2 | 3 => {
  const n = Math.round(Number(s));
  return (Number.isFinite(n) ? Math.min(3, Math.max(0, n)) : 0) as 0 | 1 | 2 | 3;
};
/** "Incremental sync" → "incremental sync", but "AWS backup" and "S3 sync" keep their capitals */
const lowerFirst = (s: string) =>
  /^\p{Lu}\p{Ll}/u.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;

export function SmartRecommendation({
  title = 'Smart recommendation',
  options,
  onAccept,
  onUndo,
  defaultOpen = true,
  className,
}: SmartRecommendationProps) {
  // By position, so two options with the same id stay apart
  const [chosen, setChosen] = useState(0);
  const [accepted, setAccepted] = useState<number | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // When the button sits at the start of its row (long labels push the actions onto their own row), the menu opens
  // to the right instead of past the card's left edge
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    const alt = menuRef.current;
    const pop = alt?.querySelector<HTMLElement>('.ui-sr__menu');
    const card = alt?.closest<HTMLElement>('.ui-sr');
    if (!menu || !alt || !pop || !card || getComputedStyle(alt).position === 'static')
      return setFlip(false);
    // Some slack: a menu that only grazes the edge (as in the demo) keeps opening to the left
    setFlip(
      alt.getBoundingClientRect().right - pop.offsetWidth < card.getBoundingClientRect().left - 24,
    );
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) =>
      !menuRef.current?.contains(e.target as Node) && setMenu(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);

  const at = chosen < options.length ? chosen : 0;
  const current = options[at];
  // Nothing to recommend – render nothing rather than crash
  if (!current) return null;
  const isRecommended = at === 0;
  const done = accepted === at;
  const signal = level(current.signal);
  const acceptText = `Accept ${lowerFirst(String(current.label))}`;

  return (
    <>
      <style href="ui-smart-recommendation" precedence="default">
        {css}
      </style>
      <section
        className={['ui-sr', className].filter(Boolean).join(' ')}
        aria-label={title}
        data-accepted={done || undefined}
      >
        <div className="ui-sr__card">
          <button
            type="button"
            className="ui-sr__head"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <SparkIcon />
            <span className="ui-sr__title" dir="auto" title={title}>
              {title}
            </span>
            {!isRecommended && <span className="ui-sr__pill">Alternative</span>}
            <span className="ui-sr__chevron">
              <Icon d="m4.5 6.25 3.5 3.5 3.5-3.5" />
            </span>
          </button>
          <div className="ui-sr__body" data-open={open || undefined} inert={!open}>
            <p className="ui-sr__reason" key={at} dir="auto">
              {current.reason}
            </p>
          </div>
        </div>

        <footer className="ui-sr__foot">
          <span className="ui-sr__signal" data-level={signal} title={signalText[signal]}>
            <span className="ui-sr__bars" aria-hidden="true">
              {[1, 2, 3].map((n) => (
                <span key={n} data-on={signal >= n || undefined} />
              ))}
            </span>
            {signalText[signal]}
          </span>

          <div className="ui-sr__actions">
            {options.length > 1 && !done && (
              <div className="ui-sr__alt" ref={menuRef}>
                <button
                  type="button"
                  className="ui-sr__btn"
                  aria-haspopup="menu"
                  aria-expanded={menu}
                  onClick={() => setMenu((m) => !m)}
                >
                  Alternatives
                </button>
                {menu && (
                  <div className="ui-sr__menu" role="menu" data-flip={flip || undefined}>
                    {options.map((o, i) => (
                      <button
                        key={`${o.id}-${i}`}
                        type="button"
                        role="menuitemradio"
                        aria-checked={i === at}
                        className="ui-sr__option"
                        onClick={() => {
                          setChosen(i);
                          setMenu(false);
                          setOpen(true);
                        }}
                      >
                        <span className="ui-sr__option-label">
                          <span className="ui-sr__option-name" dir="auto" title={o.label}>
                            {o.label}
                          </span>
                          {i === 0 && <span className="ui-sr__tag">Recommended</span>}
                        </span>
                        <span
                          className="ui-sr__mini"
                          data-level={level(o.signal)}
                          aria-label={signalText[level(o.signal)]}
                        >
                          {[1, 2, 3].map((n) => (
                            <span key={n} data-on={level(o.signal) >= n || undefined} />
                          ))}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {done ? (
              <>
                <span className="ui-sr__done" role="status">
                  <Icon d="m3.5 8.5 3 3 6-7" size={14} />
                  <span className="ui-sr__done-text" title={`${current.label} accepted`}>
                    <bdi>{current.label}</bdi> accepted
                  </span>
                </span>
                <button
                  type="button"
                  className="ui-sr__btn"
                  onClick={() => {
                    setAccepted(null);
                    onUndo?.(current);
                  }}
                >
                  Undo
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ui-sr__btn ui-sr__btn--primary"
                title={acceptText}
                onClick={() => {
                  setAccepted(at);
                  setMenu(false);
                  onAccept?.(current);
                }}
              >
                <span className="ui-sr__btn-text">{acceptText}</span>
              </button>
            )}
          </div>
        </footer>
      </section>
    </>
  );
}

const SparkIcon = () => (
  <svg
    className="ui-sr__spark"
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M9 3.5H4A1.5 1.5 0 0 0 2.5 5v7A1.5 1.5 0 0 0 4 13.5h7a1.5 1.5 0 0 0 1.5-1.5V8" />
    <path d="M12.5 1.5v4M10.5 3.5h4" />
  </svg>
);

const Icon = ({ d, size = 16 }: { d: string; size?: number }) => (
  <svg
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={d} />
  </svg>
);

/* ---------- Styles ---------- */

const css = /* css */ `
/* Cypher tokens (tokens.css): a "yours" card – surface on radius-xl with shadow-card, the recommendation in a quiet well */
.ui-sr {
  --ui-sr-tray: var(--surface);
  --ui-sr-card: var(--surface-quiet);
  --ui-sr-ink: var(--ink);
  --ui-sr-text: var(--text-2);
  --ui-sr-muted: var(--text-3);
  --ui-sr-accent: color-mix(in srgb, var(--blue) 40%, transparent);
  --ui-sr-ok: var(--green);
  --ui-sr-warn: var(--gold);
  --ui-sr-accent-text: var(--coral-text);
  --ui-sr-border: var(--mist);
  --ui-sr-shadow: var(--shadow-card);
  --ui-sr-head-hover: var(--mist-2);
  --ui-sr-pill: var(--mist-2);
  --ui-sr-pill-text: var(--text-2);
  --ui-sr-bar: var(--mist);
  --ui-sr-bar-on: var(--ink);
  --ui-sr-btn: var(--surface);
  --ui-sr-btn-hover: var(--surface-quiet);
  --ui-sr-primary: var(--ink);
  --ui-sr-primary-hover: var(--ink-2);
  --ui-sr-on-primary: var(--on-ink);
  --ui-sr-menu: var(--surface);
  --ui-sr-option-hover: var(--surface-quiet);
  --ui-sr-option-on: var(--mist-2);
  --ui-sr-tag: var(--mist-2);
  --ui-sr-tag-text: var(--text-2);
  --ui-sr-ease: ease-out;
  box-sizing: border-box;
  width: 100%;
  max-width: 440px;
  container-type: inline-size;
  background: var(--ui-sr-tray);
  padding: var(--space-5);
  border-radius: var(--radius-xl);
  box-shadow: var(--ui-sr-shadow);
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  color: var(--ui-sr-ink);
  -webkit-font-smoothing: antialiased;
}
.ui-sr *, .ui-sr *::before, .ui-sr *::after { box-sizing: border-box; }
.ui-sr button { margin: 0; font: inherit; color: inherit; cursor: pointer; }
/* Focus: 3px of blue at 40%, outside the control */
.ui-sr button:focus-visible { outline: 3px solid var(--ui-sr-accent); outline-offset: 0; }

/* Cypher's recommendation: a surface-quiet well inside the card */
.ui-sr__card {
  padding: var(--space-1) var(--space-1) var(--space-2);
  background: var(--ui-sr-card);
  border-radius: var(--radius-lg);
}
.ui-sr__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 44px;
  padding: 0 var(--space-3);
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  transition: background-color 200ms ease-out;
}
.ui-sr__head:hover { background: var(--ui-sr-head-hover); }
.ui-sr__spark { flex: none; color: var(--ui-sr-accent-text); }
/* The label row of a yours card: label style, in coral-text */
.ui-sr__title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--type-label-size);
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-sr-accent-text);
}
.ui-sr__pill {
  flex: none;
  padding: 2px var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--ui-sr-pill);
  font-size: var(--type-label-size);
  font-weight: 600;
  line-height: 18px;
  color: var(--ui-sr-pill-text);
}
.ui-sr__chevron { display: grid; margin-left: auto; color: var(--ui-sr-muted); transition: transform 200ms var(--ui-sr-ease); }
.ui-sr__head[aria-expanded="false"] .ui-sr__chevron { transform: rotate(-90deg); }
.ui-sr__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 200ms var(--ui-sr-ease);
}
.ui-sr__body[data-open] { grid-template-rows: 1fr; }
/* The verdict in body-small, text-2; the bold part in ink */
.ui-sr__reason {
  min-height: 0;
  overflow: hidden;
  margin: 0;
  padding: 0 var(--space-3);
  font-size: var(--type-body-small-size);
  line-height: 1.5;
  color: var(--ui-sr-text);
  text-align: start;
  white-space: pre-line;
  overflow-wrap: anywhere;
  animation: ui-sr-swap 200ms var(--ui-sr-ease);
}
.ui-sr__body[data-open] .ui-sr__reason { padding-bottom: var(--space-2); }
.ui-sr__reason strong { font-weight: 700; color: var(--ui-sr-ink); }

.ui-sr__foot {
  display: flex;
  align-items: center;
  /* Narrow containers: the actions move below the signal instead of running out of the card */
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
  min-height: 44px;
  margin-top: var(--space-4);
}
.ui-sr__signal {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--type-meta-size);
  line-height: 1.4;
  white-space: nowrap;
  color: var(--ui-sr-muted);
}
.ui-sr__bars, .ui-sr__mini { display: inline-flex; align-items: flex-end; gap: 2px; }
.ui-sr__bars span, .ui-sr__mini span {
  width: 3px;
  border-radius: var(--radius-pill);
  background: var(--ui-sr-bar);
  transition: background-color 200ms ease-out;
}
.ui-sr__bars span:nth-child(1), .ui-sr__mini span:nth-child(1) { height: 6px; }
.ui-sr__bars span:nth-child(2), .ui-sr__mini span:nth-child(2) { height: 9px; }
.ui-sr__bars span:nth-child(3), .ui-sr__mini span:nth-child(3) { height: 12px; }
/* Scoped to the card, so other components with data-level on the page keep their colors.
   Weak is the waiting/warning gold; good and strong are ink and differ by bar count (lightness, not hue) */
.ui-sr [data-level="1"] > span[data-on] { background: var(--ui-sr-warn); }
.ui-sr [data-level="2"] > span[data-on] { background: var(--ui-sr-bar-on); }
.ui-sr [data-level="3"] > span[data-on] { background: var(--ui-sr-bar-on); }
.ui-sr__signal[data-level="0"] .ui-sr__bars span:first-child { background: var(--ui-sr-muted); }

/* Never wider than the row – a long label shortens in its button instead of running out of the card */
.ui-sr__actions { display: flex; align-items: center; gap: var(--space-2); min-width: 0; max-width: 100%; margin-left: auto; }
.ui-sr__alt, .ui-sr__actions > .ui-sr__btn:not(.ui-sr__btn--primary) { flex: none; }
/* Buttons: pills in the button style (15px / 700), 44px tall; the alternative in surface with a mist line */
.ui-sr__btn {
  height: 44px;
  padding: 0 20px;
  border: 1px solid var(--ui-sr-border);
  border-radius: var(--radius-pill);
  background: var(--ui-sr-btn);
  font-size: var(--type-body-small-size) !important;
  font-weight: 700;
  line-height: 1.2;
  min-width: 0;
  max-width: 100%;
  white-space: nowrap;
  transition: background-color 200ms ease-out, transform 200ms ease-out;
}
.ui-sr__btn--primary { display: inline-flex; align-items: center; }
.ui-sr__btn-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-sr__btn:hover { background: var(--ui-sr-btn-hover); }
.ui-sr__btn:active { transform: scale(0.98); }
/* Cypher's pick: ink with on-ink text */
.ui-sr__btn--primary {
  border-color: var(--ui-sr-primary);
  background: var(--ui-sr-primary);
  color: var(--ui-sr-on-primary) !important;
}
.ui-sr__btn--primary:hover { border-color: var(--ui-sr-primary-hover); background: var(--ui-sr-primary-hover); }
.ui-sr__done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding-right: var(--space-1);
  font-size: var(--type-body-small-size);
  font-weight: 700;
  color: var(--ui-sr-ok);
  animation: ui-sr-swap 200ms var(--ui-sr-ease);
}

.ui-sr__alt { position: relative; }
/* The alternatives menu: a surface panel with a mist line, no shadow */
.ui-sr__menu {
  position: absolute;
  bottom: calc(100% + var(--space-2));
  right: 0;
  z-index: 5;
  display: grid;
  gap: 2px;
  /* The column never grows with a long name; a long list scrolls */
  grid-template-columns: minmax(0, 1fr);
  width: 280px;
  max-height: min(320px, 60vh);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--space-1);
  border: 1px solid var(--ui-sr-border);
  border-radius: var(--radius-lg);
  background: var(--ui-sr-menu);
  animation: ui-sr-drop 200ms var(--ui-sr-ease);
}
.ui-sr__menu[data-flip] { right: auto; left: 0; }
/* Narrow: the actions sit on their own row – the menu lines up with its right edge so it stays inside */
@container (max-width: 420px) {
  .ui-sr__actions { position: relative; }
  .ui-sr__alt { position: static; }
  .ui-sr__menu { width: min(280px, 100cqw - 24px); }
}
.ui-sr__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 44px;
  padding: 0 var(--space-3);
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  font-size: var(--type-body-small-size) !important;
  text-align: left;
}
.ui-sr__option:hover { background: var(--ui-sr-option-hover); }
.ui-sr__option[aria-checked="true"] { background: var(--ui-sr-option-on); font-weight: 700; }
.ui-sr__option-label { display: inline-flex; flex: 0 1 auto; align-items: center; gap: 6px; min-width: 0; }
.ui-sr__option-name, .ui-sr__done-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ui-sr__tag, .ui-sr__mini { flex: none; }
.ui-sr__tag { padding: 0 var(--space-2); border-radius: var(--radius-pill); background: var(--ui-sr-tag); font-size: var(--type-label-size); font-weight: 600; line-height: 20px; color: var(--ui-sr-tag-text); }

@keyframes ui-sr-swap { from { opacity: 0; transform: translateY(2px); } }
@keyframes ui-sr-drop { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
/* Reduced motion: nothing slides, folds, fades or presses */
@media (prefers-reduced-motion: reduce) {
  .ui-sr *, .ui-sr *::before, .ui-sr *::after { animation: none !important; transition: none !important; }
  .ui-sr__btn:active { transform: none; }
}
`;
