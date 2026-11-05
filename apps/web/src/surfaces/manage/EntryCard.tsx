/*
 * One entry a Director governs, a rule or a piece of knowledge: what it says, where it applies,
 * how it has done, and the actions on it (approve, edit, reject or retire, history, what it
 * stands on). Rules and Knowledge used to keep near copies of this card; both pages (and the
 * Workbench's Lessons learned) now render this one.
 */
import { useState, type ReactNode } from 'react';
import { messageOf } from '../../lib/api';
import { age } from '../../lib/fmt';
import { useApp, useNow } from '../../state';
import { Eye } from '../../ui/Eye';
import { Field, TextArea, TextInput } from '../../ui/cypher/forms';
import { Action, Actions, Notice } from '../intake/shared';
import s from './manage.module.css';

export type EntryStatus = 'proposed' | 'active' | 'retired';

export interface EditField {
  key: string;
  label: string;
  value: string;
  /** Rows for a text area; a one-line input without it. */
  rows?: number;
}

/** A state change: the call, and what the toast says when it worked. */
export interface EntryAction {
  label: string;
  run: () => Promise<unknown>;
  done: string;
}

export interface HistoryLine {
  at: string;
  text: string;
}

const MIN = 3;

export function EntryCard({
  refId,
  status,
  pill,
  where,
  author,
  updatedAt,
  view,
  edit,
  facts,
  flag,
  approve,
  retire,
  history,
  evidence,
  onChange,
}: {
  /** The display id, "R-7" or "K-12". */
  refId: string;
  status: EntryStatus;
  /** The category of a rule or the kind of an entry. */
  pill: string;
  /** Where it applies, then who it is for: short phrases shown after the pill. */
  where: string[];
  /** Who wrote it. Cypher is shown as the eye beside its name. */
  author: 'cypher' | 'director' | 'seed';
  updatedAt: string;
  /** The entry as it reads. */
  view: ReactNode;
  /** The fields Edit opens, and the call that saves them. */
  edit: { fields: EditField[]; save: (values: Record<string, string>) => Promise<unknown> };
  /** How it has done and its version, one line. */
  facts: string;
  /** A warning the Director should act on ("you keep overriding it"). */
  flag?: string | null;
  approve?: EntryAction | null;
  retire: EntryAction;
  history: () => Promise<HistoryLine[]>;
  evidence?: { summary: string; items: { key: string; text: string }[] } | null;
  onChange: () => void;
}) {
  // Keeps the relative times ("12 min ago") current.
  const now = useNow(15_000);
  const { toast } = useApp();
  const [editing, setEditing] = useState(false);
  const initial = () => Object.fromEntries(edit.fields.map((f) => [f.key, f.value]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<HistoryLine[] | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);

  /** Runs a change; true when it worked. A failure keeps whatever is open, open. */
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
      onChange();
      return true;
    } catch (err) {
      toast(messageOf(err, 'That did not work. Try again.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (await act(() => edit.save(values), `${refId} saved.`)) setEditing(false);
  };

  const toggleHistory = () => {
    if (lines) return setLines(null);
    setLoadingHistory(true);
    history()
      .then(setLines)
      .catch((err: unknown) =>
        toast(messageOf(err, `The history of ${refId} could not be loaded.`)),
      )
      .finally(() => setLoadingHistory(false));
  };

  const ready = edit.fields.every((f) => (values[f.key] ?? '').trim().length >= MIN);
  const historyId = `history-${refId}`;
  const by = author === 'cypher' ? 'Cypher' : author === 'seed' ? 'the platform’s pitfalls' : 'you';

  return (
    <article className={s.entry} data-status={status} aria-label={refId}>
      <div className={s.entryHead}>
        <span className={`${s.ref} type-label`}>{refId}</span>
        <span className={`${s.pill} type-meta`}>{pill}</span>
        {where.map((w) => (
          <span key={w} className={`${s.where} type-meta`}>
            {w}
          </span>
        ))}
      </div>

      {editing ? (
        <form
          className={s.entryEdit}
          aria-label={`Edit ${refId}`}
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void save();
          }}
        >
          {edit.fields.map((f) => (
            <Field key={f.key} label={f.label}>
              {({ id, describedBy }) =>
                f.rows ? (
                  <TextArea
                    id={id}
                    aria-describedby={describedBy}
                    rows={f.rows}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                ) : (
                  <TextInput
                    id={id}
                    aria-describedby={describedBy}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                )
              }
            </Field>
          ))}
          <Actions>
            <Action kind="primary" type="submit" disabled={!ready || busy}>
              {busy ? 'Saving…' : 'Save'}
            </Action>
            <Action
              onClick={() => {
                setValues(initial());
                setEditing(false);
              }}
            >
              Cancel
            </Action>
          </Actions>
        </form>
      ) : (
        <div className={s.entryBody}>{view}</div>
      )}

      {flag && <Notice tone="bad">{flag}</Notice>}

      <p className={`${s.entryFacts} type-meta`}>
        {facts} By{' '}
        {author === 'cypher' && (
          <span className={s.eyeInline}>
            <Eye state="resting" size={20} decorative />
          </span>
        )}
        {by}, {age(updatedAt, now)}.
      </p>

      {!editing && (
        <Actions>
          {approve && (
            <Action
              kind="primary"
              disabled={busy}
              label={`${approve.label} ${refId}`}
              onClick={() => void act(approve.run, approve.done)}
            >
              {approve.label}
            </Action>
          )}
          {status !== 'retired' && (
            <Action label={`Edit ${refId}`} disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </Action>
          )}
          {status !== 'retired' && (
            <Action
              label={`${retire.label} ${refId}`}
              disabled={busy}
              onClick={() => void act(retire.run, retire.done)}
            >
              {retire.label}
            </Action>
          )}
          <Action
            kind="quiet"
            expanded={lines !== null}
            controls={lines ? historyId : undefined}
            label={`${lines ? 'Hide history of' : 'History of'} ${refId}`}
            disabled={loadingHistory}
            onClick={toggleHistory}
          >
            {loadingHistory ? 'Loading…' : lines ? 'Hide history' : 'History'}
          </Action>
        </Actions>
      )}

      {lines && (
        <ul id={historyId} className={`${s.history} type-meta`} aria-label={`History of ${refId}`}>
          {lines.length === 0 && <li>Nothing recorded yet.</li>}
          {lines.map((h, i) => (
            <li key={i}>
              <span>{h.text}</span>
              <span className={s.historyWhen}>{age(h.at, now)}</span>
            </li>
          ))}
        </ul>
      )}

      {evidence && evidence.items.length > 0 && (
        <details className={s.evidence}>
          <summary className="type-meta">{evidence.summary}</summary>
          <ul className={`${s.history} type-meta`}>
            {evidence.items.map((x) => (
              <li key={x.key}>{x.text}</li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
