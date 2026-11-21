/*
 * A card that is the Director's, as a brief: the decision as a plain question, what it is about in
 * a sentence, every option with what it means, and room to write. Bliss shows the calm form (the
 * question, the options, then only what the chosen answer needs); Everything shows the full form
 * (what's going on, what the answer changes, the options with their consequences, a note).
 *
 * Writing works in place: a note travels with any answer, an option that needs something more
 * asks for it, a gate sent back says what has to change, and "write my own" sends an answer in the
 * Director's words to Cypher, which answers the card or passes it to the team.
 */
import type { EscalationView, MissionControlSnapshot } from '@lw/contracts';
import { useId, useState } from 'react';
import { age, clock } from '../../lib/fmt';
import { isWatching } from '../../lib/role';
import { useJump } from '../../parts/bits';
import { useNow } from '../../state';
import { Icon } from '../../theme/icons';
import { Eye } from '../../ui/Eye';
import { picks, questionOf, raisedLine, shortOf, useYoursActions } from '../../ui/cypher/cards';
import { Button } from '../../ui/cypher/parts';
import { ago } from '../mission/model';
import s from './brief.module.css';

/** What the card offers, in the brief's words: a gate's two answers, or the card's options. */
interface Choice {
  id: string;
  short: string;
  label: string;
  hint: string | null;
  detail: string | null;
  asks: string | null;
  pick: boolean;
  fallback: boolean;
}

const OWN = '__own';

/** "2:24", in the project's zone, without AM/PM. */
const hmOf = (at: string, tz: string) => clock(at, tz).replace(/\s?[AP]M$/, '');

