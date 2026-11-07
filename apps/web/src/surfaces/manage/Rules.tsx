/*
 * Rules from the Director's answers, across every project: when this happens, do that. Lead
 * triage applies the active ones in their scope; proposed ones wait here for approval. The same
 * calls as the old page (surfaces/Rules.tsx), on Cypher's parts.
 */
import type { PortfolioItem, RuleHistoryItem, RuleView } from '@lw/contracts';
import { DECISION_CATEGORY_LABEL } from '@lw/contracts/labels';
import { useState } from 'react';
import { get, messageOf, post, postFor, put } from '../../lib/api';
import { useApp } from '../../state';
import { Field, Select } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Action, BesideField, Notice } from '../intake/shared';
import { usePlaybooks } from '../intake/shared';
import { EntryCard } from './EntryCard';
import {
  catalogNames,
  count,
  FoldPanel,
  Lead,
  Pending,
  useResource,
  type CatalogNames,
} from './shared';
import { ProposalReview } from './ProposalReview';
import s from './manage.module.css';

const HISTORY: Record<RuleHistoryItem['kind'], string> = {
  created: 'Created',
  edited: 'Edited',
  activated: 'Activated',
  retired: 'Retired',
  applied: 'Applied',
  overridden: 'Overridden by you',
};

export function Rules({ projects }: { projects: PortfolioItem[] }) {
  const {
    data: rules,
    error,
    reload,
  } = useResource<RuleView[]>('/rules', null, 'Rules could not be loaded.');
  const names = catalogNames(usePlaybooks().playbooks);
  const harvest = <Harvest projects={projects.filter((p) => !p.demo)} onDone={reload} />;
  if (!rules) return <Pending error={error} loading="Loading rules…" />;

  const scopeOf = (r: RuleView) =>
    r.scope.kind === 'project'
      ? `Project: ${projects.find((p) => p.id === r.scope.id)?.name ?? r.scope.id}`
      : r.scope.kind === 'playbook'
        ? `Every project on the ${names.playbook(r.scope.id)} playbook`
        : `Every project on the ${names.platform(r.scope.id)} platform`;
  const card = (r: RuleView) => (
    <RuleCard key={r.id} r={r} scope={scopeOf(r)} names={names} onChange={reload} />
  );
  const of = (status: RuleView['status']) => rules.filter((r) => r.status === status);
  const proposed = of('proposed');
  const active = of('active');
  const retired = of('retired');

  return (
    <div className={s.page}>
      <Lead>
        When this happens, do that. The Leads apply the active rules to cards in their scope, so you
        aren’t asked the same thing twice; proposed rules apply nowhere until you approve them.
      </Lead>
      {error && <Notice tone="bad">{error}</Notice>}
      <ProposalReview waiting={proposed.length} onDone={reload} />
      {harvest}
      {rules.length === 0 && (
        <Panel title="No rules yet" padded>
          <Lead>
            On a card you answered, choose “Make this a rule”: the Leads then apply it to the next
            card like it, so you aren’t asked again.
          </Lead>
        </Panel>
      )}
      {proposed.length > 0 && (
        <Panel title="Proposed" count={proposed.length} meta="Waiting for you">
          <div className={s.entries}>{proposed.map(card)}</div>
        </Panel>
      )}
      {active.length > 0 && (
        <Panel title="Active" meta={count(active.length, 'rule')}>
          <div className={s.entries}>{active.map(card)}</div>
        </Panel>
      )}
      {retired.length > 0 && (
        <FoldPanel title="Retired" meta={count(retired.length, 'rule')}>
          <div className={s.entries}>{retired.map(card)}</div>
        </FoldPanel>
      )}
    </div>
  );
}

function RuleCard({
  r,
  scope,
  names,
  onChange,
}: {
  r: RuleView;
  scope: string;
  names: CatalogNames;
  onChange: () => void;
}) {
  const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  return (
    <EntryCard
      refId={r.ref}
      status={r.status}
      pill={DECISION_CATEGORY_LABEL[r.category]}
      where={[scope, ...(r.roles.length ? [`Only for ${r.roles.map(names.role).join(', ')}`] : [])]}
      author={r.author}
      updatedAt={r.updatedAt}
      view={
        <p className={`${s.ruleText} type-body-small`}>
          <b>When</b> {r.when}, <b>then</b> {r.then}.
        </p>
      }
      edit={{
        fields: [
          { key: 'when', label: 'When', value: r.when, rows: 2 },
          { key: 'then', label: 'Do this', value: r.then, rows: 2 },
        ],
        save: (v) => put(`/rules/${r.id}`, { when: v.when, then: v.then }),
      }}
      facts={`Applied ${times(r.applied)}, overridden ${times(r.overridden)}. Version ${r.version}, from ${count(r.sources.length, 'card')}.`}
      flag={r.flagged ? 'You keep overriding it: edit it or retire it.' : null}
      approve={
        r.status === 'proposed'
          ? {
              label: 'Approve',
              run: () => post(`/rules/${r.id}/activate`),
              done: `${r.ref} is active.`,
            }
          : null
      }
      retire={{
        label: r.status === 'proposed' ? 'Reject' : 'Retire',
        run: () => post(`/rules/${r.id}/retire`),
        done: `${r.ref} is retired.`,
      }}
      history={() =>
        get<RuleHistoryItem[]>(`/rules/${r.id}/history`).then((list) =>
          list.map((h) => ({
            at: h.at,
            text: `${HISTORY[h.kind]}${
              typeof h.detail.escalationId === 'string' &&
              !h.detail.escalationId.startsWith('task:')
                ? ` (card ${h.detail.escalationId})`
                : ''
            }`,
          })),
        )
      }
      evidence={{
        summary: 'The cards it came from',
        items: r.sources.slice(0, 10).map((x) => ({
          key: x.escalationId,
          text: `${x.title}${x.answer ? `: ${x.answer}` : ''}`,
        })),
      }}
      onChange={onChange}
    />
  );
}

/** Reads a project's answered cards and proposes a rule for each cause seen twice or more. */
function Harvest({ projects, onDone }: { projects: PortfolioItem[]; onDone: () => void }) {
  const { toast } = useApp();
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  if (!projects.length) return null;
  // The first project until one is chosen: the list polls, so the choice can't be fixed at mount.
  const projectId = projects.some((p) => p.id === picked) ? picked : projects[0]!.id;
  return (
    <Panel title="Propose rules" meta="From a project’s answers" padded>
      <form
        className={s.inline}
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          postFor<{ proposed: RuleView[] }>(`/projects/${projectId}/rules/harvest`, {})
            .then((r) => {
              toast(
                r.proposed.length
                  ? `${count(r.proposed.length, 'rule')} proposed. Approve the ones that hold.`
                  : 'No new causes to propose: each repeated answer already has a rule.',
              );
              onDone();
            })
            .catch((err: unknown) => toast(messageOf(err, 'Rules could not be proposed.')))
            .finally(() => setBusy(false));
        }}
      >
        <Field
          label="Project"
          hint="Each cause you answered the same way twice or more becomes a proposed rule."
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              aria-describedby={describedBy}
              value={projectId}
              onChange={(e) => setPicked(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <BesideField>
          <Action type="submit" disabled={busy}>
            {busy ? 'Reading the answers…' : 'Propose rules'}
          </Action>
        </BesideField>
      </form>
    </Panel>
  );
}
