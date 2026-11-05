/*
 * The Decision Log: every decision on the project, newest first, append-only. A Lead's or a rule's
 * answer can be overridden: the task runs again with the Director's choice.
 */
import type { DecisionView, EscalationView } from '@lw/contracts';
import { useState } from 'react';
import { get, messageOf, post } from '../../lib/api';
import { stamp } from '../../lib/fmt';
import { useApp, useProjectResource, useTz } from '../../state';
import { Button, Chips } from '../../ui/cypher/parts';
import { DocHead, Quiet, Tag } from './parts';
import s from './doc.module.css';

type Who = DecisionView['decidedBy'];

const DECIDED_BY: Record<Who, string> = {
  director: 'Director',
  chief_of_staff: 'Cypher (convention)',
  default: 'Default action (Cypher)',
  lead: 'Lead (triage)',
  rule: 'Rule',
};

export function DecisionLog() {
  const tz = useTz();
  const res = useProjectResource<DecisionView[]>('/decisions');
  const list = res.data ?? [];
  const [who, setWho] = useState<'all' | Who>('all');
  const shown = [...list].reverse().filter((d) => who === 'all' || d.decidedBy === who);
  const present = (Object.keys(DECIDED_BY) as Who[]).filter((k) =>
    list.some((d) => d.decidedBy === k),
  );
  return (
    <>
      <DocHead
        title="Decision Log"
        meta={`${list.length} ${list.length === 1 ? 'decision' : 'decisions'}`}
        tags={<Tag tag={{ label: 'Append-only', tone: 'quiet' }} />}
      />
      <div className={s.body}>
        {present.length > 1 && (
          <div className={s.toolbar}>
            <Chips<'all' | Who>
              label="Decided by"
              value={who}
              onChange={setWho}
              options={(['all', ...present] as const).map((k) => ({
                value: k,
                label: k === 'all' ? 'Everyone' : DECIDED_BY[k],
                count: k === 'all' ? list.length : list.filter((d) => d.decidedBy === k).length,
              }))}
            />
          </div>
        )}
        {res.error && !res.data ? (
          <Quiet>{res.error.message}</Quiet>
        ) : !res.data ? (
          <Quiet>Loading the Decision Log…</Quiet>
        ) : shown.length === 0 ? (
          <Quiet>No decisions yet.</Quiet>
        ) : (
          <div className={s.tableWrap}>
            <table className={`${s.table} type-table`} data-stack="">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Question</th>
                  <th>Answer</th>
                  <th>Decided by</th>
                  <th data-num="">When</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.decisionId}>
                    <td className={s.ref}>{d.ref}</td>
                    <td className={s.question}>{d.question}</td>
                    <td>
                      {d.answer}
                      {(d.decidedBy === 'lead' || d.decidedBy === 'rule') && (
                        <>
                          {d.rationale && (
                            <span className={`${s.why} type-meta`}>{d.rationale}</span>
                          )}
                          {d.escalationId && (
                            <Override escalationId={d.escalationId} answer={d.answer} />
                          )}
                        </>
                      )}
                    </td>
                    <td className={s.secondary}>{DECIDED_BY[d.decidedBy]}</td>
                    <td data-num="" className={s.quietText}>
                      {stamp(d.ts, tz)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Overrides a Lead's (or a rule's) answer: the task runs again with the Director's choice. What
 * the task already did with the Lead's answer stays in its history.
 */
function Override({ escalationId, answer }: { escalationId: string; answer: string }) {
  const { projectId, run, toast } = useApp();
  const [card, setCard] = useState<EscalationView | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const base = `/projects/${projectId}`;
  const toggle = async () => {
    if (open) return setOpen(false);
    if (card) return setOpen(true);
    setLoading(true);
    try {
      setCard(await get<EscalationView>(`${base}/escalations/${escalationId}`));
      setOpen(true);
    } catch (err) {
      toast(messageOf(err, 'The card behind this decision could not be loaded.'));
    } finally {
      setLoading(false);
    }
  };
  const others = card?.options.filter((o) => o.label !== answer) ?? [];
  const id = `override-${escalationId}`;
  return (
    <span className={s.override}>
      <button
        type="button"
        className={`${s.link} type-meta`}
        onClick={() => void toggle()}
        aria-expanded={open}
        aria-controls={id}
        disabled={loading}
      >
        {loading ? 'Loading…' : open ? 'Keep this answer' : 'Override'}
      </button>
      {open && card && (
        <span id={id} className={s.overrideOptions}>
          {!card.sourceTaskId ? (
            <span className={`${s.quietText} type-meta`}>No task to run again.</span>
          ) : others.length === 0 ? (
            <span className={`${s.quietText} type-meta`}>No other option to choose.</span>
          ) : (
            others.map((o) => (
              <Button
                key={o.id}
                kind="secondary"
                onClick={() =>
                  void run(() =>
                    post(`${base}/tasks/${card.sourceTaskId}/rerun`, {
                      instructions: `Decision on "${card.title}": ${o.label}. The Director overrode the Lead's answer (${answer}).`,
                      overriding: card.escalationId,
                    }),
                  ).then((ok) => ok && setOpen(false))
                }
              >
                Run again with: {o.label}
              </Button>
            ))
          )}
        </span>
      )}
    </span>
  );
}
