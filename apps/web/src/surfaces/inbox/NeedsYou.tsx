import type { EscalationView, MissionControlSnapshot } from '@lw/contracts';
import { useEffect, useRef } from 'react';
import { API } from '../../lib/api';
import { isWatching } from '../../lib/role';
import { age, clock } from '../../lib/fmt';
import { Mode } from '../../mode/Mode';
import { useApp, useMission, useNow } from '../../state';
import { Icon } from '../../theme/icons';
import { Eye } from '../../ui/Eye';
import {
  countWord,
  fallbackOf,
  minutesLeft,
  pillHue,
  kindWordOf,
  questionOf,
  useYoursActions,
} from '../../ui/cypher/cards';
import { Button, Closing, Hero, Panel, SectionHeading, urgencyOf } from '../../ui/cypher/parts';
import { useEyeState } from '../../voice/eye';
import { ago, openCards, voiceOf } from '../mission/model';
import { BlissBrief, EverythingBrief } from './Brief';
import b from './brief.module.css';
import s from './inbox.module.css';

/** Needs you, in both faces (component table: Decision Inbox and Smart Recommendation). */
export function NeedsYou() {
  const mc = useMission().data;
  if (!mc) return <p className="type-body">Reading the project…</p>;
  return <Mode bliss={<NeedsBliss mc={mc} />} everything={<NeedsEverything mc={mc} />} />;
}

/**
 * J and K move between the open cards (the shortcut help promises it). Not while typing, and not
 * under a dialog: the old page's arrows fired beneath overlays and stole the page's scrolling.
 */
