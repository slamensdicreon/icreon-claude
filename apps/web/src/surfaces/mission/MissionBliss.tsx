import type { MissionControlSnapshot, PlanSnapshot } from '@lw/contracts';
import { clock, usd } from '../../lib/fmt';
import { useApp, useNow, useProjectResource } from '../../state';
import { kindOf, useYoursActions } from '../../ui/cypher/cards';
import {
  Closing,
  Handled,
  Hero,
  PhaseStrip,
  QuietCard,
  SectionHeading,
  TeamLine,
  urgencyOf,
} from '../../ui/cypher/parts';
import { Decision } from './Decision';
import { useEyeState } from '../../voice/eye';
import { leadFace, openCards, phaseOwners, stripOf, teamName, voiceOf, word } from './model';
import s from './mission.module.css';

const HEALTH: Record<string, string> = {
  healthy: 'on pace',
  attention: 'needs attention',
  blocked: 'blocked',
};

/**
 * One project in Bliss (Mission-Bliss board): the phase track, Cypher's sentence, the one decision
 * that is the Director's in its large form, two quieter cards, the team in one line each, and what
 * was handled.
 */
export function MissionBliss({ mc }: { mc: MissionControlSnapshot }) {
  const { inspect } = useApp();
  const plan = useProjectResource<PlanSnapshot>('/plan').data ?? null;
  const eye = useEyeState();
  const now = useNow(30_000);
  const p = mc.project;
  const tz = p.timezone;
  const act = useYoursActions(p.id, p.name);
  const cards = openCards(mc);
  const [first, ...rest] = cards;
  const strip = stripOf(mc, phaseOwners(plan));
  const current = mc.phases.filter((x) => x.status === 'current');
  const main = current[0];
  const day = p.startedAt
    ? Math.max(1, Math.ceil((now - new Date(p.startedAt).getTime()) / 86_400_000))
    : null;
  const hm = (at: string) => clock(at, tz).replace(/\s?[AP]M$/, '');

  return (
    <div className={s.bliss}>
      <div className={s.track}>
        <PhaseStrip phases={strip} />
        <div className={`${s.trackLine} type-body`}>
          {main ? (
            <b>
              {main.shortName || main.name}, phase {word(main.number)} of {word(mc.phases.length)}
            </b>
          ) : (
            <b>{p.status === 'completed' ? 'Accepted' : 'Not started'}</b>
          )}
          {current[1] && (
            <span>{current[1].shortName || current[1].name} has started alongside</span>
          )}
          <span className={s.trackRight}>
            {[
              day ? `Day ${word(day)}` : null,
              HEALTH[p.health],
              `${usd(p.spent.usd)} of ${usd(p.budgets.usd)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      </div>

      <Hero
        eye={eye.state}
        blink={eye.blink}
        voice={voiceOf(mc)}
        small
        showClosing={false}
        urgency={urgencyOf(
          mc.waitingOnYou.filter((x) => x.status === 'open').map((x) => x.deadline),
          now,
        )}
      />

      {first && <Decision x={first} mc={mc} />}

      {rest.length > 0 && (
        <section className={s.two} aria-label="Also yours">
          {rest.slice(0, 2).map((x) => {
            const { primary, secondary } = act.cardActions(x, 'project');
            return (
              <QuietCard
                key={x.escalationId}
                label={`${kindOf(x)} · ${x.deadline ? `before ${hm(x.deadline)}` : 'no clock'}`}
                title={x.title}
                rec={x.recommendation ?? null}
                primary={primary}
                secondary={secondary}
              />
            );
          })}
        </section>
      )}
      {rest.length > 2 && (
        <p className={`${s.more} type-meta`}>
          {rest.length - 2} more wait their turn in Needs you.
        </p>
      )}

      <section className={s.teamAndHandled} aria-label="The team and what was handled">
        <div className={s.column}>
          <SectionHeading>The team, in one line each</SectionHeading>
          <div>
            {mc.teamNow.map((l) => (
              <TeamLine
                key={l.agentId}
                face={leadFace(l)}
                team={teamName(l.workstream)}
                read={l.read ?? leadFallback(l)}
                tone={l.readTone ?? (l.blocked ? 'blocked' : l.active ? 'normal' : 'quiet')}
                reports={l.reports ?? []}
                onOpen={() => inspect('agent', l.agentId)}
              />
            ))}
          </div>
        </div>
        <div className={s.column}>
          <SectionHeading>Handled</SectionHeading>
          {mc.handled && mc.handled.length > 0 ? (
            <Handled items={mc.handled} columns={1} timeOf={hm} />
          ) : (
            <p className={`${s.quiet} type-body`}>Nothing settled without you yet today.</p>
          )}
          {mc.voice?.closing && <Closing text={mc.voice.closing} />}
        </div>
      </section>
    </div>
  );
}

/** Until the API writes the Lead's line: what the row's counts say. */
function leadFallback(l: MissionControlSnapshot['teamNow'][number]): string {
  if (l.blocked) return `${word(l.active)} active; ${word(l.blocked)} blocked.`;
  if (l.active) return `${word(l.active)} active.`;
  if (l.done) return 'Done.';
  return 'Standing by.';
}
