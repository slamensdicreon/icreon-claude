import type { PortfolioOverview } from '@lw/contracts';
import { age, clock } from '../../lib/fmt';
import { useApp, useNow } from '../../state';
import { clockOf, kindOf, raisedLine, useYoursActions } from '../../ui/cypher/cards';
import {
  Handled,
  Hero,
  hueOf,
  ProjectTile,
  SectionHeading,
  YoursCard,
} from '../../ui/cypher/parts';
import { useEyeState } from '../../voice/eye';
import { ago } from '../mission/model';
import s from './dashboard.module.css';

/**
 * The portfolio in Bliss (Dashboard-Bliss board): the eye and Cypher's sentence, at most three
 * things that are the Director's with Cypher's pick inside, one tile per project, and what was
 * handled without them.
 */
export function DashboardBliss({ o, refresh }: { o: PortfolioOverview; refresh: () => void }) {
  const { switchProject } = useApp();
  const eye = useEyeState();
  const now = useNow(30_000);
  const live = o.projects.filter((p) => !p.archived);
  const calm = live.every((p) => p.readTone !== 'blocked');
  const shown = o.yours.slice(0, 3);
  return (
    <div className={s.bliss}>
      <Hero eye={eye.state} blink={eye.blink} voice={o.voice} />

      {shown.length > 0 && (
        <section className={s.three} aria-label="Yours" id="yours">
          {shown.map((y) => (
            <YoursTile
              key={y.escalation.escalationId}
              y={y}
              tz={o.timezone}
              now={now}
              refresh={refresh}
            />
          ))}
        </section>
      )}
      {o.yours.length > 3 && (
        <p className={`${s.more} type-meta`}>
          {o.yours.length - 3} more wait their turn in Everything.
        </p>
      )}

      <section className={s.section} aria-label="Projects" id="projects">
        <SectionHeading>{calm ? 'Everyone else is fine.' : 'The projects'}</SectionHeading>
        <div className={s.four}>
          {live.map((p) => (
            <ProjectTile
              key={p.projectId}
              name={p.name}
              phase={p.phaseName ?? p.phaseLabel}
              percent={p.percent}
              hue={hueOf(p.hue)}
              eye={p.eye}
              read={p.read}
              tone={p.readTone}
              faces={p.faces}
              word={p.workingWord}
              yours={p.yours > 0}
              onOpen={() => switchProject(p.projectId)}
            />
          ))}
        </div>
      </section>

      {o.handled.length > 0 && (
        <section className={s.section} aria-label="Handled">
          <SectionHeading>Handled without you</SectionHeading>
          <Handled
            items={o.handled}
            timeOf={(at) => clock(at, o.timezone).replace(/\s?[AP]M$/, '')}
          />
        </section>
      )}
    </div>
  );
}

function YoursTile({
  y,
  tz,
  now,
  refresh,
}: {
  y: PortfolioOverview['yours'][number];
  tz: string;
  now: number;
  refresh: () => void;
}) {
  const x = y.escalation;
  const act = useYoursActions(y.projectId, y.project, refresh);
  const { primary, secondary } = act.cardActions(x);
  const body = firstSentences(x.context);
  return (
    <YoursCard
      kind={kindOf(x)}
      project={y.project}
      clock={clockOf(x, tz).replace(/\s?[AP]M$/, '')}
      clockYours={!!x.deadline}
      title={x.title}
      body={body}
      rec={x.recommendation ?? null}
      primary={primary}
      secondary={secondary}
      raiser={x.raisedBy ?? null}
      meta={raisedLine(x, ago(age(x.raisedAt, now)))}
    />
  );
}

/** The card's context, cut to two sentences so the card stays one glance. A sentence ends at
 * a stop followed by a space and a capital, so "products.ts" or "v1.2" don't cut it short. */
function firstSentences(text: string, n = 2): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const parts = t.match(/.+?[.!?](?=\s+[A-Z“"(]|\s*$)/g);
  if (!parts) return t;
  return parts.slice(0, n).join(' ').replace(/\s+/g, ' ').trim();
}
