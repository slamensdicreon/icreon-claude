/*
 * Cypher's form controls, shared by Settings, New project and the admin pages: a labelled field
 * with its hint and error, text inputs, text areas, selects, switches, checkboxes and radio tiles.
 * Every control has a visible label or an accessible name (design system §12); nothing tappable
 * is under 44px; every color, size and radius is a token.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from '../../theme/icons';
import s from './forms.module.css';

/** A label above a control, with an optional hint under it and an error in place of the hint. */
export function Field({
  label,
  hint,
  error,
  children,
  optional,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  /** The control, given the ids it should carry. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={s.field}>
      <label htmlFor={id} className={`${s.label} type-label`}>
        {label}
        {optional && <span className={s.optional}> optional</span>}
      </label>
      {children({ id, describedBy: note ? noteId : undefined, invalid: !!error })}
      {note && (
        <span id={noteId} className={`${s.note} type-meta`} data-error={error ? true : undefined}>
          {note}
        </span>
      )}
    </div>
  );
}

type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'>;
export function TextInput(props: InputProps & { invalid?: boolean }) {
  const { invalid, ...rest } = props;
  return (
    <input {...rest} className={`${s.input} type-body-small`} aria-invalid={invalid || undefined} />
  );
}

type AreaProps = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>;
export function TextArea(props: AreaProps & { invalid?: boolean }) {
  const { invalid, ...rest } = props;
  return (
    <textarea
      {...rest}
      className={`${s.input} ${s.area} type-body-small`}
      aria-invalid={invalid || undefined}
    />
  );
}

type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'className'>;
export function Select(props: SelectProps & { invalid?: boolean }) {
  const { invalid, children, ...rest } = props;
  return (
    <span className={s.selectWrap}>
      <select
        {...rest}
        className={`${s.input} ${s.select} type-body-small`}
        aria-invalid={invalid || undefined}
      >
        {children}
      </select>
      <Icon name="chevron" size={18} className={s.selectChev} />
    </span>
  );
}

/** An on/off switch with its words beside it. */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={s.toggleRow}>
      <span className={s.toggleText}>
        <span id={`${id}-l`} className={s.toggleLabel}>
          {label}
        </span>
        {hint && <span className={`${s.note} type-meta`}>{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        className={s.switch}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <i aria-hidden="true" />
      </button>
    </div>
  );
}

export function Checkbox({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={s.check} data-disabled={disabled || undefined}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={s.box} aria-hidden="true">
        {checked && <Icon name="check" size={16} />}
      </span>
      <span className={s.toggleText}>
        <span className={s.toggleLabel}>{label}</span>
        {hint && <span className={`${s.note} type-meta`}>{hint}</span>}
      </span>
    </label>
  );
}

export interface Tile<T extends string> {
  value: T;
  title: string;
  /** The line under the title. */
  body?: ReactNode;
  /** A small caps label above the title ("SITECOREAI · HEADLESS CMS"). */
  eyebrow?: string;
  /** Shown on the tile's corner ("Coming soon"). */
  tag?: string;
  disabled?: boolean;
  /** A note at the foot of the tile ("2 playbooks ready · 12 coming"). */
  foot?: ReactNode;
}

/**
 * A choice among large tiles: a radiogroup, arrow keys move and choose, the chosen tile is ink-
 * bordered. Disabled tiles (the roadmap) stay visible so the catalog reads as a whole.
 */
export function RadioTiles<T extends string>({
  label,
  value,
  options,
  onChange,
  columns = 2,
}: {
  label: string;
  value: T | null;
  options: Tile<T>[];
  onChange: (v: T) => void;
  columns?: 1 | 2 | 3;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const current = options.findIndex((o) => o.value === value);
  const focusable = current >= 0 ? current : (enabled[0] ?? 0);
  const onKey = (e: KeyboardEvent, i: number) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step || !enabled.length) return;
    e.preventDefault();
    const at = enabled.indexOf(i);
    const next = enabled[(at + step + enabled.length) % enabled.length]!;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className={s.tiles} data-columns={columns}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-disabled={o.disabled || undefined}
          tabIndex={i === focusable ? 0 : -1}
          className={s.tile}
          onClick={() => !o.disabled && onChange(o.value)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <span className={s.tileTop}>
            {o.eyebrow && <span className={`${s.eyebrow} type-label`}>{o.eyebrow}</span>}
            {o.tag && <span className={`${s.tag} type-meta`}>{o.tag}</span>}
          </span>
          <span className="type-card-title">{o.title}</span>
          {o.body && <span className={`${s.tileBody} type-body-small`}>{o.body}</span>}
          {o.foot && <span className={`${s.tileFoot} type-meta`}>{o.foot}</span>}
        </button>
      ))}
    </div>
  );
}

/** A row of a definition list: a key and its value, as Settings and the review step show facts. */
export function Facts({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className={s.facts}>
      {rows.map(([k, v], i) => (
        <div key={i} className={s.factRow}>
          <dt className="type-meta">{k}</dt>
          <dd className="type-body-small">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A status word with a dot, colored by meaning: ok green, waiting gold, bad coral, idle quiet. */
export function Status({
  tone,
  children,
}: {
  tone: 'ok' | 'waiting' | 'bad' | 'idle';
  children: ReactNode;
}) {
  return (
    <span className={`${s.status} type-meta`} data-tone={tone}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}
