import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../theme/icons';
import s from './dashboard.module.css';

export interface FacetOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

/**
 * One facet of the projects table as a compact button ("Platform: SitecoreAI") that opens a short
 * list of choices. It stands in for a row of chips, so platform, playbook and grouping share one
 * toolbar line with the search. The button is marked while it holds anything but its first choice,
 * so a narrowed table is plain to see. Picking closes the list; so do Escape and a click elsewhere.
 */
export function Facet<T extends string>({
  label,
  value,
  options,
  onChange,
  isDefault,
}: {
  label: string;
  value: T;
  options: FacetOption<T>[];
  onChange: (v: T) => void;
  /** Whether the value is the resting one; the button shows it quietly then. */
  isDefault: boolean;
}) {
  const [open, setOpen] = useState(false);
  // On the page's top layer, fixed under its button: the panel around the table clips and
  // repositions what sits inside it.
  const [at, setAt] = useState<{ top: number; left: number; maxHeight?: number }>({
    top: 0,
    left: 0,
  });
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.value === value) ?? options[0];

  useLayoutEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !list.current?.contains(t)) setOpen(false);
    };
    // It follows its button when the page scrolls or resizes.
    // Below the button, or above it when the screen ends first; never past the right edge.
    const place = () => {
      const r = root.current?.querySelector('button')?.getBoundingClientRect();
      if (!r) return;
      const want = list.current?.scrollHeight ?? 0;
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = want > below && above > below;
      const room = Math.min(want, up ? above : below);
      setAt({
        top: up ? r.top - 4 - room : r.bottom + 4,
        left: Math.max(8, Math.min(r.left, window.innerWidth - 248)),
        maxHeight: Math.max(room, 120),
      });
    };
    place();
    document.addEventListener('pointerdown', away);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    // Into the list, on the choice that holds now.
    list.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>('button')?.focus();
      return;
    }
    if (!open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    const all = [...(list.current?.querySelectorAll<HTMLButtonElement>('[data-opt]') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? Math.min(at + 1, all.length - 1) : Math.max(at - 1, 0);
    all[next]?.focus();
  };

  return (
    <div ref={root} className={s.facet} onKeyDown={keys}>
      <button
        type="button"
        className={`${s.facetButton} type-body-small`}
        data-set={!isDefault || undefined}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={s.facetLabel}>{label}</span>
        <span className={s.facetValue}>{current?.label}</span>
        <Icon name="chevron" size={16} />
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            id={id}
            className={s.facetList}
            role="group"
            aria-label={label}
            style={at}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                data-opt=""
                className={`${s.facetOption} type-body-small`}
                aria-pressed={o.value === value}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                <span>{o.label}</span>
                {o.count !== undefined && <span className={s.facetCount}>{o.count}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
