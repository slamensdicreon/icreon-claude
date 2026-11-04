/*
 * Restyled to the Cypher Design System tokens (docs/redesign/cypher-handoff/design-system).
 * Original: affectUI Decision Inbox, see git history.
 *
 * In Cypher this is the Needs-you list in Everything: coral-text heading, a surface panel with a mist line,
 * ink primary and surface secondary pill buttons, green once answered.
 */
'use client';

import { useState } from 'react';

/*
 * Decision Inbox – open decisions with two quick actions each, in a gray tray with a white card, in a single self-contained file.
 * Answering a decision confirms it briefly, then folds it away and the count goes down.
 * The styles are injected below, so no extra files are needed.
 */

export type Decision = {
  id: string;
  title: string;
  /** Short context under the title */
  detail?: string;
  /** Main answer, shown as the dark button */
  primary: string;
  /** Other answer, shown as the light button */
  secondary: string;
  /** Starts folded to one muted line – click to open */
  collapsed?: boolean;
};

export type DecisionInboxProps = {
  decisions: Decision[];
  /** Called with the decision and the chosen answer */
  onDecide?: (decision: Decision, answer: 'primary' | 'secondary') => void;
  className?: string;
};

type State = { open: boolean; answered?: string; gone?: boolean };

export function DecisionInbox({ decisions, onDecide, className }: DecisionInboxProps) {
  const [state, setState] = useState<Record<string, State>>(() =>
    Object.fromEntries(decisions.map((d) => [d.id, { open: !d.collapsed }])),
  );
  // A row without state yet reads as open, the same default the render uses
  const patch = (id: string, next: Partial<State>) =>
    setState((s) => ({ ...s, [id]: { open: true, ...s[id], ...next } }));

  const open = decisions.filter((d) => !state[d.id]?.answered).length;
  // 1284 → "1,284"
  const count = new Intl.NumberFormat('en').format(open);

  const decide = (d: Decision, answer: 'primary' | 'secondary') => {
    patch(d.id, { answered: answer === 'primary' ? d.primary : d.secondary });
    onDecide?.(d, answer);
    // Show the confirmation for a moment, then fold the row away and open the next folded one
    window.setTimeout(() => {
      setState((s) => {
        const next = { ...s, [d.id]: { open: true, ...s[d.id], gone: true } };
        const folded = decisions.find(
          (x) => x.id !== d.id && !next[x.id]?.open && !next[x.id]?.answered,
        );
        if (folded) next[folded.id] = { ...next[folded.id], open: true };
        return next;
      });
    }, 1100);
  };

  return (
    <>
      <style href="ui-decision-inbox" precedence="default">
        {css}
      </style>
      <section
        className={['ui-di', className].filter(Boolean).join(' ')}
        data-clear={open === 0 || undefined}
      >
        <header className="ui-di__head" aria-live="polite">
          {open > 0 ? (
            <>
              <AlertIcon />
              <span>
                {count} {open === 1 ? 'needs' : 'need'} your input
              </span>
            </>
          ) : (
            <>
              <DoneIcon />
              <span>All caught up</span>
            </>
          )}
        </header>

        <div className="ui-di__card">
          {decisions.map((d) => {
            const s = state[d.id] ?? { open: true };
            return (
              <div key={d.id} className="ui-di__row" data-gone={s.gone || undefined} inert={s.gone}>
                <div className="ui-di__row-inner">
                  <div
                    className="ui-di__item"
                    data-open={s.open || undefined}
                    data-answered={s.answered ? true : undefined}
                  >
                    {s.open ? (
                      <p className="ui-di__title" dir="auto">
                        {d.title}
                      </p>
                    ) : (
                      <button
                        type="button"
                        className="ui-di__title ui-di__title--folded"
                        dir="auto"
                        title={d.title}
                        onClick={() => patch(d.id, { open: true })}
                      >
                        {d.title}
                      </button>
                    )}
                    <div className="ui-di__body" data-open={s.open || undefined}>
                      <div className="ui-di__body-inner">
                        {d.detail && (
                          <p className="ui-di__detail" dir="auto">
                            {d.detail}
                          </p>
                        )}
                        <div className="ui-di__actions">
                          {s.answered ? (
                            <span className="ui-di__done" role="status">
                              <DoneIcon />
                              <span dir="auto">{s.answered}</span>
                            </span>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="ui-di__btn ui-di__btn--primary"
                                dir="auto"
                                onClick={() => decide(d, 'primary')}
                              >
                                {d.primary}
                              </button>
                              <button
                                type="button"
                                className="ui-di__btn"
                                dir="auto"
                                onClick={() => decide(d, 'secondary')}
                              >
                                {d.secondary}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <p className="ui-di__empty">Nothing waiting on you – new decisions show up here.</p>
        </div>
      </section>
    </>
  );
}

/* ---------- Icons ---------- */

const AlertIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path
      d="M6.7 2.3a1.5 1.5 0 0 1 2.6 0l5.4 9.4A1.5 1.5 0 0 1 13.4 14H2.6a1.5 1.5 0 0 1-1.3-2.3Z"
      fill="currentColor"
    />
    <path
      d="M8 5.6v3.6"
      style={{ stroke: 'var(--on-ink)' }}
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <circle cx="8" cy="11.4" r="0.85" style={{ fill: 'var(--on-ink)' }} />
  </svg>
);

const DoneIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <circle cx="8" cy="8" r="7" fill="currentColor" />
    <path
      d="m5 8.2 2 2 4-4.2"
      fill="none"
      style={{ stroke: 'var(--on-ink)' }}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/* ---------- Styles ---------- */

const css = /* css */ `
/* Cypher tokens (tokens.css): a quiet tray with the heading, the surface panel inside it */
.ui-di {
  --ui-di-tray: var(--surface-quiet);
  --ui-di-card: var(--surface);
  --ui-di-border: var(--mist);
  --ui-di-line: var(--mist-2);
  --ui-di-ink: var(--ink);
  --ui-di-text: var(--text-2);
  --ui-di-muted: var(--text-3);
  --ui-di-faint: var(--text-3);
  --ui-di-alert: var(--coral-text);
  --ui-di-ok: var(--green);
  --ui-di-btn: var(--surface);
  --ui-di-btn-hover: var(--surface-quiet);
  --ui-di-primary: var(--ink);
  --ui-di-primary-hover: var(--ink-2);
  --ui-di-on-primary: var(--on-ink);
  --ui-di-focus: color-mix(in srgb, var(--blue) 40%, transparent);
  --ui-di-ease: ease-out;
  box-sizing: border-box;
  width: 100%;
  max-width: 440px;
  background: var(--ui-di-tray);
  border: 1px solid var(--ui-di-border);
  /* The tray frames the panel on every side; radius-lg outside, radius-md inside, 4px apart */
  padding: var(--space-1);
  border-radius: var(--radius-lg);
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  color: var(--ui-di-ink);
  -webkit-font-smoothing: antialiased;
}
.ui-di *, .ui-di *::before, .ui-di *::after { box-sizing: border-box; }
.ui-di button { margin: 0; font: inherit; cursor: pointer; }
/* Focus: 3px of blue at 40%, outside the control */
.ui-di button:focus-visible { outline: 3px solid var(--ui-di-focus); outline-offset: 0; }

.ui-di__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  font-size: 15px;
  font-weight: 700;
  line-height: 20px;
  color: var(--ui-di-alert);
  transition: color 200ms ease-out;
}
.ui-di[data-clear] .ui-di__head { color: var(--ui-di-ok); }

.ui-di__card {
  overflow: hidden;
  background: var(--ui-di-card);
  border: 1px solid var(--ui-di-border);
  border-radius: var(--radius-md);
}

/* Rows fold away with a height transition once answered */
.ui-di__row {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 200ms var(--ui-di-ease), opacity 200ms ease-out;
}
.ui-di__row[data-gone] { grid-template-rows: 0fr; opacity: 0; }
.ui-di__row-inner { min-height: 0; overflow: hidden; }
.ui-di__row + .ui-di__row .ui-di__item { border-top: 1px solid var(--ui-di-line); }
.ui-di__row[data-gone] + .ui-di__row .ui-di__item { border-top-color: transparent; }

.ui-di__item { padding: var(--space-4); }
.ui-di__title {
  display: block;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font-size: 15px;
  font-weight: 700;
  line-height: 1.4;
  text-align: start;
  color: var(--ui-di-ink);
  overflow-wrap: anywhere;
}
.ui-di__title--folded {
  /* Still one line however long the title – it opens in full on click */
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 400;
  color: var(--ui-di-faint);
  transition: color 200ms ease-out;
}
.ui-di__title--folded:hover { color: var(--ui-di-text); }

.ui-di__body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 200ms var(--ui-di-ease);
}
.ui-di__body[data-open] { grid-template-rows: 1fr; }
/* Room around the buttons so the clipping for the fold never cuts their focus ring */
.ui-di__body-inner {
  min-height: 0;
  overflow: hidden;
  margin: 0 -4px -4px;
  padding: 0 4px 4px;
}
/* The meta line: who, when, where */
.ui-di__detail {
  margin: var(--space-1) 0 0;
  font-size: 13.5px;
  line-height: 1.4;
  color: var(--ui-di-muted);
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.ui-di__actions {
  display: flex;
  align-items: center;
  /* Long or translated answers go on a second line instead of out of the card */
  flex-wrap: wrap;
  gap: var(--space-2);
  min-height: 44px;
  margin-top: var(--space-3);
}

/* Buttons: pills in the button style (15px / 700), 44px tall */
.ui-di__btn {
  max-width: 100%;
  min-height: 44px;
  padding: var(--space-2) 20px;
  border: 1px solid var(--ui-di-border);
  border-radius: var(--radius-pill);
  background: var(--ui-di-btn);
  font-size: 15px !important;
  font-weight: 700;
  line-height: 1.2;
  color: var(--ui-di-ink);
  overflow-wrap: anywhere;
  transition: background-color 200ms ease-out, transform 200ms ease-out;
}
.ui-di__btn:hover { background: var(--ui-di-btn-hover); }
.ui-di__btn:active { transform: scale(0.98); }
.ui-di__btn--primary {
  border-color: var(--ui-di-primary);
  background: var(--ui-di-primary);
  color: var(--ui-di-on-primary);
}
.ui-di__btn--primary:hover { border-color: var(--ui-di-primary-hover); background: var(--ui-di-primary-hover); }

.ui-di__done {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 15px;
  font-weight: 700;
  line-height: 20px;
  max-width: 100%;
  color: var(--ui-di-ok);
  overflow-wrap: anywhere;
  animation: ui-di-in 200ms var(--ui-di-ease);
}
.ui-di__done > span { min-width: 0; }

.ui-di__empty {
  display: none;
  margin: 0;
  padding: var(--space-4);
  font-size: 15px;
  line-height: 1.5;
  color: var(--ui-di-muted);
}
.ui-di[data-clear] .ui-di__empty { display: block; animation: ui-di-in 200ms var(--ui-di-ease) 200ms both; }

@keyframes ui-di-in {
  from { opacity: 0; transform: translateY(3px); }
}

/* Reduced motion: rows and bodies snap, nothing fades or presses */
@media (prefers-reduced-motion: reduce) {
  .ui-di, .ui-di *, .ui-di *::before, .ui-di *::after { animation: none !important; transition: none !important; }
  .ui-di__btn:active { transform: none; }
}
`;
