/*
 * Project settings (Everything only). Policies and budgets for one project, in the order a
 * Director needs them: the project and its build, access, budgets, who decides what, the record,
 * and the danger zone last. Secrets never appear here.
 *
 * This file loads the data and lays the groups out; each group's panels live in their own file
 * and the logic behind them in ./model.
 */
import type { SettingsSnapshot } from '@lw/contracts';
import type { ReactNode } from 'react';
import { useMission, useNow, useProjectResource } from '../../state';
import { usePlaybooks } from '../intake/shared';
import { CredentialsPanel, GithubAppPanel } from './AccessSections';
import { BudgetPanel } from './BudgetSection';
import { DangerZone } from './DangerZone';
import { ExportPanel } from './ExportPanel';
import {
  AutonomyPanel,
  EscalationPolicyPanel,
  GatesPanel,
  SendBackPanel,
  StandingApprovalsPanel,
} from './DecisionSections';
import {
  briefQuestions,
  credentialRows,
  declaredCredentials,
  hostingProjectOf,
  hoursSince,
  playbookOf,
} from './model';
import {
  BriefPanel,
  BuildRepoPanel,
  HostingPanel,
  IntakePanel,
  PlaybookPanel,
  SourceSitePanel,
} from './ProjectSections';
import { CapabilityGapsPanel, ConventionsPanel } from './RecordSections';
import s from './settings.module.css';

interface Group {
  id: string;
  label: string;
  /** Two columns that stack independently, so a short panel never leaves a hole beside a tall one. */
  left?: ReactNode[];
  right?: ReactNode[];
  /** Full-width panels under the columns. */
  full?: ReactNode[];
  /** One panel whose title says the same: no group label above it. */
  solo?: boolean;
}

export function SettingsPage() {
  const snapshot = useProjectResource<SettingsSnapshot>('/settings').data;
  const mc = useMission().data;
  const now = useNow(60_000);
  const { playbooks } = usePlaybooks();
  if (!snapshot || !mc) return <p className={`${s.loading} type-body-small`}>Loading settings…</p>;

  const p = mc.project;
  const live = !p.demo;
  const pb = playbookOf(playbooks, p);
  const declared = declaredCredentials(pb);
  const running = mc.phases.reduce((n, x) => n + x.tasksRunning, 0);

  const groups: Group[] = [];

  if (live)
    groups.push({
      id: 'project',
      label: 'The project',
      left: [
        <SourceSitePanel key="source" current={p.sourceUrl} />,
        p.intake && (
          <BuildRepoPanel
            key="build"
            repo={p.buildRepo}
            source={p.intake.repo ?? p.sourceUrl ?? p.name}
            projectName={p.name}
            platformId={p.platform?.id ?? 'sitecoreai'}
          />
        ),
      ],
      right: [
        p.playbook && (
          <PlaybookPanel
            key="playbook"
            id={p.playbook.id}
            version={p.playbook.version}
            list={playbooks}
          />
        ),
        p.intake && p.buildRepo && (
          <HostingPanel key="hosting" hosting={p.hosting} name={hostingProjectOf(p)} />
        ),
      ],
      full: [
        p.playbook && (
          <BriefPanel key="brief" current={p.brief} questions={briefQuestions(pb, p)} />
        ),
        p.intake && p.playbook && (
          <IntakePanel
            key="intake"
            values={p.intake.target}
            spec={pb?.intake ?? null}
            open={p.status === 'intake'}
          />
        ),
      ],
    });

  groups.push({
    id: 'access',
    label: 'Access',
    full: [
      <CredentialsPanel
        key="credentials"
        rows={credentialRows(snapshot.credentials, declared)}
        declared={declared}
        demo={p.demo}
        now={now}
      />,
      <GithubAppPanel key="github" />,
    ],
  });

  groups.push({
    id: 'budgets',
    label: 'Budgets',
    solo: true,
    full: [
      <BudgetPanel
        key="budgets"
        snapshot={snapshot}
        hours={hoursSince(p.startedAt, now)}
        editable={live}
      />,
    ],
  });

  groups.push({
    id: 'decisions',
    label: 'Who decides',
    left: [
      <GatesPanel key="gates" gates={snapshot.gates} />,
      snapshot.autonomy.length > 0 && <AutonomyPanel key="autonomy" rows={snapshot.autonomy} />,
    ],
    right: [
      <SendBackPanel key="sendback" on={snapshot.finishPastLimit} />,
      snapshot.standingApprovals.length > 0 && (
        <StandingApprovalsPanel key="standing" rows={snapshot.standingApprovals} />
      ),
    ],
    full: [<EscalationPolicyPanel key="policy" rows={snapshot.escalationPolicy} />],
  });

  groups.push({
    id: 'record',
    label: 'The record',
    left: [<ConventionsPanel key="conventions" conventions={snapshot.conventions} />],
    right: [<CapabilityGapsPanel key="gaps" gaps={snapshot.capabilityGaps} />],
  });

  if (live)
    groups.push({
      id: 'export',
      label: 'Take it with you',
      solo: true,
      full: [<ExportPanel key="export" projectId={p.id} />],
    });

  groups.push({
    id: 'danger',
    label: 'Danger zone',
    solo: true,
    full: [<DangerZone key="danger" project={p} rollback={snapshot.rollback} running={running} />],
  });

  return (
    <div className={s.page}>
      <div className={s.intro}>
        <p className={`${s.lead} type-body-small`}>
          Policies and budgets for this project. Secrets never appear here. Conventions are locked
          after Gate 1.
        </p>
        <Jump groups={groups} />
      </div>
      {groups.map((g) => (
        <section key={g.id} id={`settings-${g.id}`} className={s.group} aria-label={g.label}>
          {!g.solo && <p className={`${s.groupLabel} type-label`}>{g.label}</p>}
          {(g.left || g.right) && (
            <div className={s.columns}>
              <div className={s.column}>{g.left}</div>
              <div className={s.column}>{g.right}</div>
            </div>
          )}
          {g.full}
        </section>
      ))}
    </div>
  );
}

/**
 * A row of pills that scroll to each group. Buttons rather than #links: the app routes on the
 * path, and a fragment would add a history entry for a scroll.
 */
function Jump({ groups }: { groups: Group[] }) {
  const go = (id: string) => {
    const el = document.getElementById(`settings-${id}`);
    if (!el) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  };
  return (
    <nav className={s.jump} aria-label="Settings sections">
      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          className={`${s.jumpPill} type-meta`}
          data-danger={g.id === 'danger' || undefined}
          onClick={() => go(g.id)}
        >
          {g.label}
        </button>
      ))}
    </nav>
  );
}
