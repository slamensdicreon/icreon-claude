/*
 * The pieces New project and Project settings share: the brief's questions, a credential's
 * fields, a live access test with its answer, the playbook catalog, and the two small controls
 * the Cypher kit doesn't have (a pill button that can submit a form or warn, and a notice line).
 */
import type { BriefQuestion, IntakeCredentialSpec, PlaybookSummary } from '@lw/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { get, messageOf } from '../../lib/api';
import { Field, Select, TextArea, TextInput } from '../../ui/cypher/forms';
import type { Check } from './model';
import s from './shared.module.css';

/* ---------- controls ---------- */

/**
 * A pill button, 44px or taller. `primary` is ink; `secondary` a mist outline; `danger` coral text
 * on surface, for what can't be undone; `quiet` a text button.
 */
export function Action({
  children,
  onClick,
  kind = 'secondary',
  type = 'button',
  disabled,
  expanded,
  label,
  controls,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'quiet';
  type?: 'button' | 'submit';
  disabled?: boolean;
  /** For a button that opens a form below it. */
  expanded?: boolean;
  /** An accessible name, when the words alone don't say what the button acts on. */
  label?: string;
  controls?: string;
}) {
  return (
    <button
      type={type}
      className={`${s.action} type-button`}
      data-kind={kind}
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      aria-label={label}
      aria-controls={controls}
    >
      {children}
    </button>
  );
}

/** A row of buttons, wrapping on a phone. */
export function Actions({ children, end }: { children: ReactNode; end?: boolean }) {
  return (
    <div className={s.actions} data-end={end || undefined}>
      {children}
    </div>
  );
}

/** Buttons beside a field, lined up with its input rather than its label or hint. */
export function BesideField({ children }: { children: ReactNode }) {
  return (
    <div className={s.beside}>
      <span className="type-label" aria-hidden="true">
        &nbsp;
      </span>
      <div className={s.actions}>{children}</div>
    </div>
  );
}

/**
 * A line that states where something stands, colored by meaning (§5): `ok` green, `waiting` gold,
 * `bad` coral (missing, failed or the Director's to do), `idle` quiet. Wraps, unlike a Status chip.
 */
export function Notice({
  tone,
  children,
  live,
}: {
  tone: 'ok' | 'waiting' | 'bad' | 'idle';
  children: ReactNode;
  /** Announce it when it changes (a test's answer). */
  live?: boolean;
}) {
  return (
    <p className={`${s.notice} type-meta`} data-tone={tone} role={live ? 'status' : undefined}>
      <i aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

/* ---------- the brief ---------- */

/** The brief's questions as fields: a text area, or a choice (yes or no, or the options). */
export function BriefFields({
  questions,
  answers,
  onChange,
}: {
  questions: BriefQuestion[];
  answers: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className={s.stack}>
      {questions.map((q) => (
        <Field key={q.key} label={q.label} optional={!q.required} hint={q.hint}>
          {({ id, describedBy }) =>
            q.kind === 'text' ? (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={2}
                placeholder={q.placeholder ?? ''}
                value={answers[q.key] ?? ''}
                onChange={(e) => onChange(q.key, e.target.value)}
              />
            ) : (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={answers[q.key] ?? ''}
                onChange={(e) => onChange(q.key, e.target.value)}
              >
                <option value="">Choose…</option>
                {(q.kind === 'yesno' ? ['yes', 'no'] : q.options).map((o) => (
                  <option key={o} value={o}>
                    {q.kind === 'yesno' ? (o === 'yes' ? 'Yes' : 'No') : o}
                  </option>
                ))}
              </Select>
            )
          }
        </Field>
      ))}
    </div>
  );
}

/** "Yes" for a yes-no answer, the answer itself otherwise. */
export const answerWord = (answer: string) =>
  answer === 'yes' ? 'Yes' : answer === 'no' ? 'No' : answer;

/* ---------- a credential ---------- */

/**
 * A credential's fields. Secret ones are password fields the browser doesn't fill; nothing typed
 * here is ever shown back once saved.
 */
export function CredentialFields({
  spec,
  values,
  onChange,
}: {
  spec: IntakeCredentialSpec;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className={s.grid}>
      {spec.fields.map((f) => (
        <Field key={f.key} label={f.label}>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              type={f.secret ? 'password' : 'text'}
              autoComplete={f.secret ? 'new-password' : 'off'}
              spellCheck={false}
              value={values[f.key] ?? ''}
              onChange={(e) => onChange(f.key, e.target.value)}
            />
          )}
        </Field>
      ))}
    </div>
  );
}

/** A live test against the service (POST /intake/verify), and its answer beside the button. */
export function TestRow({
  label,
  ready,
  check,
  onTest,
}: {
  /** What is tested: "access", "connection", "Context ID". */
  label: string;
  ready: boolean;
  check: Check | undefined;
  onTest: () => void;
}) {
  const c = check ?? { state: 'idle' };
  return (
    <div className={s.test}>
      <Action disabled={!ready || c.state === 'busy'} onClick={onTest}>
        {c.state === 'busy' ? 'Testing…' : `Test ${label}`}
      </Action>
      {c.state === 'done' && (
        <Notice tone={c.ok ? 'ok' : 'bad'} live>
          {c.detail}
        </Notice>
      )}
    </div>
  );
}

/* ---------- the catalog ---------- */

/**
 * GET /playbooks, once: what each playbook declares (its charter, intake steps, credentials and
 * brief). While loading it is null; a failure leaves an empty list and the API's words.
 */
export function usePlaybooks(): { playbooks: PlaybookSummary[] | null; error: string | null } {
  const [playbooks, setPlaybooks] = useState<PlaybookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    get<PlaybookSummary[]>('/playbooks')
      .then((list) => live && setPlaybooks(list))
      .catch((err: unknown) => {
        if (!live) return;
        setPlaybooks([]);
        setError(messageOf(err, 'The playbooks could not be loaded.'));
      });
    return () => {
      live = false;
    };
  }, []);
  return { playbooks, error };
}
