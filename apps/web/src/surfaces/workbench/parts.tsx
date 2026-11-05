/*
 * The Workbench's small pieces: a document's title bar, status tags, state words and quiet lines.
 * Colors carry meaning only: green done, coral-text the Director's or wrong, gold waiting, blue
 * under way (Engineering's work), text-3 for everything else.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import type { Tag as TagValue } from './model';
import s from './doc.module.css';

/** A document's title bar: title, what it is, status tags and its controls (version, links). */
export function DocHead({
  title,
  meta,
  tags,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  tags?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className={s.head} data-toc-skip="">
      <div className={s.headText}>
        <h2 className={`${s.headTitle} type-title`}>{title}</h2>
        {(meta || tags) && (
          <div className={`${s.headMeta} type-meta`}>
            {meta && <span>{meta}</span>}
            {tags}
          </div>
        )}
      </div>
      {actions && <div className={s.headActions}>{actions}</div>}
    </header>
  );
}

/** A status tag: a word in a pill with a dot that says what kind of status it is. */
export function Tag({ tag, onClick }: { tag: TagValue; onClick?: () => void }) {
  const inner = (
    <>
      <i aria-hidden="true" />
      {tag.label}
    </>
  );
  return onClick ? (
    <button type="button" className={`${s.tag} type-meta`} data-tone={tag.tone} onClick={onClick}>
      {inner}
    </button>
  ) : (
    <span className={`${s.tag} type-meta`} data-tone={tag.tone}>
      {inner}
    </span>
  );
}

export type StateTone = 'done' | 'active' | 'waiting' | 'bad' | 'quiet';

/** A document's own state words ("done", "failed", "waiting") as a tone. */
export function toneOfState(state: string): StateTone {
  const k = state.toLowerCase().replace(/[\s-]+/g, '_');
  if (['done', 'pass', 'passed', 'ok', 'success', 'merged', 'registered', 'migrated'].includes(k))
    return 'done';
  if (['active', 'running', 'validating', 'in_progress', 'open'].includes(k)) return 'active';
  if (['waiting', 'paused', 'warning', 'warn', 'review'].includes(k)) return 'waiting';
  if (['blocked', 'failed', 'fail', 'rejected', 'error', 'critical'].includes(k)) return 'bad';
  return 'quiet';
}

/** A state as a word with a dot, colored by meaning. */
export function StateWord({ tone, children }: { tone: StateTone; children: ReactNode }) {
  return (
    <span className={s.state} data-tone={tone}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

/** A quiet line: loading, empty, or why something can't be shown. */
export function Quiet({ children }: { children: ReactNode }) {
  return <p className={`${s.quiet} type-body-small`}>{children}</p>;
}

/**
 * Arrow keys between the `[data-nav]` controls inside a list (the rail, the Blueprint's rows):
 * up and down move one, Home and End jump to the ends. Tab still walks them in order.
 */
export function arrowNav(e: KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-nav]')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  e.preventDefault();
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
  items[next]?.focus();
}
