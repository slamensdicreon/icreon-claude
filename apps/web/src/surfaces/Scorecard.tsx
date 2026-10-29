import {
  DECISION_CATEGORY_LABEL,
  type PlaybookScorecard,
  type Scorecard as ScorecardData,
  type ScorecardTotals,
} from '@lw/contracts';
import { usd } from '../lib/fmt';
import { Icon } from '../lib/icons';
import { useProjectResource } from '../state';

const num = (n: number) => n.toLocaleString('en-US');
const pctOf = (n: number | null) => (n === null ? '–' : `${n}%`);
const tokensM = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : num(n));

function Tile({
  icon,
  label,
  value,
  note,
}: {
  icon: string;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="statcard sc-tile">
      <div className="k">
        <Icon name={icon} sm />
        {label}
      </div>
      <div className="v">{value}</div>
      <div className="d">{note}</div>
    </div>
  );
}

/** The headline numbers, as tiles: the same four on Mission Control and here. */
export function ScoreTiles({ t }: { t: ScorecardTotals }) {
  return (
    <div className="statgrid">
      <Tile
        icon="notification"
        label="Cards per task"
        value={String(t.cardsPerTask)}
        note={`${num(t.cards)} cards over ${num(t.tasks)} tasks`}
      />
      <Tile
        icon="task--complete"
        label="Settled without you"
        value={`${t.settledWithoutDirectorPct}%`}
        note={`${num(t.settledWithoutDirector)} by default, Cypher, a Lead or a rule`}
      />
      <Tile
        icon="checkmark"
        label="Recommendation taken"
        value={pctOf(t.recommendedTakenPct)}
        note="Of settled cards that had a recommended option"
      />
      <Tile
        icon="warning"
        label="Lead rejections"
        value={pctOf(t.rejectionRate)}
        note={`${num(t.rejections)} of ${num(t.reviews)} reviews`}
      />
    </div>
  );
}

/**
 * How the project's work went, from its event log: what the Director was asked and who settled
 * it, how often Leads sent work back, what kept coming back, and what it cost. Every later
 * improvement (Lead triage, rules, facts, knowledge) is measured here.
 */
