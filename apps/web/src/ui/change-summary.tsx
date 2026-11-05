/*
 * Restyled to the Cypher Design System tokens (docs/redesign/cypher-handoff/design-system).
 * Original: affectUI Change Summary (MIT), https://www.affectui.com/r/change-summary.json.
 *
 * In Cypher this is "what moved": the Handled list in Bliss and, in Workbench Everything, what
 * changed in the Blueprint since the approved version. A surface-quiet tray with a mist line, the
 * surface card inside it, one row per change; green for good, coral-text for bad, text-3 neutral.
 */
'use client';

import type { ReactNode } from 'react';

/*
 * Change Summary – what moved since last time, one metric per row, in a gray tray with a white card, in a single self-contained file.
 * The styles are injected below, so no extra files are needed.
 */

export type MetricChange = {
  label: string;
  /** What happened, in words, e.g. "Up 6.1% to 18.2K" */
  change: string;
  /** good: green arrow · bad: red arrow · neutral: gray dash */
  tone?: 'good' | 'bad' | 'neutral';
  /** Direction of the arrow – defaults to up for good, down for bad */
  direction?: 'up' | 'down';
};

export type ChangeSummaryProps = {
  title?: string;
  /** Small text on the right of the heading, e.g. "This week" */
  period?: string;
  icon?: ReactNode;
  changes: MetricChange[];
  className?: string;
};

