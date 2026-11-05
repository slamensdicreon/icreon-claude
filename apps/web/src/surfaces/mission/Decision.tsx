import type { EscalationView, MissionControlSnapshot } from '@lw/contracts';
import { age, clock } from '../../lib/fmt';
import { useApp, useNow } from '../../state';
import { kindOf, picks, raisedLine, useYoursActions } from '../../ui/cypher/cards';
import { DecisionCard } from '../../ui/cypher/parts';
import { ago } from './model';

/**
 * One card that is the Director's, in the decision card's large form (Mission Control and Needs
 * you in Bliss): the question and context, Cypher's verdict, its pick and the alternative, defer
 * and ask beneath, and what happens if the Director says nothing.
 */
export function Decision({ x, mc }: { x: EscalationView; mc: MissionControlSnapshot }) {
  const { setComposer, setLayout } = useApp();
  const now = useNow(30_000);
  const p = mc.project;
  const tz = p.timezone;
  const hm = (at: string) => clock(at, tz).replace(/\s?[AP]M$/, '');
  const act = useYoursActions(p.id, p.name);

  let pick, other;
  if (x.type === 'gate') {
    const a = act.cardActions(x, 'project');
    pick = a.primary;
    other = a.secondary;
  } else {
    const { pick: pk, other: ot } = picks(x);
    pick = pk
      ? { label: pk.label, run: () => act.resolve(x, pk.id) }
      : { label: 'Open', run: () => act.open('inbox', { expanded: x.escalationId }) };
    other = ot ? { label: ot.label, run: () => act.resolve(x, ot.id) } : null;
  }

  const fallback = (() => {
    if (!x.deadline || !x.defaultOptionId) return x.waitNote;
    const o = x.options.find((y) => y.id === x.defaultOptionId);
    return o ? `If you say nothing: ${o.label.toLowerCase()}, at ${hm(x.deadline)}` : null;
  })();

  return (
    <DecisionCard
      label={`${kindOf(x)} · ${x.deadline ? `before ${hm(x.deadline)}` : 'no clock'}`}
      title={x.title}
      context={x.context}
      raiser={x.raisedBy ?? null}
      meta={raisedLine(x, ago(age(x.raisedAt, now)))}
      rec={x.recommendation ?? null}
      pick={pick}
      other={other}
      quiet={[
        ...(x.type !== 'gate' ? [{ label: 'Defer half an hour', run: () => act.defer(x) }] : []),
        {
          label: x.raisedBy ? `Ask ${x.raisedBy.firstName}` : 'Ask Cypher',
          run: () => {
            // Bliss has no chat: asking opens the conversation, which lives in Everything.
            setComposer({ text: `About ${x.title}: `, about: x.escalationId, focus: true });
            setLayout({ dockOpen: true });
          },
        },
      ]}
      fallback={fallback}
    />
  );
}
