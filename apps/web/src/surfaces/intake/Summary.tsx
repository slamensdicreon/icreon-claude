/*
 * The wizard's live summary: what has been chosen and typed so far, beside the step. It grows as
 * the Director goes; nothing in it is editable.
 */
import type { PlaybookSummary } from '@lw/contracts';
import type { ReactNode } from 'react';
import type { CatalogGroup } from '../../lib/showcase';
import {
  budgetLine,
  credentialCounts,
  credentialsOf,
  fieldsOf,
  fieldValue,
  type Answers,
  type Checks,
} from './model';
import s from './intake.module.css';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.sumRow}>
      <span className={`${s.sumLabel} type-label`}>{label}</span>
      {children}
    </div>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => (
  <span className={`${s.sumQuiet} type-meta`}>{children}</span>
);

export function Summary({
  entity,
  pb,
  answers,
  checks,
  provided,
  showSource,
}: {
  entity: CatalogGroup | null;
  pb: PlaybookSummary | null;
  answers: Answers;
  checks: Checks;
  provided: Set<string>;
  showSource: boolean;
}) {
  const { f } = answers;
  const targets = fieldsOf(pb).filter((fs) => fieldValue(fs, answers));
  const credentials = credentialsOf(pb);
  const counts = credentialCounts(credentials, checks, provided, answers.secrets);
  return (
    <aside className={s.summary} aria-label="Summary">
      <h2 className={`${s.sumTitle} type-section`}>Summary</h2>
      <Row label="Entity">
        {entity ? (
          <>
            <b className={s.sumName}>{entity.entity.name}</b>
            <Quiet>
              {entity.entity.vendor} · {entity.entity.category}
            </Quiet>
          </>
        ) : (
          <Quiet>Choose a platform</Quiet>
        )}
      </Row>
      <Row label="Playbook">
        {pb ? (
          <>
            <b className={s.sumName}>{pb.name}</b>
            <Quiet>{pb.charter.mission}</Quiet>
          </>
        ) : (
          <Quiet>Choose what the team delivers</Quiet>
        )}
      </Row>
      {pb && (
        <>
          <Row label="What you get">
            <ul className={s.sumList}>
              {pb.charter.outcomes.map((o) => (
                <li key={o.id} className="type-meta">
                  {o.title}
                </li>
              ))}
            </ul>
          </Row>
          <Row label="How it runs">
            <Quiet>
              {pb.phases.length} phases, {pb.phases.filter((ph) => ph.gate).length} Director gates ·
              a team of {pb.roles.length}
            </Quiet>
          </Row>
        </>
      )}
      {(f.name.trim() || f.client.trim()) && (
        <Row label="Project">
          <b className={s.sumName}>{f.name.trim() || '…'}</b>
          <Quiet>{[f.client.trim(), f.timezone].filter(Boolean).join(' · ')}</Quiet>
          <Quiet>{budgetLine(f)}</Quiet>
        </Row>
      )}
      {showSource && (f.repo.trim() || f.sourceUrl.trim()) && (
        <Row label="Source">
          {f.repo.trim() && (
            <Quiet>
              {f.repo.trim()} ({f.branch.trim() || 'main'})
            </Quiet>
          )}
          {f.sourceUrl.trim() && <Quiet>{f.sourceUrl.trim()}</Quiet>}
        </Row>
      )}
      {targets.length > 0 && (
        <Row label="Target">
          {targets.map((fs) => (
            <Quiet key={fs.key}>
              {fs.label}: {fieldValue(fs, answers)}
            </Quiet>
          ))}
        </Row>
      )}
      {counts.total > 0 && (
        <Row label="Credentials">
          <Quiet>
            {counts.verified} of {counts.total} verified
            {counts.fromConnection ? `, ${counts.fromConnection} from the connection` : ''}
          </Quiet>
        </Row>
      )}
      <p className={`${s.sumNote} type-meta`}>
        Every credential is checked here and again when the project is created; secrets are sealed
        and never shown again. Nothing runs until you press Start on Mission Control.
      </p>
    </aside>
  );
}
