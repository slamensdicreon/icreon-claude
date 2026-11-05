/*
 * Toasts: what just happened, in the corner. Each is a raised card with an icon for what kind of
 * thing it was (a check that draws itself for something done, a coral mark for something that
 * didn't go through, Cypher's eye for news), a title and a line under it, an action such as Undo,
 * and a bar that counts its time down. Hovering holds it. It springs in, and slides away on leaving.
 */
import { useEffect, useRef, useState } from 'react';
import { PENDING_DELAY, useApp, type Pending, type Toast } from '../state';
import { Icon } from '../theme/icons';
import { SmallEye } from '../ui/eye/SmallEye';
import t from './toasts.module.css';

export function Toasts() {
  const { toasts, pending } = useApp();
  return (
    <div className={t.stack} aria-live="polite" aria-relevant="additions">
      {toasts.map((x) => (
        <ToastCard key={x.id} toast={x} />
      ))}
      {pending.length > 0 && <Working pending={pending} />}
    </div>
  );
}

/**
 * The working indicator: while a command is in flight, a small pill with the eye looking about and
 * what is being done ("Approving…"). It waits a beat before it shows (PENDING_DELAY), so a quick
 * command never flickers it; the result's toast lands where it was.
 */
function Working({ pending }: { pending: Pending[] }) {
  const latest = pending[pending.length - 1]!;
  const label = pending.length > 1 ? `Working on ${pending.length} things` : latest.label;
  return (
    <div
      className={t.working}
      role="status"
      aria-label={`${label}…`}
      style={{ '--delay': `${PENDING_DELAY}ms` } as React.CSSProperties}
    >
      <SmallEye state="watching" size={22} tone="onInk" thinking lively />
      <span className="type-body-small">
        {label}
        <span className={t.dots} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </span>
      <span className={t.shimmer} aria-hidden="true" />
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const { dismissToast } = useApp();
  const [held, setHeld] = useState(false);
  // Its own clock: counts down while not hovered or focused, then leaves.
  const left = useRef(toast.duration);
  const started = useRef(performance.now());
  useEffect(() => {
    if (toast.leaving) return;
    if (held) {
      left.current -= performance.now() - started.current;
      return;
    }
    started.current = performance.now();
    const timer = window.setTimeout(() => dismissToast(toast.id), Math.max(0, left.current));
    return () => window.clearTimeout(timer);
  }, [held, toast.id, toast.leaving, dismissToast]);

  return (
    <div
      className={t.toast}
      data-tone={toast.tone}
      data-leaving={toast.leaving || undefined}
      data-held={held || undefined}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      style={{ '--life': `${toast.duration}ms` } as React.CSSProperties}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className={t.icon} aria-hidden="true">
        {toast.tone === 'done' ? (
          <svg viewBox="0 0 24 24" className={t.check}>
            <circle cx="12" cy="12" r="11" className={t.checkDisc} />
            <path d="m7 12.5 3.2 3.2L17 8.8" className={t.checkMark} />
          </svg>
        ) : toast.tone === 'error' ? (
          <svg viewBox="0 0 24 24" className={t.check}>
            <circle cx="12" cy="12" r="11" className={t.errorDisc} />
            <path d="M12 7v6M12 16.5h.01" className={t.errorMark} />
          </svg>
        ) : (
          <SmallEye state="watching" size={30} />
        )}
        {toast.tone === 'done' && <span className={t.burst} />}
      </span>
      <span className={t.text}>
        <b className="type-body-small">{toast.title}</b>
        {toast.detail && <span className={`${t.detail} type-meta`}>{toast.detail}</span>}
      </span>
      {toast.action && (
        <button
          type="button"
          className={`${t.action} type-button`}
          onClick={() => {
            toast.action!.run();
            dismissToast(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className={t.close}
        aria-label="Dismiss"
        onClick={() => dismissToast(toast.id)}
      >
        <Icon name="close" size={16} />
      </button>
      <span className={t.life} aria-hidden="true" />
    </div>
  );
}
