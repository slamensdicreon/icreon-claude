/*
 * Restyled to the Cypher Design System tokens (docs/redesign/cypher-handoff/design-system).
 * Original: affectUI Tool Call Card, see git history.
 *
 * In Cypher this is the Tool call row in Everything. Cypher has no monospace: the tool name and the
 * arguments/result blocks are set in the sans with tabular numerals, and JSON is told apart by weight and
 * lightness (ink / text-2 / text-3), never by team hues.
 */
'use client';

import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

/*
 * Tool Call Card – one tool call of an AI agent, in a single self-contained file.
 * A header with the tool's icon, its name in mono, a short summary and the status:
 * a spinner with a live timer, a check with the duration, or "Failed". Click it open to
 * see the arguments and the result as highlighted JSON, each with a copy button; long
 * blocks are capped with a fade and "Show all". Errors show the message and a Retry button.
 * ToolCallGroup folds several cards into one line: "Used 3 tools · 2.4s".
 * The styles are injected below, so no extra files are needed.
 */

export type ToolCallStatus = 'running' | 'success' | 'error';

export type ToolCallCardProps = {
  /** Tool name as the agent calls it, shown in bold (Cypher has no monospace) – e.g. "search_web" */
  name: string;
  /** Short human summary – e.g. "Searched the web for 'CRM pricing 2026'" */
  summary?: ReactNode;
  /** Icon in the tile on the left – defaults to a wrench */
  icon?: ReactNode;
  status: ToolCallStatus;
  /** Arguments the tool was called with – objects are pretty-printed, JSON strings parsed */
  args?: unknown;
  /** What the tool returned – objects are pretty-printed, JSON strings parsed, other text shown as is */
  result?: unknown;
  /** Error message, shown when status is "error" */
  error?: string;
  /** When the call started (ms since epoch, e.g. Date.now()) – the live timer counts from here */
  startedAt?: number;
  /** Final duration in ms – otherwise measured while the card shows "running" */
  duration?: number;
  /** Start expanded (uncontrolled) */
  defaultOpen?: boolean;
  /** Expanded state (controlled) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Opens the card when the call fails and closes it again on the next run, unless someone toggled it */
  openOnError?: boolean;
  /** Shows a Retry button next to the error */
  onRetry?: () => void;
  /** Height in px after which arguments and result are capped with a fade and "Show all" */
  maxCodeHeight?: number;
  className?: string;
};

