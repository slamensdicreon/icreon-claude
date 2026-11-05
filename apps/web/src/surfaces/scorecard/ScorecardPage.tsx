import type { Scorecard } from '@lw/contracts';
import { usd } from '../../lib/fmt';
import { Mode } from '../../mode/Mode';
import { useProjectResource } from '../../state';
import { Kpi, Panel, SectionHeading } from '../../ui/cypher/parts';
import s from './scorecard.module.css';

const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n)}%`);
const human = (k: string) => (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_/g, ' ');
const tok = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

/** Scorecard, in both faces: three numbers in Bliss; the tables behind them in Everything. */
export function ScorecardPage() {
  const sc = useProjectResource<Scorecard>('/scorecard').data;
  if (!sc) return <p className="type-body">Reading the scorecard…</p>;
  return <Mode bliss={<ScoreBliss sc={sc} />} everything={<ScoreEverything sc={sc} />} />;
}

function ScoreBliss({ sc }: { sc: Scorecard }) {
  const t = sc.totals;
  const numbers: [string, string, string][] = [
    [
      pct(t.settledWithoutDirectorPct),
      'settled without you',
      `${t.settledWithoutDirector} of ${t.cards} cards`,
    ],
    [t.cardsPerTask.toFixed(2), 'cards per task', `${t.cards} cards across ${t.tasks} tasks`],
    [pct(t.recommendedTakenPct), 'of recommendations taken', 'when a card came with one'],
  ];
  return (
    <div className={s.bliss}>
      <section className={s.three} aria-label="Three numbers">
        {numbers.map(([value, label, note]) => (
          <div key={label} className={s.big}>
            <span className={s.bigValue}>{value}</span>
            <span className="type-card-title">{label}</span>
            <span className={`${s.note} type-meta`}>{note}</span>
          </div>
        ))}
      </section>
      {sc.repeats.length > 0 && (
        <section className={s.section} aria-label="What kept coming back">
          <SectionHeading>What kept coming back</SectionHeading>
          <ul className={s.list}>
            {sc.repeats.slice(0, 5).map((r) => (
              <li key={`${r.category}-${r.title}`} className={s.listRow}>
                <span className={s.grow}>{r.title}</span>
                <span className="type-meta">
                  {human(r.category)} · {r.count} times
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ScoreEverything({ sc }: { sc: Scorecard }) {
  const t = sc.totals;
  return (
    <div className={s.everything}>
      <section className={s.kpis} aria-label="Key numbers">
        <Kpi
          label="Cards per task"
          value={t.cardsPerTask.toFixed(2)}
          note={`${t.cards} cards, ${t.tasks} tasks`}
        />
        <Kpi
          label="Settled without you"
          value={pct(t.settledWithoutDirectorPct)}
          note={`${t.settledWithoutDirector} of ${t.cards}`}
        />
        <Kpi
          label="Recommendations taken"
          value={pct(t.recommendedTakenPct)}
          note="Of cards that had one"
        />
        <Kpi
          label="Sent back"
          value={pct(t.rejectionRate === null ? null : t.rejectionRate * 100)}
          note={`${t.rejections} of ${t.reviews} reviews · ${tok(t.tokens)} tokens · ${usd(t.usd)}`}
        />
      </section>

      <Panel title="By category" meta="Who settled each kind of card">
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>Category</th>
                <th className={s.num}>Raised</th>
                <th className={s.num}>Open</th>
                <th className={s.num}>You</th>
                <th className={s.num}>Leads and rules</th>
                <th className={s.num}>Default</th>
                <th className={s.num}>Recommendation taken</th>
              </tr>
            </thead>
            <tbody>
              {sc.categories.map((c) => (
                <tr key={c.category}>
                  <td>{human(c.category)}</td>
                  <td className={s.num}>{c.raised}</td>
                  <td className={s.num}>{c.open}</td>
                  <td className={s.num}>{c.settled.director ?? 0}</td>
                  <td className={s.num}>{(c.settled.lead ?? 0) + (c.settled.rule ?? 0)}</td>
                  <td className={s.num}>{c.settled.default ?? 0}</td>
                  <td className={s.num}>
                    {c.withRecommendation
                      ? `${c.recommendedTaken} of ${c.withRecommendation}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="By phase" meta="Tasks, cards, reviews, waits and spend">
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>Phase</th>
                <th className={s.num}>Tasks</th>
                <th className={s.num}>Cards</th>
                <th className={s.num}>Reviews</th>
                <th className={s.num}>Sent back</th>
                <th className={s.num}>Waits</th>
                <th className={s.num}>Re-runs</th>
                <th className={s.num}>Tokens</th>
              </tr>
            </thead>
            <tbody>
              {sc.phases.map((p) => (
                <tr key={p.phase}>
                  <td>
                    <span className={s.quiet}>{p.phase}</span> {p.name}
                  </td>
                  <td className={s.num}>
                    {p.done} of {p.tasks}
                  </td>
                  <td className={s.num}>{p.cards}</td>
                  <td className={s.num}>{p.reviews}</td>
                  <td className={s.num}>{p.rejections}</td>
                  <td className={s.num}>{p.waits}</td>
                  <td className={s.num}>{p.reruns}</td>
                  <td className={s.num}>{tok(p.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {sc.repeats.length > 0 && (
        <Panel title="Kept coming back" meta="Cards with the same cause">
          {sc.repeats.map((r) => (
            <div key={`${r.category}-${r.title}`} className={`${s.row} type-table`}>
              <span className={s.grow}>{r.title}</span>
              <span className={s.quiet}>{human(r.category)}</span>
              <b>{r.count}</b>
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}
