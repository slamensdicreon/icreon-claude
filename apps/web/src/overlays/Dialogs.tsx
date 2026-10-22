import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../state';

/** The dimmed layer every overlay sits on; a click outside closes it. */
export function Scrim({
  children,
  style,
  className = '',
}: {
  children: ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  const { closeOverlay } = useApp();
  return (
    <div
      className={`scrim ${className}`}
      style={style}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeOverlay();
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
  const ok = !typed || value === typed;
  return (
    <Scrim>
      <div className="dialog" role="dialog" aria-labelledby="dlg-t">
        <h2 id="dlg-t">{title}</h2>
        <p>{body}</p>
        {typed && (
          <>
            <p>
              Type <b>{typed}</b> to confirm.
            </p>
            <input
              className="input"
              autoFocus
              style={{ width: '100%', marginBottom: 12 }}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ok && onConfirm()}
            />
          </>
        )}
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={closeOverlay}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
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
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <Scrim>
      <form
        className="dialog"
        role="dialog"
        aria-labelledby="frm-t"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <h2 id="frm-t">{title}</h2>
        <p>{body}</p>
        <label className="eyebrow" htmlFor="frm-text" style={{ display: 'block', marginBottom: 6 }}>
          {label}
        </label>
        <textarea
          id="frm-text"
          ref={ref}
          className="notes"
          style={{ marginTop: 0, marginBottom: 14, minHeight: 110 }}
          placeholder={placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && value.trim())
              onSubmit(value.trim());
          }}
        />
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={closeOverlay}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!value.trim()}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Scrim>
  );
}
