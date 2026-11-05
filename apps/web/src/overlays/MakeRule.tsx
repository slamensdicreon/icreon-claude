import type { RuleDraftView, RuleView } from '@lw/contracts';
import { useEffect, useState } from 'react';
import { messageOf, postFor } from '../lib/api';
import { useApp } from '../state';
import { Checkbox, Field, TextArea } from '../ui/cypher/forms';
import { Scrim } from './Dialogs';
import s from './overlays.module.css';

/**
 * Make this a rule: Cypher drafts a rule from a card the Director answered; the Director edits it,
 * picks where it applies, and saves it. From then on the Lead applies it to cards like this one.
 */
export function MakeRule({ projectId, escalationId }: { projectId: string; escalationId: string }) {
  const { closeOverlay, toast } = useApp();
  const [draft, setDraft] = useState<RuleDraftView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [when, setWhen] = useState('');
  const [then, setThen] = useState('');
  const [scope, setScope] = useState(1);
  const [onlyRole, setOnlyRole] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    postFor<RuleDraftView>(`/projects/${projectId}/escalations/${escalationId}/rule-draft`, {})
      .then((d) => {
        setDraft(d);
        setWhen(d.when);
        setThen(d.then);
        // The playbook when there is one: the next site on it is asked the same questions.
        setScope(Math.min(1, d.scopes.length - 1));
      })
      .catch((e: unknown) => setError(messageOf(e, 'The rule could not be drafted.')));
  }, [projectId, escalationId]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const { label: _label, ...where } = draft.scopes[scope]!;
      const rule = await postFor<RuleView>('/rules', {
        when,
        then,
        category: draft.category,
        scope: where,
        roles: onlyRole ? draft.roles : [],
        sources: draft.sources,
        status: 'active',
      });
      toast({
        title: `Rule ${rule.ref} saved`,
        detail: 'Leads apply it from the next card like this one.',
        tone: 'done',
      });
      closeOverlay();
    } catch (e) {
      setError(messageOf(e, 'The rule could not be saved.'));
      setBusy(false);
    }
  };

  return (
    <Scrim>
      <div
        className={`${s.float} ${s.dialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mr-t"
      >
        <h2 id="mr-t" className="type-title">
          Make this a rule
        </h2>
        {error && (
          <p className={`${s.err} type-body-small`} role="alert">
            {error}
          </p>
        )}
        {!draft && !error && <p className="type-body-small">Cypher is drafting it…</p>}
        {draft && (
          <>
            <p className="type-body-small">
              {draft.draftedBy === 'cypher'
                ? 'Cypher drafted this from your answer'
                : 'A copy of the card and your answer'}
              {draft.sources.length > 1
                ? `, and ${draft.sources.length - 1} more card${draft.sources.length > 2 ? 's' : ''} with the same cause you answered the same way`
                : ''}
              . Edit it so it covers the next card like this one.
            </p>
            <Field label="When">
              {({ id }) => (
                <TextArea id={id} rows={2} value={when} onChange={(e) => setWhen(e.target.value)} />
              )}
            </Field>
            <Field label="Do this">
              {({ id }) => (
                <TextArea id={id} rows={2} value={then} onChange={(e) => setThen(e.target.value)} />
              )}
            </Field>
            <fieldset className={s.scopes}>
              <legend className="type-label">Applies to</legend>
              {draft.scopes.map((x, i) => (
                <label key={x.kind} className={`${s.radio} type-body-small`}>
                  <input
                    type="radio"
                    name="mr-scope"
                    checked={scope === i}
                    onChange={() => setScope(i)}
                  />
                  {x.label}
                </label>
              ))}
              {draft.roles.length > 0 && (
                <Checkbox
                  label={`Only for this role (${draft.roles.join(', ')})`}
                  checked={onlyRole}
                  onChange={setOnlyRole}
                />
              )}
            </fieldset>
          </>
        )}
        <div className={s.actions}>
          <button type="button" className={`${s.btn} type-button`} onClick={closeOverlay}>
            Cancel
          </button>
          <button
            type="button"
            className={`${s.btn} ${s.primary} type-button`}
            disabled={!draft || busy || when.trim().length < 3 || then.trim().length < 3}
            onClick={() => void save()}
          >
            Save the rule
          </button>
        </div>
      </div>
    </Scrim>
  );
}
