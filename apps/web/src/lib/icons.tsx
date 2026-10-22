import sprite from '../assets/icons.svg?raw';
import lockup from '../assets/lockup.svg?raw';
import mark from '../assets/mark.svg?raw';

/** The Carbon icon sprite from the Icreon design system, mounted once. */
export function Sprite() {
  return <div hidden dangerouslySetInnerHTML={{ __html: sprite }} />;
}

export function Icon({
  name,
  sm,
  style,
}: {
  name: string;
  sm?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <svg className={`ic${sm ? ' sm' : ''}`} aria-hidden="true" style={style}>
      <use href={`#ic-${name}`} />
    </svg>
  );
}

export function Lockup() {
  return (
    <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: lockup + mark }} />
  );
}

export const LOCKUP_SVG = lockup;