/** "24 min left", "1 h 05 m left". */
export function minutesLeft(deadline: string, now: number): string {
  const m = Math.max(0, Math.round((Date.parse(deadline) - now) / 60_000));
  return m >= 60
    ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m left`
    : `${m} min left`;
}

function choicesOf(x: EscalationView): Choice[] {
  const { pick } = picks(x);
  const recPick = x.recommendation?.pick ?? null;
  if (x.type === 'gate') {
    const words = (id: string) => x.options.find((o) => o.id === id);
    const approve = words('approve');
    const back = words('send_back');
    return [
      {
        id: 'approve',
        short: 'Approve',
        label: 'Approve',
        hint: approve?.hint ?? (x.reversible ? null : 'final'),
        detail: approve?.detail ?? null,
        asks: null,
        pick: false,
        fallback: false,
      },
      {
        id: 'send_back',
        short: 'Ask for changes',
        label: 'Ask for changes',
        hint: back?.hint ?? 'with your notes',
        detail: back?.detail ?? null,
        asks: null,
        pick: false,
        fallback: false,
      },
    ];
  }
  return x.options.map((o) => ({
    id: o.id,
    short: shortOf(o),
    label: o.label,
    hint: o.hint ?? null,
    detail: o.detail ?? null,
    asks: o.asks ?? null,
    // Cypher's pick is shown only when Cypher made one; the raiser's flag alone is not a verdict.
    pick: recPick ? o.id === recPick : !!x.recommendation && o.id === pick?.id,
    fallback: !!x.deadline && o.id === x.defaultOptionId,
  }));
}

/** The brief's state and what Send does, shared by both forms. */
function useBrief(x: EscalationView, mc: MissionControlSnapshot) {
  const act = useYoursActions(mc.project.id, mc.project.name);
  const [sel, setSel] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [answer, setAnswer] = useState('');
  const choices = choicesOf(x);
  const chosen = choices.find((c) => c.id === sel) ?? null;
  const own = sel === OWN;
  const sendBack = sel === 'send_back';
  /** Writing is required for your own answer and for a gate sent back; optional otherwise. */
  const needsText = own || sendBack;
  const canSend = !!sel && (!needsText || note.trim().length > 0);

  const send = () => {
    if (!sel || !canSend) return;
    if (own) return act.reply(x, note);
    if (x.type === 'gate') return sendBack ? act.sendBack(x, note.trim()) : act.approve(x);
    const notes = [
      chosen?.asks && answer.trim() ? `${chosen.asks} ${answer.trim()}` : '',
      note.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    act.resolve(x, sel, notes || undefined);
  };

  const fallback = (() => {
    const d = choices.find((c) => c.fallback);
    if (x.deadline && d) return { at: hmOf(x.deadline, mc.project.timezone), what: d.short };
    return null;
  })();

  return {
    act,
    choices,
    chosen,
    sel,
    setSel: (id: string) => {
      setSel(id);
      if (id === OWN || id === 'send_back') setNoteOpen(true);
    },
    own,
    sendBack,
    needsText,
    noteOpen: noteOpen || needsText,
    openNote: () => setNoteOpen(true),
    note,
    setNote,
    answer,
    setAnswer,
    canSend,
    send,
    fallback,
    /** A gate's approval takes no note; everything else may carry one. */
    takesNote: !(x.type === 'gate' && sel === 'approve'),
  };
}

const noteLabelOf = (b: ReturnType<typeof useBrief>, who: string) =>
  b.own ? `Your answer for ${who}` : b.sendBack ? 'What needs to change?' : `A note for ${who}`;

/* ------------------------------------------------------------------------------------------ */
/* Bliss: the calm form                                                                         */
/* ------------------------------------------------------------------------------------------ */

export function BlissBrief({ x, mc }: { x: EscalationView; mc: MissionControlSnapshot }) {
  const b = useBrief(x, mc);
  const now = useNow(30_000);
  const [why, setWhy] = useState(false);
  const id = useId();
  const who = x.raisedBy?.firstName ?? 'the team';
  const watching = isWatching();
  const gist = x.plain?.trim() || x.gist;

  return (
    <section className={s.bliss} aria-label={questionOf(x)}>
      <div className={s.blissHead}>
        <h2 id={`${id}-q`} className={`${s.question} type-decision-title`}>
          {questionOf(x)}
        </h2>
        {gist && <p className={`${s.gist} type-body`}>{gist}</p>}
      </div>

      <div role="radiogroup" aria-labelledby={`${id}-q`} className={s.rows}>
        {b.choices.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={b.sel === c.id}
            disabled={watching}
            className={s.row}
            onClick={() => b.setSel(c.id)}
          >
            <span className={s.dot} aria-hidden="true" />
            <span className={s.rowLabel}>{c.short}</span>
            {c.pick && (
              <span className={`${s.pick} type-meta`}>
                <Eye state="watching" size={18} decorative />
                My pick
              </span>
            )}
            {c.hint && <span className={`${s.hint} type-meta`}>{c.hint}</span>}
          </button>
        ))}
      </div>

      {watching ? (
        <p className="type-meta">You are watching: the Director decides this one.</p>
      ) : (
        <>
          {b.chosen?.asks && (
            <label className={s.field}>
              <span className={s.fieldLabel}>{b.chosen.asks}</span>
              <input
                className={s.input}
                value={b.answer}
                onChange={(e) => b.setAnswer(e.target.value)}
                placeholder="A name, an email or a link"
              />
            </label>
          )}
          {b.noteOpen && b.takesNote && b.sel && (
            <label className={s.field}>
              <span className={b.needsText ? s.fieldLabel : 'sr-only'}>{noteLabelOf(b, who)}</span>
              <textarea
                className={s.input}
                rows={b.needsText ? 3 : 2}
                value={b.note}
                onChange={(e) => b.setNote(e.target.value)}
                placeholder={
                  b.own
                    ? `Tell ${who} what you'd like instead`
                    : b.sendBack
                      ? 'Say what has to change. The team picks it up from your notes.'
                      : `A note for ${who}`
                }
                autoFocus={b.needsText}
              />
            </label>
          )}
          {b.sel && (
            <Button large onClick={b.send} disabled={!b.canSend}>
              {b.own ? 'Send to Cypher' : b.sendBack ? 'Send back' : `Send to ${who}`}
            </Button>
          )}
        </>
      )}

      <div className={s.foot}>
        <span className={s.footActions}>
          {!watching && x.type !== 'gate' && !b.own && (
            <button type="button" className={s.quiet} onClick={() => b.setSel(OWN)}>
              <Icon name="edit" size={18} />
              Write my own
            </button>
          )}
          {!watching && b.sel && !b.noteOpen && b.takesNote && (
            <button type="button" className={s.quiet} onClick={b.openNote}>
              Add a note
            </button>
          )}
          <button
            type="button"
            className={s.quiet}
            aria-expanded={why}
            onClick={() => setWhy((w) => !w)}
          >
            Why?
          </button>
        </span>
        <span className={`${s.fallback} type-meta`}>
          {b.fallback
            ? `No answer by ${b.fallback.at} → ${b.fallback.what}`
            : (x.waitNote ?? 'Waits for you')}
        </span>
      </div>

      {why && (
        <div className={`${s.why} type-body-small`}>
          {x.recommendation && (
            <p>
              <b>{x.recommendation.verdict}</b> {x.recommendation.why}
            </p>
          )}
          <p className={s.whyMeta}>
            {raisedLine(x, ago(age(x.raisedAt, now)))}
            {x.deadline ? ` · ${minutesLeft(x.deadline, now)}` : ''}
          </p>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Everything: the full form, inside the open row                                               */
/* ------------------------------------------------------------------------------------------ */

export function EverythingBrief({ x, mc }: { x: EscalationView; mc: MissionControlSnapshot }) {
  const b = useBrief(x, mc);
  const jump = useJump();
  const id = useId();
  const who = x.raisedBy?.firstName ?? 'the team';
  const watching = isWatching();
  const gist = x.plain?.trim() || x.gist;

  return (
    <div className={s.full}>
      <div className={s.col}>
        {gist && (
          <div className={s.block}>
            <span className="type-label">What's going on</span>
            <p className="type-body-small">{gist}</p>
          </div>
        )}
        {x.impact && (
          <div className={s.block}>
            <span className="type-label">What your answer changes</span>
            <p className="type-body-small">{x.impact}</p>
          </div>
        )}
        {x.evidence.length > 0 && (
          <div className={s.block}>
            <span className="type-label">Look before you decide</span>
            {x.evidence.map((e) => (
              <button
                key={`${e.kind}:${e.ref}:${e.label}`}
                type="button"
                className={s.evidence}
                onClick={() => jump(e)}
              >
                {e.label}
              </button>
            ))}
          </div>
        )}
        <details className={s.details}>
          <summary>Technical details for the team</summary>
          <p className="type-meta">{x.context}</p>
        </details>
      </div>

      <fieldset className={s.col} disabled={watching}>
        <legend className="type-label">Your answer</legend>
        {b.choices.map((c) => (
          <label key={c.id} className={s.choice} data-on={b.sel === c.id || undefined}>
            <input
              type="radio"
              name={`${id}-answer`}
              checked={b.sel === c.id}
              onChange={() => b.setSel(c.id)}
            />
            <span className={s.choiceText}>
              <span className={s.choiceHead}>
                <b>{c.short}</b>
                {c.pick && <span className={s.tagInk}>Cypher's pick</span>}
                {c.fallback && <span className={s.tagCoral}>If you don't answer</span>}
              </span>
              <span className="type-meta">
                {c.detail ?? (c.short !== c.label ? c.label : c.hint)}
              </span>
              {x.type === 'gate' && c.id === 'approve' && !x.reversible && (
                <span className={s.tag}>Final: can't be undone</span>
              )}
            </span>
          </label>
        ))}
        {x.type !== 'gate' && (
          <label className={s.choice} data-on={b.own || undefined}>
            <input
              type="radio"
              name={`${id}-answer`}
              checked={b.own}
              onChange={() => b.setSel(OWN)}
            />
            <span className={s.choiceText}>
              <b>Something else</b>
              <span className="type-meta">
                Say it in your own words; Cypher passes it to {who}.
              </span>
            </span>
          </label>
        )}
        {x.recommendation && (
          <p className={`${s.verdict} type-body-small`}>
            <b>{x.recommendation.verdict}</b> {x.recommendation.why}
          </p>
        )}
      </fieldset>

      <div className={s.col}>
        {watching ? (
          <p className="type-meta">You are watching: the Director decides this one.</p>
        ) : (
          <>
            {b.chosen?.asks && (
              <label className={s.field}>
                <span className="type-label">{b.chosen.asks}</span>
                <input
                  className={s.input}
                  value={b.answer}
                  onChange={(e) => b.setAnswer(e.target.value)}
                  placeholder="A name, an email or a link"
                />
              </label>
            )}
            {b.takesNote && (
              <label className={s.field}>
                <span className="type-label">
                  {noteLabelOf(b, who)}
                  {b.needsText ? '' : ' (optional)'}
                </span>
                <textarea
                  className={s.input}
                  rows={4}
                  value={b.note}
                  onChange={(e) => b.setNote(e.target.value)}
                  placeholder={
                    b.sendBack
                      ? 'Say what has to change. The team picks it up from your notes.'
                      : 'Anything the team should know, conditions, or who to loop in'
                  }
                />
              </label>
            )}
            <span className={s.actions}>
              <Button onClick={b.send} disabled={!b.canSend}>
                {b.own
                  ? 'Send to Cypher'
                  : b.sendBack
                    ? 'Send back'
                    : b.sel
                      ? 'Send'
                      : 'Choose an answer'}
              </Button>
            </span>
            <span className="type-meta">
              {b.fallback
                ? `No answer by ${b.fallback.at}: ${b.fallback.what}.`
                : (x.waitNote ?? 'Waits for you.')}
              {x.type !== 'gate' && x.reversible
                ? ' You can undo for a short while after sending.'
                : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