function useJK(cards: EscalationView[]) {
  const { ui, setUi, overlay } = useApp();
  const ref = useRef({ cards, expanded: ui.expanded, overlay, setUi });
  ref.current = { cards, expanded: ui.expanded, overlay, setUi };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { cards: c, expanded, overlay: o, setUi: set } = ref.current;
      const el = document.activeElement;
      if (
        o ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        (el && /INPUT|TEXTAREA|SELECT/.test(el.tagName))
      )
        return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      if (!c.length) return;
      const i = c.findIndex((x) => x.escalationId === expanded);
      const next = k === 'j' ? Math.min(c.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      set({ expanded: c[next]!.escalationId });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

const deferredOf = (mc: MissionControlSnapshot) =>
  mc.waitingOnYou.filter((x) => x.status === 'deferred');
const decidedOf = (mc: MissionControlSnapshot, now: number) =>
  mc.waitingOnYou.filter((x) => x.undoUntil && new Date(x.undoUntil).getTime() > now);

/**
 * Bliss: one decision at a time, in the large card, with the others as a short stack beneath that
 * the Director can bring forward. Deferred cards wait at the bottom.
 */
function NeedsBliss({ mc }: { mc: MissionControlSnapshot }) {
  const { ui, setUi } = useApp();
  const eye = useEyeState();
  const tz = mc.project.timezone;
  const cards = openCards(mc);
  useJK(cards);
  const focus = cards.find((x) => x.escalationId === ui.expanded) ?? cards[0];
  const rest = cards.filter((x) => x !== focus);
  const deferred = deferredOf(mc);
  const hm = (at: string) => clock(at, tz).replace(/\s?[AP]M$/, '');
  const act = useYoursActions(mc.project.id, mc.project.name);

  return (
    <div className={s.bliss}>
      <Hero
        eye={eye.state}
        blink={eye.blink}
        voice={voiceOf(mc)}
        small
        showClosing={false}
        urgency={urgencyOf(
          cards.map((x) => x.deadline),
          Date.now(),
        )}
      />
      {focus ? (
        <BlissBrief key={focus.escalationId} x={focus} mc={mc} />
      ) : (
        <section className={s.clear} aria-label="Nothing is yours">
          <Eye state="resting" size={64} decorative />
          <p className="type-heading">Nothing needs you.</p>
        </section>
      )}

      {rest.length > 0 && focus && (
        // The others wait as dots, one per card: Bliss shows one decision at a time.
        <nav className={b.queue} aria-label="Waiting their turn">
          <span className={b.queueDots}>
            {cards.map((x) => (
              <button
                key={x.escalationId}
                type="button"
                className={b.queueDot}
                aria-current={x === focus}
                aria-label={questionOf(x)}
                title={questionOf(x)}
                onClick={() => setUi({ expanded: x.escalationId })}
              />
            ))}
          </span>
          <button
            type="button"
            className={b.quiet}
            onClick={() => setUi({ expanded: rest[0]!.escalationId })}
          >
            {rest.length === 1
              ? 'One more after this'
              : `${countWord(rest.length)} more after this`}
          </button>
        </nav>
      )}

      {deferred.length > 0 && (
        <section className={s.section} aria-label="Deferred">
          <SectionHeading>Deferred</SectionHeading>
          <ul className={s.stack}>
            {deferred.map((x) => (
              <li key={x.escalationId} className={s.stackRow} data-static>
                <span className={s.stackTitle}>{questionOf(x)}</span>
                <span className={`${s.stackClock} type-meta`}>
                  {x.deferredUntil ? `back at ${hm(x.deferredUntil)}` : 'deferred'}
                </span>
                <Button kind="secondary" onClick={() => act.resume(x)}>
                  Resume now
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {mc.voice?.closing && <Closing text={mc.voice.closing} />}
    </div>
  );
}

/**
 * Everything: the Decision Inbox. Every open card as a row that folds open to its context,
 * Cypher's verdict, every option and the quieter actions; then deferred and just-decided cards.
 * The row that's open is the card the keyboard acts on (1–4, D, A, J and K).
 */
function NeedsEverything({ mc }: { mc: MissionControlSnapshot }) {
  const { ui, setUi } = useApp();
  const now = useNow(1000);
  const cards = openCards(mc);
  useJK(cards);
  const deferred = deferredOf(mc);
  const decided = decidedOf(mc, now);
  const tz = mc.project.timezone;
  const hm = (at: string) => clock(at, tz).replace(/\s?[AP]M$/, '');
  const act = useYoursActions(mc.project.id, mc.project.name);

  return (
    <div className={s.everything}>
      <Panel
        title="Needs you"
        count={cards.length}
        meta={
          <span className={s.headRight}>
            By clock, then type
            <a
              className={s.link}
              href={`${API}/projects/${mc.project.id}/escalations.csv`}
              download
            >
              Export CSV
            </a>
          </span>
        }
      >
        {cards.length === 0 && <p className={`${s.empty} type-body-small`}>Nothing needs you.</p>}
        {cards.map((x) => (
          <Fold
            key={x.escalationId}
            x={x}
            mc={mc}
            open={ui.expanded === x.escalationId}
            onToggle={() =>
              setUi({ expanded: ui.expanded === x.escalationId ? null : x.escalationId })
            }
            now={now}
          />
        ))}
      </Panel>

      {deferred.length > 0 && (
        <Panel title="Deferred" meta="Back on their own, or now">
          {deferred.map((x) => (
            <div key={x.escalationId} className={`${s.simpleRow} type-table`}>
              <span className={`${s.pill} type-label`} style={{ background: pillHue(x) }}>
                {kindWordOf(x)}
              </span>
              <span className={s.grow}>{x.title}</span>
              <span className="type-meta">
                {x.deferredUntil ? `back at ${hm(x.deferredUntil)}` : ''}
              </span>
              <Button kind="secondary" onClick={() => act.resume(x)}>
                Resume now
              </Button>
            </div>
          ))}
        </Panel>
      )}

      {decided.length > 0 && (
        <Panel title="Just decided" meta="Undo while it hasn't taken effect">
          {decided.map((x) => {
            const left = Math.max(0, Math.ceil((new Date(x.undoUntil!).getTime() - now) / 1000));
            const chose = x.options.find((o) => o.id === x.resolution?.optionId)?.label;
            return (
              <div key={x.escalationId} className={`${s.simpleRow} type-table`}>
                <span className={s.check}>
                  <Icon name="check" size={18} />
                </span>
                <span className={s.grow}>
                  <b>{x.title}</b>
                  {chose && <span className={s.quiet}> · {chose}</span>}
                </span>
                <span className="type-meta">{left} s</span>
                <Button kind="secondary" onClick={() => act.undo(x)}>
                  Undo
                </Button>
              </div>
            );
          })}
        </Panel>
      )}
    </div>
  );
}

function Fold({
  x,
  mc,
  open,
  onToggle,
  now,
}: {
  x: EscalationView;
  mc: MissionControlSnapshot;
  open: boolean;
  onToggle: () => void;
  now: number;
}) {
  const { setComposer, setLayout } = useApp();
  const act = useYoursActions(mc.project.id, mc.project.name);
  const id = `fold-${x.escalationId}`;
  return (
    <div className={s.fold} data-open={open || undefined}>
      <button
        type="button"
        className={s.foldHead}
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <span className={`${s.pill} type-label`} style={{ background: pillHue(x) }}>
          {kindWordOf(x)}
        </span>
        <span className={s.foldText}>
          <span className={s.foldTitle}>{questionOf(x)}</span>
          <span className="type-meta">
            {[fallbackOf(x), x.raisedBy?.firstName, ago(age(x.raisedAt, now))]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        <span className={s.clockCol}>
          <span className={`${s.clock} type-button`} data-yours={!!x.deadline || undefined}>
            {x.deadline ? clock(x.deadline, mc.project.timezone) : 'No deadline'}
          </span>
          {x.deadline && <span className="type-meta">{minutesLeft(x.deadline, now)}</span>}
        </span>
        <Icon name="chevron" size={18} className={s.chev} />
      </button>
      {open && (
        <div id={id} className={s.foldBody}>
          <EverythingBrief x={x} mc={mc} />
          {!isWatching() && (
            <div className={`${s.foldFoot} type-meta`}>
              {x.type !== 'gate' && (
                <button type="button" className={s.link} onClick={() => act.defer(x)}>
                  Defer half an hour (D)
                </button>
              )}
              <button
                type="button"
                className={s.link}
                onClick={() => {
                  setComposer({
                    text: `About ${questionOf(x)}: `,
                    about: x.escalationId,
                    focus: true,
                  });
                  setLayout({ dockOpen: true });
                }}
              >
                Ask a question
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
