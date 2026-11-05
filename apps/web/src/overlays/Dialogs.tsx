import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useMode } from '../mode/mode';
import { useApp } from '../state';
import { Field, TextArea, TextInput } from '../ui/cypher/forms';
import s from './overlays.module.css';

export { s as overlayStyles };

const FOCUSABLE =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The dimmed layer every overlay sits on; a click outside closes it. `place` puts its card in the
 * middle (palette, dialogs), beside the nav's top or bottom (menus), or on the phone's bottom edge
 * (the sheet). Focus moves inside on open, Tab stays inside, and focus goes back where it was on
 * close; Esc is the app's (App.tsx closes the top layer).
 */
export function Scrim({
  children,
  place = 'center',
}: {
  children: ReactNode;
  place?: 'center' | 'nav-top' | 'nav-bottom' | 'sheet';
}) {
  const { closeOverlay } = useApp();
  const { mode } = useMode();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    // Leave autoFocus alone; otherwise focus the first control.
    if (el && !el.contains(document.activeElement))
      el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (before && document.contains(before)) before.focus();
    };
  }, []);
  return (
    <div
      ref={ref}
      className={s.scrim}
      data-place={place}
      data-mode={mode}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeOverlay();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Tab' || !ref.current) return;
        const all = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!all.length) return;
        const first = all[0]!;
        const last = all[all.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      {children}
    </div>
  );
}

/** Confirmation; with `typed`, the confirm button waits for that exact text. */
export function TypedConfirm({
  title,
  body,
  confirmLabel,
  typed,
  danger = true,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  typed?: string | null;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const { closeOverlay } = useApp();
  const [value, setValue] = useState('');
  const id = useId();
  const ok = !typed || value === typed;
  return (
    <Scrim>
      <div
        className={`${s.float} ${s.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
      >
        <h2 id={`${id}-t`} className="type-title">
          {title}
        </h2>
        <p className="type-body-small">{body}</p>
        {typed && (
          <Field
            label="Confirm"
            hint={
              <>
                Type <b>{typed}</b> to confirm.
              </>
            }
          >
            {({ id: fid, describedBy }) => (
              <TextInput
                id={fid}
                aria-describedby={describedBy}
                autoFocus
                autoComplete="off"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && ok && onConfirm()}
              />
            )}
          </Field>
        )}
        <div className={s.actions}>
          <button type="button" className={`${s.btn} type-button`} onClick={closeOverlay}>
            Cancel
          </button>
          <button
            type="button"
            className={`${s.btn} ${danger ? s.danger : s.primary} type-button`}
            disabled={!ok}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </Scrim>
  );
}

/** A short form in a dialog: one text field, required. */
export function TextForm({
  title,
  body,
  label,
  placeholder,
  submitLabel,
  initial = '',
  onSubmit,
}: {
  title: string;
  body: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (text: string) => void;
}) {
  const { closeOverlay } = useApp();
  const [value, setValue] = useState(initial);
  const id = useId();
  return (
    <Scrim>
      <form
        className={`${s.float} ${s.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h2 id={`${id}-t`} className="type-title">
          {title}
        </h2>
        <p className="type-body-small">{body}</p>
        <Field label={label}>
          {({ id: fid, describedBy }) => (
            <TextArea
              id={fid}
              aria-describedby={describedBy}
              autoFocus
              rows={4}
              placeholder={placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && value.trim())
                  onSubmit(value.trim());
              }}
            />
          )}
        </Field>
        <div className={s.actions}>
          <button type="button" className={`${s.btn} type-button`} onClick={closeOverlay}>
            Cancel
          </button>
          <button
            type="submit"
            className={`${s.btn} ${s.primary} type-button`}
            disabled={!value.trim()}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </Scrim>
  );
}
