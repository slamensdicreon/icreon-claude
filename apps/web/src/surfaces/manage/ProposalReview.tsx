/*
 * Every waiting proposal (lessons, procedures, gaps and rules, from every project) with Cypher's
 * recommendation on each: approve, approve it changed, or reject, and why. The Director can change
 * any choice, leave one out, and apply the rest in one go. POST /proposals/sort, then
 * POST /proposals/apply.
 */
import type { ProposalRecommendation, ProposalReview as Review } from '@lw/contracts';
import { useState } from 'react';
import { messageOf, postFor } from '../../lib/api';
import { useApp } from '../../state';
import { Select } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Action, Actions, Notice } from '../intake/shared';
import { count } from './shared';
import s from './manage.module.css';

type Choice = ProposalRecommendation['action'] | 'skip';

const LABEL: Record<Choice, string> = {
  approve: 'Approve',
  edit: 'Approve with Cypher’s change',
  reject: 'Reject',
  skip: 'Leave for later',
};

function editLine(r: ProposalRecommendation): string | null {
  const e = r.edit;
  if (!e) return null;
  return [
    e.scope
      ? `scope to ${e.scope.kind === 'global' ? 'everywhere' : `${e.scope.kind} ${e.scope.id}`}`
      : '',
    e.roles ? `roles: ${e.roles.length ? e.roles.join(', ') : 'every role'}` : '',
    e.title ? `title: “${e.title}”` : '',
    e.text ? `text: “${e.text}”` : '',
    e.when ? `when: “${e.when}”` : '',
    e.then ? `then: “${e.then}”` : '',
  ]
    .filter(Boolean)
    .join('; ');
}

export function ProposalReview({ waiting, onDone }: { waiting: number; onDone: () => void }) {
  const { toast } = useApp();
  const [review, setReview] = useState<Review | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState<'sort' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sort = async () => {
    setBusy('sort');
    setError(null);
    try {
      const r = await postFor<Review>('/proposals/sort', {});
      setReview(r);
      setChoices(
        Object.fromEntries(r.recommendations.map((x) => [x.id, r.available ? x.action : 'skip'])),
      );
    } catch (err) {
      setError(messageOf(err, 'Cypher could not sort the proposals.'));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!review) return;
    const decisions = review.recommendations
      .filter((r) => choices[r.id] && choices[r.id] !== 'skip')
      .map((r) => ({
        kind: r.kind,
        id: r.id,
        action: choices[r.id] as ProposalRecommendation['action'],
        edit: choices[r.id] === 'edit' ? r.edit : null,
      }));
    if (!decisions.length) return;
    setBusy('apply');
    setError(null);
    try {
      const out = await postFor<{
        approved: number;
        edited: number;
        rejected: number;
        failed: { id: string; error: string }[];
      }>('/proposals/apply', { decisions });
      toast(
        `${out.approved + out.edited} approved (${out.edited} changed), ${out.rejected} rejected${out.failed.length ? `; ${out.failed.length} could not be applied` : ''}.`,
      );
      setReview(null);
      onDone();
    } catch (err) {
      setError(messageOf(err, 'The decisions could not be applied.'));
    } finally {
      setBusy(null);
    }
  };

  if (!review)
    return waiting > 0 ? (
      <Notice tone="waiting">
        {count(waiting, 'proposal')} {waiting === 1 ? 'waits' : 'wait'} for you, from every project.{' '}
        <Action kind="primary" onClick={() => void sort()} disabled={busy === 'sort'}>
          {busy === 'sort' ? 'Cypher is reading them…' : 'Review proposals'}
        </Action>
        {error && <span> {error}</span>}
      </Notice>
    ) : null;

  const picked = review.recommendations.filter((r) => choices[r.id] && choices[r.id] !== 'skip');
  return (
    <Panel
      title="Review proposals"
      count={review.recommendations.length}
      meta={
        review.available
          ? 'Cypher’s recommendation on each; change any before you apply'
          : 'No model is set up: choose each one yourself'
      }
    >
      {error && <Notice tone="bad">{error}</Notice>}
      <div className={s.entries}>
        {review.recommendations.map((r) => (
          <div key={r.id} className={s.entry}>
            <div className={s.entryHead}>
              <span className={`${s.ref} type-meta`}>{r.ref}</span>
              <span className={`${s.entryTitle} type-body-small`}>{r.label}</span>
            </div>
            {r.reason && (
              <p className={`${s.entryText} type-body-small`}>
                {r.reason}
                {r.duplicateOf ? ` (repeats ${r.duplicateOf})` : ''}
              </p>
            )}
            {r.edit && <p className={`${s.muted} type-meta`}>Change: {editLine(r)}</p>}
            <Select
              aria-label={`What to do with ${r.ref}`}
              value={choices[r.id] ?? 'skip'}
              onChange={(e) => setChoices((c) => ({ ...c, [r.id]: e.target.value as Choice }))}
            >
              {(
                ['approve', ...(r.edit ? (['edit'] as const) : []), 'reject', 'skip'] as Choice[]
              ).map((c) => (
                <option key={c} value={c}>
                  {LABEL[c]}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>
      <Actions end>
        <Action kind="quiet" onClick={() => setReview(null)}>
          Close
        </Action>
        <Action
          kind="primary"
          onClick={() => void apply()}
          disabled={!picked.length || busy === 'apply'}
        >
          {busy === 'apply' ? 'Applying…' : `Apply ${count(picked.length, 'decision')}`}
        </Action>
      </Actions>
    </Panel>
  );
}
