/*
 * Budgets: what is spent of each limit, with a bar colored by meaning (gold from 80%, when new
 * tasks wait; coral at 100%, when the project pauses), and the form that changes the limits.
 */
import type { SettingsSnapshot } from '@lw/contracts';
import { useState } from 'react';
import { put } from '../../lib/api';
import { usd } from '../../lib/fmt';
import { useApp } from '../../state';
import { Field, TextInput } from '../../ui/cypher/forms';
import { Bar, Panel } from '../../ui/cypher/parts';
import { Action, Actions } from '../intake/shared';
import {
  budgetBody,
  budgetDraft,
  budgetHue,
  budgetLines,
  budgetValid,
  type BudgetDraft,
} from './model';
import s from './settings.module.css';

export function BudgetPanel({
  snapshot,
  hours,
  editable,
}: {
  snapshot: SettingsSnapshot;
  hours: number;
  editable: boolean;
}) {
  const lines = budgetLines(snapshot, hours, usd);
  return (
    <Panel title="Budgets" padded>
      <div className={s.stack}>
        <p className={s.lead}>
          At 80% of any budget, new tasks wait until you acknowledge. At 100% the project pauses;
          raising the budget past what is spent resumes it. Time counts from Start.
        </p>
        <div className={s.budgets}>
          {lines.map((l) => (
            <div key={l.key} className={s.budget}>
              <span className={`${s.budgetLabel} type-label`}>{l.label}</span>
              <span className={s.budgetNumber}>
                <span className="type-number">{l.used}</span>{' '}
                <span className={`${s.unit} type-number-unit`}>{l.limit}</span>
              </span>
              <Bar percent={Math.min(100, l.pct ?? 0)} hue={budgetHue(l.pct)} label={false} />
              <span className={`${s.quiet} type-meta`}>
                {l.pct === null ? 'No limit set' : `${l.pct}% used`}
              </span>
            </div>
          ))}
        </div>
        {editable && <BudgetForm current={snapshot.budgets} />}
      </div>
    </Panel>
  );
}

/** The project's limits, changed while it runs. */
function BudgetForm({ current }: { current: SettingsSnapshot['budgets'] }) {
  const { projectId, run } = useApp();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<BudgetDraft>({ usd: '', tokens: '', hours: '' });
  if (!open)
    return (
      <Actions>
        <Action
          onClick={() => {
            setV(budgetDraft(current));
            setOpen(true);
          }}
        >
          Change budgets
        </Action>
      </Actions>
    );
  const valid = budgetValid(v);
  const field = (key: keyof BudgetDraft, label: string, unit: string) => (
    <Field label={label} hint={unit}>
      {({ id, describedBy }) => (
        <TextInput
          id={id}
          aria-describedby={describedBy}
          inputMode="decimal"
          value={v[key]}
          onChange={(e) => setV((x) => ({ ...x, [key]: e.target.value }))}
        />
      )}
    </Field>
  );
  return (
    <form
      className={s.budgetForm}
      aria-label="Change budgets"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid)
          void run(
            () => put(`/projects/${projectId}/budgets`, budgetBody(v)),
            'Budgets saved.',
          ).then((ok) => ok && setOpen(false));
      }}
    >
      <div className={s.three}>
        {field('usd', 'Cost', 'USD')}
        {field('tokens', 'Tokens', 'Million')}
        {field('hours', 'Time', 'Hours from Start')}
      </div>
      <Actions>
        <Action kind="primary" type="submit" disabled={!valid}>
          Save budgets
        </Action>
        <Action onClick={() => setOpen(false)}>Cancel</Action>
      </Actions>
    </form>
  );
}