export function ChangeSummary({
  title = "What's changed",
  period,
  icon,
  changes,
  className,
}: ChangeSummaryProps) {
  return (
    <>
      <style href="ui-change-summary" precedence="default">
        {css}
      </style>
      <section className={['ui-cs', className].filter(Boolean).join(' ')} aria-label={title}>
        <header className="ui-cs__head">
          <span className="ui-cs__title">
            <span className="ui-cs__icon">{icon ?? <ChangesIcon />}</span>
            <span className="ui-cs__title-text" dir="auto" title={title}>
              {title}
            </span>
          </span>
          {period && (
            <span className="ui-cs__period" dir="auto" title={period}>
              {period}
            </span>
          )}
        </header>
        {changes.length > 0 && (
          <dl className="ui-cs__card">
            {changes.map((c, i) => {
              // Anything but good or bad reads as neutral, so the mark always has its tint
              const tone = c.tone === 'good' || c.tone === 'bad' ? c.tone : 'neutral';
              const direction = c.direction ?? (tone === 'bad' ? 'down' : 'up');
              return (
                // The stagger stops after twelve rows, so a long list is all there at once
                <div
                  key={`${i}-${c.label}`}
                  className="ui-cs__row"
                  style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                >
                  <dt className="ui-cs__label" dir="auto" title={c.label}>
                    {c.label}
                  </dt>
                  <dd className="ui-cs__change">
                    <span className="ui-cs__trend" data-tone={tone} aria-hidden="true">
                      {tone === 'neutral' ? (
                        <DashIcon />
                      ) : (
                        <ArrowIcon down={direction === 'down'} />
                      )}
                    </span>
                    <span className="ui-cs__text" dir="auto" title={c.change}>
                      {c.change}
                    </span>
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </section>
    </>
  );
}

/* ---------- Icons (the 24 grid, 1.8 stroke, round caps: design system §9) ---------- */

const ChangesIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4 6h6M4 12h12M10 18h10M14 6h2" />
  </svg>
);

const ArrowIcon = ({ down }: { down?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {down ? <path d="M12 5v14M6 13l6 6 6-6" /> : <path d="M12 19V5M6 11l6-6 6 6" />}
  </svg>
);

const DashIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M6 12h12" />
  </svg>
);

/* ---------- Styles ---------- */

const css = /* css */ `
/* Cypher tokens (tokens.css): a quiet tray with the heading, the surface card inside it */
.ui-cs {
  --ui-cs-tray: var(--surface-quiet);
  --ui-cs-card: var(--surface);
  --ui-cs-border: var(--mist);
  --ui-cs-line: var(--mist-2);
  --ui-cs-ink: var(--ink);
  --ui-cs-text: var(--text-2);
  --ui-cs-muted: var(--text-3);
  --ui-cs-hover: var(--surface-quiet);
  --ui-cs-ease: ease-out;
  box-sizing: border-box;
  width: 100%;
  container-type: inline-size;
  /* The tray frames the card on every side; radius-lg outside, radius-md inside, 4px apart */
  background: var(--ui-cs-tray);
  border: 1px solid var(--ui-cs-border);
  padding: var(--space-1);
  border-radius: var(--radius-lg);
  font-family: var(--font-sans);
  font-variant-numeric: tabular-nums;
  color: var(--ui-cs-ink);
  -webkit-font-smoothing: antialiased;
}
.ui-cs *, .ui-cs *::before, .ui-cs *::after { box-sizing: border-box; }

.ui-cs__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: calc(var(--row) - var(--space-3));
  padding: var(--space-2) var(--space-4);
  font-size: 15px;
  line-height: 1.3;
}
.ui-cs__title {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-weight: 700;
  color: var(--ui-cs-ink);
}
.ui-cs__icon { display: grid; place-items: center; flex: none; width: var(--space-5); height: var(--space-5); overflow: hidden; color: var(--ui-cs-muted); }
/* A custom icon – an image too – fits the tile */
.ui-cs__icon > :is(img, svg) { display: block; width: calc(var(--space-5) - var(--space-1)); height: calc(var(--space-5) - var(--space-1)); object-fit: contain; }
.ui-cs__title-text { min-width: 0; overflow-wrap: anywhere; }
/* The period shortens before it squeezes the title */
.ui-cs__period { flex: 0 1 auto; min-width: 0; max-width: 50%; overflow: hidden; font-size: 13.5px; font-weight: 400; white-space: nowrap; text-overflow: ellipsis; color: var(--ui-cs-muted); }

.ui-cs__card {
  margin: 0;
  overflow: hidden;
  background: var(--ui-cs-card);
  border: 1px solid var(--ui-cs-border);
  border-radius: var(--radius-md);
}
.ui-cs__row {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  align-items: center;
  gap: var(--space-4);
  min-height: calc(var(--row) - var(--space-2));
  padding: var(--space-2) var(--space-4);
  animation: ui-cs-in 200ms var(--ui-cs-ease) both;
  transition: background-color 200ms ease-out;
}
.ui-cs__row + .ui-cs__row { border-top: 1px solid var(--ui-cs-line); }
.ui-cs__row:hover { background: var(--ui-cs-hover); }
.ui-cs__label {
  overflow: hidden;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow-wrap: anywhere;
  text-align: start;
}
.ui-cs__change {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  font-size: 14.5px;
  line-height: 1.4;
  color: var(--ui-cs-text);
}
/* The change keeps its numbers: it wraps up to three lines instead of being cut off */
.ui-cs__text { display: -webkit-box; overflow: hidden; white-space: pre-line; overflow-wrap: anywhere; text-align: start; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
/* Narrow: each metric stacks above its change, so the text wraps instead of being cut off */
@container (max-width: 400px) {
  .ui-cs__row { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); padding: var(--space-3) var(--space-4); }
  .ui-cs__label { white-space: normal; }
  .ui-cs__change { align-items: flex-start; }
}
.ui-cs__trend {
  display: grid;
  place-items: center;
  flex: none;
  width: var(--space-5);
  height: var(--space-5);
  border-radius: var(--radius-pill);
}
/* Green says done, coral-text says it is the Director's or wrong, text-3 says it simply moved */
.ui-cs__trend[data-tone="good"] { background: color-mix(in srgb, var(--green) 14%, var(--surface)); color: var(--green); }
.ui-cs__trend[data-tone="bad"] { background: var(--coral-tint); color: var(--coral-text); }
.ui-cs__trend[data-tone="neutral"] { background: var(--mist-2); color: var(--ui-cs-muted); }

@keyframes ui-cs-in {
  from { opacity: 0; transform: translateY(3px); }
}
/* Reduced motion: the rows are simply there */
@media (prefers-reduced-motion: reduce) {
  .ui-cs__row { animation: none; transition: none; }
}
`;