export function Scorecard() {
  const { data: card, error } = useProjectResource<ScorecardData>('/scorecard');
  if (error && !card)
    return <p className="quiet-line">The scorecard could not be loaded: {error.message}</p>;
  if (!card) return <p className="quiet-line">Loading the scorecard…</p>;
  const t = card.totals;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Scorecard</h1>
          <p>
            How the work went, counted from the project’s log: what you were asked, who settled it,
            how often Leads sent work back, and what it cost.
          </p>
        </div>
      </div>
      <ScoreTiles t={t} />
      <div className="sc-facts">
        <span>
          <strong>{num(t.done)}</strong> of {num(t.tasks)} tasks done
        </span>
        <span>
          <strong>{num(t.repeats)}</strong> repeated cards
        </span>
        <span>
          <strong>{num(t.waits)}</strong> waits
        </span>
        <span>
          <strong>{num(t.reruns)}</strong> re-runs
        </span>
        <span>
          <strong>{num(t.capabilityGaps)}</strong> capability gaps
        </span>
        <span>
          <strong>{usd(t.usd)}</strong> spent, {tokensM(t.tokens)} tokens
        </span>
        {t.elapsedHours !== null && (
          <span>
            <strong>
              {t.elapsedHours < 48
                ? `${t.elapsedHours} h`
                : `${Math.round(t.elapsedHours / 24)} days`}
            </strong>{' '}
            elapsed
          </span>
        )}
      </div>

      <section className="panel">
        <h2>
          What you were asked <small>by category</small>
        </h2>
        <div className="sc-scroll">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Cards</th>
                <th className="num">You</th>
                <th className="num">Default</th>
                <th className="num">Cypher</th>
                <th className="num">Lead</th>
                <th className="num">Rule</th>
                <th className="num">Open</th>
                <th className="num">Recommendation taken</th>
                <th className="num">Lead agreed (shadow)</th>
              </tr>
            </thead>
            <tbody>
              {[...card.categories]
                .sort((a, b) => b.raised - a.raised)
                .map((c) => (
                  <tr key={c.category}>
                    <td>{DECISION_CATEGORY_LABEL[c.category]}</td>
                    <td className="num tnum">{num(c.raised)}</td>
                    <td className="num tnum">{num(c.settled.director)}</td>
                    <td className="num tnum">{num(c.settled.default)}</td>
                    <td className="num tnum">{num(c.settled.chief_of_staff)}</td>
                    <td className="num tnum">{num(c.settled.lead)}</td>
                    <td className="num tnum">{num(c.settled.rule)}</td>
                    <td className="num tnum">{num(c.open)}</td>
                    <td className="num tnum">
                      {c.withRecommendation
                        ? `${Math.round((c.recommendedTaken / c.withRecommendation) * 100)}%`
                        : '–'}
                    </td>
                    <td className="num tnum">
                      {c.shadowAnswered
                        ? `${Math.round((c.shadowAgreed / c.shadowAnswered) * 100)}% of ${c.shadowAnswered}`
                        : '–'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h2>
          By phase <small>work tasks</small>
        </h2>
        <div className="sc-scroll">
          <table>
            <thead>
              <tr>
                <th>Phase</th>
                <th className="num">Tasks</th>
                <th className="num">Done</th>
                <th className="num">Cards</th>
                <th className="num">Reviews</th>
                <th className="num">Rejected</th>
                <th className="num">Waits</th>
                <th className="num">Re-runs</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {card.phases.map((p) => (
                <tr key={p.phase}>
                  <td>
                    {p.phase}. {p.name}
                  </td>
                  <td className="num tnum">{num(p.tasks)}</td>
                  <td className="num tnum">{num(p.done)}</td>
                  <td className="num tnum">{num(p.cards)}</td>
                  <td className="num tnum">{num(p.reviews)}</td>
                  <td className="num tnum">{num(p.rejections)}</td>
                  <td className="num tnum">{num(p.waits)}</td>
                  <td className="num tnum">{num(p.reruns)}</td>
                  <td className="num tnum">{tokensM(p.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {card.repeats.length > 0 && (
        <section className="panel">
          <h2>
            What kept coming back <small>same cause, more than one card</small>
          </h2>
          <ul className="sc-repeats">
            {card.repeats.map((r) => (
              <li key={`${r.category}-${r.title}`}>
                <span className="sc-count tnum">{num(r.count)}×</span>
                <span>
                  {r.title}
                  <small>{DECISION_CATEGORY_LABEL[r.category]}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** Projects on one playbook side by side, newest first: the next site against the last. */
export function PlaybookComparison({ data }: { data: PlaybookScorecard }) {
  if (!data.projects.length) return null;
  return (
    <div className="sc-scroll">
      <table>
        <thead>
          <tr>
            <th>Project</th>
            <th className="num">Cards per task</th>
            <th className="num">Settled without you</th>
            <th className="num">Recommendation taken</th>
            <th className="num">Lead rejections</th>
            <th className="num">Repeats</th>
            <th className="num">Spent</th>
          </tr>
        </thead>
        <tbody>
          {data.projects.map((p) => (
            <tr key={p.projectId}>
              <td>
                {p.name}
                {p.version && <small className="muted"> v{p.version}</small>}
              </td>
              <td className="num tnum">{p.totals.cardsPerTask}</td>
              <td className="num tnum">{p.totals.settledWithoutDirectorPct}%</td>
              <td className="num tnum">{pctOf(p.totals.recommendedTakenPct)}</td>
              <td className="num tnum">{pctOf(p.totals.rejectionRate)}</td>
              <td className="num tnum">{num(p.totals.repeats)}</td>
              <td className="num tnum">{usd(p.totals.usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
