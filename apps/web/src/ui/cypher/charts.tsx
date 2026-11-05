/*
 * The Dashboard's two small charts, as inline SVG in tokens (design system §10: "charts as inline
 * SVG"). They draw only what the API measured: days still to come are dashed outlines, not guesses.
 */
import s from './charts.module.css';

export function SpendBars({
  days,
}: {
  days: { label: string; date: string; usd: number | null }[];
}) {
  const W = 500;
  const H = 96;
  const max = Math.max(1, ...days.map((d) => d.usd ?? 0));
  const slot = W / Math.max(1, days.length);
  const bw = slot * 0.62;
  const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  return (
    <figure className={s.figure}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={s.svg}
        role="img"
        aria-label={days
          .map((d) => `${d.label} ${d.usd === null ? 'to come' : usd(d.usd)}`)
          .join(', ')}
      >
        <line x1="0" y1={H - 1} x2={W} y2={H - 1} className={s.axis} />
        {days.map((d, i) => {
          const x = i * slot + (slot - bw) / 2;
          if (d.usd === null) {
            const h = H * 0.6;
            return (
              <rect
                key={d.date}
                x={x}
                y={H - h - 2}
                width={bw}
                height={h}
                rx="4"
                className={s.future}
              />
            );
          }
          const h = Math.max(3, ((H - 8) * d.usd) / max);
          return (
            <rect
              key={d.date}
              x={x}
              y={H - h - 2}
              width={bw}
              height={h}
              rx="4"
              className={s.past}
            />
          );
        })}
      </svg>
      <figcaption
        className={`${s.labels} type-meta`}
        style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
      >
        {days.map((d) => (
          <span key={d.date}>
            {d.label}
            {d.usd !== null && ` ${usd(d.usd)}`}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function EscalationLines({
  points,
  labelOf,
}: {
  points: { at: string; raised: number; settled: number }[];
  labelOf: (at: string, i: number, last: boolean) => string;
}) {
  const W = 600;
  const H = 96;
  const max = Math.max(1, ...points.map((p) => Math.max(p.raised, p.settled)));
  const x = (i: number) => (points.length < 2 ? 0 : (i * W) / (points.length - 1));
  const y = (v: number) => H - 4 - ((H - 12) * v) / max;
  const line = (k: 'raised' | 'settled') => points.map((p, i) => `${x(i)},${y(p[k])}`).join(' ');
  const area = `0,${H} ${line('raised')} ${W},${H}`;
  const ticks = points.length
    ? [0, 6, 12, 18, points.length - 1].filter((i) => i < points.length)
    : [];
  return (
    <figure className={s.figure}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={s.svg}
        preserveAspectRatio="none"
        role="img"
        aria-label="Escalations raised and settled by the leads over the last 24 hours"
      >
        <polygon points={area} className={s.area} />
        <polyline points={line('raised')} className={s.raised} />
        <polyline points={line('settled')} className={s.settled} />
      </svg>
      <figcaption className={`${s.ticks} type-meta`}>
        {ticks.map((i, n) => (
          <span key={i}>{labelOf(points[i]!.at, i, n === ticks.length - 1)}</span>
        ))}
      </figcaption>
    </figure>
  );
}

/** The legend swatch beside a series name. */
export function Swatch({ tone }: { tone: 'raised' | 'settled' }) {
  return <i aria-hidden="true" className={tone === 'raised' ? s.swRaised : s.swSettled} />;
}
