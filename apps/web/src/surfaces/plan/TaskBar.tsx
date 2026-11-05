/*
 * A task on a timeline: a real button, placed by percentages of its track, carrying its state as
 * a glyph and in its accessible name, and the owner's team hue when it is under way.
 */
import { at, type Look } from './model';
import { Glyph } from './parts';
import s from './plan.module.css';

export function TaskBar({
  x,
  w,
  look,
  hue,
  text,
  label,
  thin,
  onOpen,
}: {
  x: number;
  w: number;
  look: Look;
  hue: string;
  text: string;
  label: string;
  thin?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className={`${s.bar} type-meta`}
      data-look={look}
      data-thin={thin || undefined}
      style={at(x, w, { '--hue': hue })}
      aria-label={label}
      title={label}
      onClick={onOpen}
    >
      <Glyph look={look} />
      <span className={s.barText}>{text}</span>
    </button>
  );
}
