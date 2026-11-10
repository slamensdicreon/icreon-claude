/*
 * What the next build knows: for one playbook, the rules its Leads apply, the lessons and
 * procedures its agents can be given (each brief carries the few that fit the task), and the known
 * gaps, which are engineering's and reach no agent. Each entry says how often it has been used, so
 * one that never is stands out. GET /playbooks/:id/in-force.
 */
import type { InForceEntry, InForceSnapshot } from '@lw/contracts';
import { useState } from 'react';
import { Field, Select } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Notice, usePlaybooks } from '../intake/shared';
import { count, FoldPanel, Lead, Pending, useResource } from './shared';
import s from './manage.module.css';

const SCOPE: Record<InForceEntry['scope']['kind'], string> = {
  global: 'Everywhere',
  platform: 'This platform',
  playbook: 'This playbook',
  role: 'This role, every playbook',
  project: 'One project',
};

function Entry({ e }: { e: InForceEntry }) {
  return (
    <div className={s.entry}>
      <div className={s.entryHead}>
        <span className={`${s.ref} type-meta`}>{e.ref}</span>
        <span className={`${s.entryTitle} type-body-small`}>{e.title}</span>
      </div>
      <p className={`${s.entryText} type-body-small`}>{e.text}</p>
      <div className={`${s.entryFacts} type-meta`}>
        <span>{e.kind === 'procedure' ? 'Procedure' : 'Lesson'}</span>
        <span>{SCOPE[e.scope.kind]}</span>
        <span className={e.used ? undefined : s.muted}>
          {e.used ? `Used in ${count(e.used, 'brief')}` : 'Not used yet'}
        </span>
      </div>
    </div>
  );
}

export function InForce() {
  const { playbooks } = usePlaybooks();
  const ready = (playbooks ?? []).filter((p) => p.roles.length);
  const [picked, setPicked] = useState<string | null>(null);
  const id = picked ?? ready[0]?.id ?? null;
  const { data, error } = useResource<InForceSnapshot>(
    id ? `/playbooks/${encodeURIComponent(id)}/in-force` : null,
    null,
    'What the playbook knows could not be loaded.',
  );

  return (
    <div className={s.page}>
      <Lead>
        What a new project starts with. The rules settle the cards they match before they reach you;
        each agent’s brief carries the few lessons and procedures that fit its task. Proposals do
        nothing until you approve them.
      </Lead>
      {ready.length > 1 && (
        <Field label="Playbook">
          {({ id: fieldId }) => (
            <Select id={fieldId} value={id ?? ''} onChange={(e) => setPicked(e.target.value)}>
              {ready.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.platform.name}, {p.version})
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {!data ? (
        <Pending error={error} loading="Loading what the playbook knows…" />
      ) : (
        <InForceBody data={data} />
      )}
    </div>
  );
}

function InForceBody({ data }: { data: InForceSnapshot }) {
  const unused = data.entries.filter((e) => !e.used).length;
  const everyRole = data.entries.filter((e) => !e.roles.length);
  const byRole = data.roles
    .map((r) => ({ ...r, entries: data.entries.filter((e) => e.roles.includes(r.role)) }))
    .filter((r) => r.entries.length);
  const waiting = data.pending.knowledge + data.pending.rules;
  return (
    <>
      <p className="type-body-small">
        A new {data.playbook.name} project starts with {count(data.rules.length, 'rule')} and{' '}
        {count(data.entries.length, 'lesson or procedure', 'lessons and procedures')}
        {unused ? `, ${unused} of them not used yet` : ''}.{' '}
        {data.gaps.length
          ? `${count(data.gaps.length, 'known gap')} ${data.gaps.length === 1 ? 'is' : 'are'} engineering’s and reach no agent.`
          : ''}
      </p>
      {waiting > 0 && (
        <Notice tone="waiting">
          {count(waiting, 'proposal')} would apply here once approved: Knowledge, Review proposals.
        </Notice>
      )}

      <Panel
        title="Rules"
        count={data.rules.length}
        meta="Applied by the Leads, before a card reaches you"
      >
        <div className={s.entries}>
          {data.rules.map((r) => (
            <div key={r.id} className={s.entry}>
              <div className={s.entryHead}>
                <span className={`${s.ref} type-meta`}>{r.ref}</span>
                <span className={`${s.entryTitle} type-body-small`}>When {r.when}</span>
              </div>
              <p className={`${s.entryText} type-body-small`}>{r.then}</p>
              <div className={`${s.entryFacts} type-meta`}>
                <span>{r.scope.kind === 'platform' ? 'This platform' : 'This playbook'}</span>
                <span className={r.applied ? undefined : s.muted}>
                  {r.applied ? `Applied ${count(r.applied, 'time')}` : 'Not applied yet'}
                </span>
                {r.flagged && <span>You overrode it {count(r.overridden, 'time')}</span>}
              </div>
            </div>
          ))}
          {!data.rules.length && <p className={`${s.quiet} type-body-small`}>No rules yet.</p>}
        </div>
      </Panel>

      {everyRole.length > 0 && (
        <Panel
          title="For every role"
          count={everyRole.length}
          meta="Lessons and procedures any agent can get"
        >
          <div className={s.entries}>
            {everyRole.map((e) => (
              <Entry key={e.id} e={e} />
            ))}
          </div>
        </Panel>
      )}
      {byRole.map((r) => (
        <FoldPanel key={r.role} title={r.name} meta={count(r.entries.length, 'entry', 'entries')}>
          <div className={s.entries}>
            {r.entries.map((e) => (
              <Entry key={e.id} e={e} />
            ))}
          </div>
        </FoldPanel>
      ))}

      {data.gaps.length > 0 && (
        <FoldPanel
          title="Known gaps"
          meta={`${count(data.gaps.length, 'gap')}, for engineering; no agent is given these`}
        >
          <div className={s.entries}>
            {data.gaps.map((g) => (
              <div key={g.id} className={s.entry}>
                <div className={s.entryHead}>
                  <span className={`${s.ref} type-meta`}>{g.ref}</span>
                  <span className={`${s.entryTitle} type-body-small`}>{g.title}</span>
                </div>
                <p className={`${s.entryText} type-body-small`}>{g.text}</p>
              </div>
            ))}
          </div>
        </FoldPanel>
      )}
    </>
  );
}
