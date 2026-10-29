import type { RuleDraftView, RuleView } from '@lw/contracts';
import { useEffect, useState } from 'react';
import { ApiProblem, postFor } from '../lib/api';
import { useApp } from '../state';
import { Scrim } from './Dialogs';

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
      .catch((e: unknown) =>
        setError(e instanceof ApiProblem ? e.message : 'The rule could not be drafted.'),
      );
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
      toast(`Rule ${rule.ref} saved. Leads apply it from the next card like this one.`);
      closeOverlay();
    } catch (e) {
      setError(e instanceof ApiProblem ? e.message : 'The rule could not be saved.');
      setBusy(false);
    }
  };

  return (
    <Scrim>
      <div className="dialog rule-dialog" role="dialog" aria-labelledby="mr-t">
        <h2 id="mr-t">Make this a rule</h2>
        {error && <p className="err">{error}</p>}
        {!draft && !error && <p className="quiet-line">Cypher is drafting it…</p>}
        {draft && (
          <>
            <p className="muted">
              {draft.draftedBy === 'cypher'
                ? 'Cypher drafted this from your answer'
                : 'A copy of the card and your answer'}
              {draft.sources.length > 1
                ? `, and ${draft.sources.length - 1} more card${draft.sources.length > 2 ? 's' : ''} with the same cause you answered the same way`
                : ''}
              . Edit it so it covers the next card like this one.
            </p>
            <label className="eyebrow" htmlFor="mr-when">
              When
            </label>
            <textarea
              id="mr-when"
              className="input"
              rows={2}
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
            <label className="eyebrow" htmlFor="mr-then">
              Do this
            </label>
            <textarea
              id="mr-then"
              className="input"
              rows={2}
              value={then}
              onChange={(e) => setThen(e.target.value)}
            />
            <fieldset className="mr-scope">
              <legend className="eyebrow">Applies to</legend>
              {draft.scopes.map((s, i) => (
                <label key={s.kind}>
                  <input
                    type="radio"
                    name="mr-scope"
                    checked={scope === i}
                    onChange={() => setScope(i)}
                  />
                  {s.label}
                </label>
              ))}
              {draft.roles.length > 0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={onlyRole}
                    onChange={(e) => setOnlyRole(e.target.checked)}
                  />
                  Only for this role ({draft.roles.join(', ')})
                </label>
              )}
            </fieldset>
          </>
        )}
        <div className="btn-row">
          <button className="btn" onClick={closeOverlay}>
            Cancel
          </button>
          <button
            className="btn primary"
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