export type ToolCallGroupProps = {
  /** ToolCallCard elements – the group reads their name, icon, status and duration */
  children: ReactNode;
  /** Label once all calls are done – defaults to "Used 3 tools" */
  label?: string;
  /** Label while any call is running */
  runningLabel?: string;
  /** Total duration in ms – otherwise the sum of the cards' durations, or the time measured while running */
  duration?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/* ---------- Card ---------- */

export function ToolCallCard({
  name,
  summary,
  icon,
  status,
  args,
  result,
  error,
  startedAt,
  duration,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  openOnError = true,
  onRetry,
  maxCodeHeight = 220,
  className,
}: ToolCallCardProps) {
  const id = useId();
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  // Open on failure, close again on the next run – only while nobody has toggled it by hand
  const [prevStatus, setPrevStatus] = useState(status);
  const [autoOpened, setAutoOpened] = useState(false);
  if (status !== prevStatus) {
    setPrevStatus(status);
    if (openProp === undefined && openOnError) {
      if (status === 'error' && !openState) {
        setOpenState(true);
        setAutoOpened(true);
      } else if (prevStatus === 'error' && autoOpened) {
        setOpenState(false);
        setAutoOpened(false);
      }
    }
  }

  const measured = useStopwatch(status === 'running', startedAt, false);
  const ms = status === 'running' ? (measured ?? 0) : (duration ?? measured);

  const announce =
    status === 'running'
      ? `${name} running`
      : status === 'success'
        ? `${name} finished`
        : `${name} failed${error ? `: ${error}` : ''}`;

  return (
    <div
      className={['ui-tc', className].filter(Boolean).join(' ')}
      data-status={status}
      data-open={open || undefined}
    >
      {/* React 19 hoists this into <head> once, no matter how many cards render */}
      <style href="ui-tool-call" precedence="default">
        {css}
      </style>
      <span className="ui-tc-sr" role="status" aria-live="polite">
        {announce}
      </span>

      <button
        type="button"
        className="ui-tc__head"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => {
          setAutoOpened(false);
          setOpen(!open);
        }}
      >
        <span className="ui-tc__icon" aria-hidden="true">
          {icon ?? <WrenchIcon />}
        </span>
        <span className="ui-tc__main">
          <code className="ui-tc__name" title={name}>
            {name}
          </code>
          {summary != null && (
            <span
              className="ui-tc__summary"
              dir="auto"
              title={typeof summary === 'string' ? summary : undefined}
            >
              {summary}
            </span>
          )}
        </span>
        <span className="ui-tc__status" key={status}>
          {status === 'running' && <Spinner />}
          {status === 'success' && (
            <svg className="ui-tc__ok" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} />
            </svg>
          )}
          {status === 'error' && <ErrorIcon />}
          <span className="ui-tc__time">
            {status === 'error' ? 'Failed' : ms != null ? formatMs(ms, status === 'running') : null}
          </span>
        </span>
        <Chevron />
      </button>

      <div className="ui-tc__body" id={`${id}-body`} inert={!open}>
        <div className="ui-tc__clip">
          <div className="ui-tc__sections">
            {status === 'error' && (
              <div className="ui-tc__error">
                <ErrorIcon />
                <p className="ui-tc__error-text" dir="auto">
                  {error ?? 'The tool call failed.'}
                </p>
                {onRetry && (
                  <button type="button" className="ui-tc__retry" onClick={onRetry}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.77" />
                      <path d="M2.5 2.5v2.75h2.75" />
                    </svg>
                    Retry
                  </button>
                )}
              </div>
            )}
            {args !== undefined && (
              <CodeSection label="Arguments" value={args} cap={maxCodeHeight} />
            )}
            {result !== undefined ? (
              <CodeSection label="Result" value={result} cap={maxCodeHeight} />
            ) : status === 'running' ? (
              <div className="ui-tc__section">
                <div className="ui-tc__section-head">
                  <span className="ui-tc__label">Result</span>
                </div>
                <p className="ui-tc__pending">Waiting for result…</p>
              </div>
            ) : null}
            {args === undefined && result === undefined && status === 'success' && (
              <p className="ui-tc__pending">No arguments or result.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Group ---------- */

export function ToolCallGroup({
  children,
  label,
  runningLabel = 'Using tools…',
  duration,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className,
}: ToolCallGroupProps) {
  const id = useId();
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;

  // Read the cards' props to summarise them in the header
  const calls = Children.toArray(children)
    .filter(isValidElement)
    .map((c) => (c as ReactElement<Partial<ToolCallCardProps>>).props);
  const running = calls.some((c) => c.status === 'running');
  const failed = calls.filter((c) => c.status === 'error').length;

  // Time spent with tools running, added up across stretches (e.g. a pause before a retry)
  // Counts from the earliest running card that knows when it started, so the group never shows less than its cards
  const since = calls.reduce<number | undefined>(
    (min, c) =>
      c.status === 'running' && c.startedAt != null && (min == null || c.startedAt < min)
        ? c.startedAt
        : min,
    undefined,
  );
  const measured = useStopwatch(running, since, true);
  const sum =
    calls.length && calls.every((c) => c.duration != null)
      ? calls.reduce((t, c) => t + (c.duration ?? 0), 0)
      : null;
  const ms = running ? measured : (duration ?? sum ?? measured);

  const count = `Used ${calls.length.toLocaleString('en-US')} ${calls.length === 1 ? 'tool' : 'tools'}`;
  const title = running ? runningLabel : (label ?? count);
  const icons = calls.slice(-3);

  return (
    <div
      className={['ui-tc-group', className].filter(Boolean).join(' ')}
      data-running={running || undefined}
      data-open={open || undefined}
    >
      <style href="ui-tool-call" precedence="default">
        {css}
      </style>
      <span className="ui-tc-sr" role="status" aria-live="polite">
        {running ? runningLabel : `${count}${failed ? `, ${failed} failed` : ''}`}
      </span>

      <button
        type="button"
        className="ui-tc-group__head"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={() => {
          if (openProp === undefined) setOpenState(!open);
          onOpenChange?.(!open);
        }}
      >
        <span className="ui-tc-group__stack" aria-hidden="true">
          {icons.map((c, i) => (
            <span className="ui-tc__icon" key={calls.length - icons.length + i}>
              {c.icon ?? <WrenchIcon />}
            </span>
          ))}
        </span>
        <span className="ui-tc-group__title" key={running ? 'busy' : 'done'}>
          <span
            className={running ? 'ui-tc-group__label ui-tc__shine' : 'ui-tc-group__label'}
            data-text={title}
          >
            {title}
          </span>
          {!running && failed > 0 && <span className="ui-tc-group__failed">· {failed} failed</span>}
          {ms != null && <span className="ui-tc-group__time">· {formatMs(ms, running)}</span>}
        </span>
        <Chevron />
      </button>

      <div className="ui-tc__body" id={`${id}-list`} inert={!open}>
        <div className="ui-tc__clip">
          <div className="ui-tc-group__list">{children}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Pieces ---------- */

const OPEN_MAX = 640;

function CodeSection({ label, value, cap }: { label: string; value: unknown; cap: number }) {
  const { text, json } = toText(value);
  const pre = useRef<HTMLPreElement>(null);
  const [full, setFull] = useState(false);
  const [height, setHeight] = useState(0);

  // Natural height of the block – decides whether it needs the cap and how far "Show all" opens
  useLayoutEffect(() => {
    const el = pre.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const measure = () => setHeight(el.scrollHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [text]);

  const capped = height > cap + 24;

  return (
    <div className="ui-tc__section">
      <div className="ui-tc__section-head">
        <span className="ui-tc__label">{label}</span>
        <CopyButton text={text} label={label.toLowerCase()} />
      </div>
      <pre
        ref={pre}
        className="ui-tc__code"
        data-capped={(capped && !full) || undefined}
        data-scroll={(capped && full && height > OPEN_MAX) || undefined}
        // Open, a very long block stops at a few screens and scrolls inside – no 200,000px card
        style={capped ? { maxHeight: full ? Math.min(height, OPEN_MAX) : cap } : undefined}
      >
        <code>{json ? highlight(text) : text}</code>
      </pre>
      {capped && (
        <button
          type="button"
          className="ui-tc__more"
          aria-expanded={full}
          onClick={() => setFull(!full)}
        >
          {full ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      className="ui-tc__copy"
      data-copied={copied || undefined}
      aria-label={copied ? 'Copied' : `Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={() => copyText(text).then((ok) => ok && setCopied(true))}
    >
      <svg className="ui-tc__copy-icon" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.25" y="5.25" width="8" height="8" rx="2" />
        <path d="M10.75 5.25v-1a1.5 1.5 0 0 0-1.5-1.5h-4.5a2 2 0 0 0-2 2v4.5a1.5 1.5 0 0 0 1.5 1.5h1" />
      </svg>
      <svg className="ui-tc__copy-done" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} />
      </svg>
    </button>
  );
}

function Spinner() {
  return (
    <svg className="ui-tc__spinner" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 2.25a5.75 5.75 0 0 1 5.75 5.75" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="ui-tc__err" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.4M8 10.9v.1" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg className="ui-tc__chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.5 6.25 8 9.75l3.5-3.5" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg viewBox="0 0 16 16">
      <path d="M10.2 2.4a3.5 3.5 0 0 0-4.3 4.6L2.6 10.3a1.4 1.4 0 0 0 2 2L7.9 9a3.5 3.5 0 0 0 4.6-4.3l-2 2-1.6-.4-.4-1.6 1.7-2.3Z" />
    </svg>
  );
}

/* ---------- Helpers ---------- */

/** Live ms while running, the final value after. accumulate = add up several running stretches. */
function useStopwatch(running: boolean, startedAt: number | undefined, accumulate: boolean) {
  const start = useRef<number | null>(null);
  const base = useRef(0);
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!running) {
      if (start.current !== null) {
        base.current += Date.now() - start.current;
        start.current = null;
        setMs(base.current);
      }
      return;
    }
    if (!accumulate) base.current = 0;
    start.current = startedAt ?? Date.now();
    const tick = () => setMs(base.current + Date.now() - (start.current ?? Date.now()));
    tick();
    const t = window.setInterval(tick, 100);
    return () => window.clearInterval(t);
  }, [running, startedAt, accumulate]);
  return ms;
}

/** 0.4s, 12.3s, 2m 05s, 3h 12m, 2d 4h – the live timer always shows tenths below a minute */
function formatMs(ms: number, live: boolean) {
  if (!live && ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function toText(value: unknown): { text: string; json: boolean } {
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return { text: JSON.stringify(JSON.parse(t), null, 2), json: true };
      } catch {
        /* not JSON – shown as plain text */
      }
    }
    return { text: value, json: false };
  }
  try {
    const s = JSON.stringify(value, null, 2);
    return s === undefined ? { text: String(value), json: false } : { text: s, json: true };
  } catch {
    return { text: String(value), json: false };
  }
}

// Strings (keys when followed by a colon), literals and numbers – everything else stays punctuation
const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(TOKEN.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] && m[2]) {
      out.push(
        <span key={m.index} className="ui-tc__t-key">
          {m[1]}
        </span>,
        m[2],
      );
    } else {
      const kind = m[1] ? 'str' : /^[tfn]/.test(m[0]) ? 'lit' : 'num';
      out.push(
        <span key={m.index} className={`ui-tc__t-${kind}`}>
          {m[0]}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure contexts
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

const css = /* css */ `
/* Cypher tokens (tokens.css): a surface panel with a mist line; one family, tabular numerals, no monospace */
.ui-tc,
.ui-tc-group {
  --ui-tc-ink: var(--ink);
  --ui-tc-text: var(--text-2);
  --ui-tc-muted: var(--text-3);
  --ui-tc-bg: var(--surface);
  --ui-tc-line: var(--mist);
  --ui-tc-hover: var(--surface-quiet);
  --ui-tc-group-hover: var(--mist-2);
  --ui-tc-tile: var(--surface-quiet);
  --ui-tc-code: var(--surface-quiet);
  --ui-tc-ring: var(--surface);
  --ui-tc-ok: var(--green);
  --ui-tc-red: var(--coral-text);
  --ui-tc-red-bg: var(--coral-tint);
  --ui-tc-red-line: color-mix(in srgb, var(--coral-text) 20%, transparent);
  --ui-tc-key: var(--ink);
  --ui-tc-str: var(--text-2);
  --ui-tc-num: var(--ink);
  --ui-tc-lit: var(--text-3);
  --ui-tc-shine: color-mix(in srgb, var(--surface) 82%, transparent);
  --ui-tc-focus: color-mix(in srgb, var(--blue) 40%, transparent);
  --ui-tc-ease: ease-out;
  --ui-tc-mono: var(--font-sans);
  box-sizing: border-box;
  min-width: 0;
  color: var(--ui-tc-text);
  font-family: var(--font-sans);
  font-size: var(--type-table-size);
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
.ui-tc *,
.ui-tc-group * { box-sizing: border-box; }

.ui-tc {
  position: relative;
  border: 1px solid var(--ui-tc-line);
  border-radius: var(--radius-lg);
  background: var(--ui-tc-bg);
}
.ui-tc-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Header: icon, name + summary, status, chevron – on row height; everything truncates before it overflows */
.ui-tc__head {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: var(--row);
  padding: var(--space-2) var(--space-4) var(--space-2) var(--space-3);
  border-radius: calc(var(--radius-lg) - 1px);
  cursor: pointer;
  transition: background-color 200ms ease-out;
}
.ui-tc[data-open] .ui-tc__head { border-radius: calc(var(--radius-lg) - 1px) calc(var(--radius-lg) - 1px) 0 0; }
/* Focus: 3px of blue at 40%, outside the control */
.ui-tc__head:focus-visible,
.ui-tc-group__head:focus-visible,
.ui-tc__copy:focus-visible,
.ui-tc__more:focus-visible,
.ui-tc__retry:focus-visible {
  outline: 3px solid var(--ui-tc-focus);
  outline-offset: 0;
}
@media (hover: hover) {
  .ui-tc__head:hover { background: var(--ui-tc-hover); }
  .ui-tc-group__head:hover { background: var(--ui-tc-group-hover); color: var(--ui-tc-ink); }
  .ui-tc__copy:hover { background: var(--ui-tc-hover); color: var(--ui-tc-ink); }
  .ui-tc__more:hover { color: var(--ui-tc-ink); }
  .ui-tc__retry:hover { background: var(--ui-tc-hover); }
}

.ui-tc__icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 32px;
  height: 32px;
  border: 1px solid var(--ui-tc-line);
  border-radius: var(--radius-sm);
  background: var(--ui-tc-tile);
  color: var(--ui-tc-ink);
}
.ui-tc__icon > svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

.ui-tc__main {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex: 1;
  min-width: 0;
}
.ui-tc__name {
  flex: 0 1 auto;
  max-width: 55%;
  overflow: hidden;
  color: var(--ui-tc-ink);
  font-family: var(--ui-tc-mono);
  font-size: var(--type-table-size);
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-tc__summary {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  color: var(--ui-tc-text);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The result word and time, in the meta style */
.ui-tc__status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  color: var(--ui-tc-muted);
  font-size: var(--type-meta-size);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  animation: ui-tc-in 200ms var(--ui-tc-ease) both;
}
.ui-tc[data-status="error"] .ui-tc__status { color: var(--ui-tc-red); font-weight: 700; }
.ui-tc__status > svg { width: 16px; height: 16px; flex: none; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.ui-tc__spinner circle { stroke: currentColor; stroke-width: 1.6; opacity: 0.22; }
.ui-tc__spinner path { stroke: var(--ui-tc-ink); stroke-width: 1.6; }
.ui-tc__spinner { animation: ui-tc-spin 800ms linear infinite; }
.ui-tc__ok { stroke: var(--ui-tc-ok); stroke-width: 1.8; }
.ui-tc__ok path { stroke-dasharray: 1; stroke-dashoffset: 1; animation: ui-tc-draw 240ms var(--ui-tc-ease) 80ms forwards; }
.ui-tc__err { stroke: var(--ui-tc-red); stroke-width: 1.6; }

.ui-tc__chevron {
  flex: none;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: var(--ui-tc-muted);
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 200ms var(--ui-tc-ease);
}
.ui-tc[data-open] > .ui-tc__head .ui-tc__chevron,
.ui-tc-group[data-open] > .ui-tc-group__head .ui-tc__chevron { transform: rotate(180deg); }

/* Body: grows from 0fr to 1fr, so the height animates without measuring */
.ui-tc__body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 200ms var(--ui-tc-ease), opacity 200ms ease-out;
}
.ui-tc[data-open] > .ui-tc__body,
.ui-tc-group[data-open] > .ui-tc__body {
  grid-template-rows: 1fr;
  opacity: 1;
}
.ui-tc__clip { min-height: 0; overflow: hidden; }
.ui-tc__sections {
  display: grid;
  gap: var(--space-3);
  padding: var(--space-4);
  border-top: 1px solid var(--ui-tc-line);
}

.ui-tc__section { display: grid; gap: var(--space-2); min-width: 0; }
.ui-tc__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  min-height: 32px;
}
/* Section labels in the label style */
.ui-tc__label { color: var(--ui-tc-muted); font-size: var(--type-label-size); font-weight: 700; line-height: 1.3; letter-spacing: 0.06em; text-transform: uppercase; }
.ui-tc__pending { margin: 0; color: var(--ui-tc-muted); font-size: var(--type-meta-size); }

.ui-tc__copy {
  all: unset;
  position: relative;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-pill);
  color: var(--ui-tc-muted);
  cursor: pointer;
  transition: background-color 200ms ease-out, color 200ms ease-out;
}
.ui-tc__copy svg {
  position: absolute;
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: opacity 200ms ease-out, transform 200ms var(--ui-tc-ease), filter 200ms ease-out;
}
.ui-tc__copy-done { opacity: 0; transform: scale(0.6); filter: blur(2px); stroke-width: 1.8; }
.ui-tc__copy[data-copied] { color: var(--ui-tc-ok); }
.ui-tc__copy[data-copied] .ui-tc__copy-icon { opacity: 0; transform: scale(0.6); filter: blur(2px); }
.ui-tc__copy[data-copied] .ui-tc__copy-done { opacity: 1; transform: none; filter: none; }

/* Code: a surface-quiet well; wraps instead of scrolling sideways; capped blocks fade out at the bottom */
.ui-tc__code {
  position: relative;
  margin: 0;
  padding: var(--space-3);
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--ui-tc-code);
  color: var(--ui-tc-muted);
  font-family: var(--ui-tc-mono);
  font-size: var(--type-meta-size);
  line-height: 1.6;
  font-variant-numeric: tabular-nums;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
  transition: max-height 200ms var(--ui-tc-ease);
}
.ui-tc__code code { display: block; font: inherit; }
.ui-tc__code::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 56px;
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  background: linear-gradient(to bottom, transparent, var(--ui-tc-code));
  opacity: 0;
  transition: opacity 200ms ease-out;
  pointer-events: none;
}
.ui-tc__code[data-capped]::after { opacity: 1; }
.ui-tc__code[data-scroll] { overflow-y: auto; overscroll-behavior: contain; }
.ui-tc__t-key { color: var(--ui-tc-key); font-weight: 600; }
.ui-tc__t-str { color: var(--ui-tc-str); }
.ui-tc__t-num { color: var(--ui-tc-num); }
.ui-tc__t-lit { color: var(--ui-tc-lit); font-weight: 600; }

.ui-tc__more {
  all: unset;
  justify-self: start;
  padding: 2px var(--space-1);
  margin-left: calc(var(--space-1) * -1);
  border-radius: var(--radius-sm);
  color: var(--ui-tc-text);
  font-size: var(--type-meta-size);
  font-weight: 700;
  cursor: pointer;
  transition: color 200ms ease-out;
}

/* Error: the message and an optional retry, in a coral-tint well */
.ui-tc__error {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--ui-tc-red-line);
  border-radius: var(--radius-md);
  background: var(--ui-tc-red-bg);
}
.ui-tc__error > .ui-tc__err { flex: none; width: 16px; height: 16px; margin-top: 2px; fill: none; stroke-linecap: round; }
.ui-tc__error-text {
  flex: 1;
  min-width: 0;
  max-height: 200px;
  margin: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  white-space: pre-line;
  color: var(--ui-tc-red);
  font-size: var(--type-table-size);
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.ui-tc__retry {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  align-self: center;
  height: 44px;
  padding: 0 var(--space-4) 0 var(--space-3);
  border: 1px solid var(--ui-tc-line);
  border-radius: var(--radius-pill);
  background: var(--ui-tc-bg);
  color: var(--ui-tc-ink);
  font-size: var(--type-body-small-size);
  font-weight: 700;
  cursor: pointer;
  transition: background-color 200ms ease-out;
}
.ui-tc__retry svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.ui-tc__retry:active svg { transform: rotate(-60deg); transition: transform 200ms var(--ui-tc-ease); }

/* Group: one quiet line with the tool icons stacked, the cards below */
.ui-tc-group { display: grid; }
.ui-tc-group__head {
  all: unset;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  justify-self: start;
  max-width: 100%;
  min-height: 44px;
  padding: var(--space-1) var(--space-3) var(--space-1) 6px;
  border-radius: var(--radius-pill);
  color: var(--ui-tc-text);
  cursor: pointer;
  transition: background-color 200ms ease-out, color 200ms ease-out;
}
.ui-tc-group__stack { display: flex; flex: none; }
/* The ring that separates stacked tiles is an outline in the ground color, not a shadow */
.ui-tc-group__stack .ui-tc__icon {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  outline: 2px solid var(--ui-tc-ring);
  animation: ui-tc-pop 200ms var(--ui-tc-ease) both;
}
.ui-tc-group__stack .ui-tc__icon + .ui-tc__icon { margin-left: -6px; }
.ui-tc-group__stack .ui-tc__icon > svg { width: 16px; height: 16px; }
.ui-tc-group__title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
  animation: ui-tc-in 200ms var(--ui-tc-ease) both;
}
.ui-tc-group__label {
  position: relative;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: inherit;
  font-weight: 700;
}
.ui-tc-group__failed { flex: none; color: var(--ui-tc-red); font-weight: 700; }
.ui-tc-group__time { flex: none; color: var(--ui-tc-muted); font-variant-numeric: tabular-nums; }
.ui-tc-group__list { display: grid; gap: var(--space-2); padding-top: var(--space-2); }

/* A soft light sweeping over "Using tools…" */
.ui-tc__shine::after {
  content: attr(data-text);
  content: attr(data-text) / "";
  position: absolute;
  inset: 0;
  white-space: nowrap;
  color: transparent;
  background: linear-gradient(90deg, transparent 38%, var(--ui-tc-shine) 50%, transparent 62%) 100% 0 / 300% 100% no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  animation: ui-tc-sweep 1.8s linear infinite;
  pointer-events: none;
}

@keyframes ui-tc-in {
  from { opacity: 0; transform: translateY(3px); filter: blur(2px); }
  to { opacity: 1; transform: none; filter: none; }
}
@keyframes ui-tc-pop {
  from { opacity: 0; transform: scale(0.6); }
  to { opacity: 1; transform: none; }
}
@keyframes ui-tc-spin { to { transform: rotate(360deg); } }
@keyframes ui-tc-draw { to { stroke-dashoffset: 0; } }
@keyframes ui-tc-sweep {
  from { background-position: 100% 0; }
  to { background-position: 0% 0; }
}

/* Reduced motion: nothing spins, sweeps, folds or fades; the check is simply drawn */
@media (prefers-reduced-motion: reduce) {
  .ui-tc *,
  .ui-tc-group *,
  .ui-tc *::after,
  .ui-tc-group *::after {
    animation: none !important;
    transition: none !important;
  }
  .ui-tc__shine::after { display: none; }
  .ui-tc__ok path { stroke-dashoffset: 0; }
}
`;
