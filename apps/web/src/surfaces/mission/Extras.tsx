/*
 * Mission Control's other states: presentation mode (the project on a big screen, with the Floor
 * as its centrepiece), a project waiting to start (the wizard recorded it; nothing has run), and
 * the line that says what changed while the Director was away.
 */
import type {
  ActivityPage,
  MissionControlSnapshot,
  PlanSnapshot,
  SettingsSnapshot,
} from '@lw/contracts';
import { post } from '../../lib/api';
import { Floor } from '../../scene/Floor';
import { useApp, useProjectResource } from '../../state';
import { Icon } from '../../theme/icons';
import { Facts } from '../../ui/cypher/forms';
import { Button, Kpi, Panel, PhaseStrip } from '../../ui/cypher/parts';
import { phaseOwners, stripOf, word } from './model';
import s from './extras.module.css';

/** Presentation mode: the name and phase large, the phases, the Floor live, three numbers. */
export function Present({ mc }: { mc: MissionControlSnapshot }) {
  const plan = useProjectResource<PlanSnapshot>('/plan').data ?? null;
  const act = useProjectResource<ActivityPage>('/activity?view=log&limit=150').data;
  const p = mc.project;
  const lead = mc.phases.find((x) => x.status === 'current');
  const parity = mc.metrics.find((m) => m.key === 'parity');
  const running = mc.phases.reduce((n, x) => n + x.tasksRunning, 0);
  const queued = mc.phases.reduce((n, x) => n + x.tasksQueued, 0);
  const done = mc.phases.reduce((n, x) => n + x.tasksDone, 0);
  const total = mc.phases.reduce((n, x) => n + x.tasksTotal, 0);
  return (
    <div className={s.present}>
      <h1 className={`${s.presentTitle} type-display`}>
        {p.name}
        <span className="type-voice">
          {lead
            ? `${lead.shortName || lead.name}, phase ${word(lead.number)} of ${word(mc.phases.length)}`
            : p.status === 'completed'
              ? 'Accepted'
              : 'Not started'}
        </span>
      </h1>
      <PhaseStrip phases={stripOf(mc, phaseOwners(plan))} labelled />
      <div className={s.floor}>
        <Floor items={act?.items ?? null} hero />
      </div>
      <div className={s.kpis}>
        <Kpi
          label="Parity"
          value={parity?.value == null ? '–' : `${parity.value}%`}
          note={parity?.value == null ? 'Not yet measured' : 'Source against target'}
        />
        <Kpi label="Tasks running" value={String(running)} note={`${queued} queued`} />
        <Kpi
          label="Tasks done"
          value={`${done} of ${total}`}
          note={
            total
              ? `${Math.round((done / total) * 100)} percent of the plan`
              : 'Nothing planned yet'
          }
        />
      </div>
    </div>
  );
}

/** A project the wizard recorded: what it will work on, its credentials, and Start. */
export function ReadyToStart({ mc }: { mc: MissionControlSnapshot }) {
  const { projectId, run } = useApp();
  const settings = useProjectResource<SettingsSnapshot>('/settings').data;
  const i = mc.project.intake;
  const creds = settings?.credentials ?? null;
  const rows: [string, string][] = [];
  if (i?.repo) rows.push(['Source', `${i.repo} (${i.branch})`]);
  if (i)
    rows.push([
      'Target',
      Object.values(i.target)
        .map((v) => (Array.isArray(v) ? v.join(', ') : v))
        .join(' · '),
    ]);
  rows.push([
    'Credentials',
    creds === null
      ? 'Checking…'
      : creds.length
        ? creds
            .map(
              (c) => `${c.system} ${c.provided ? (c.ok ? 'verified' : 'failed') : 'not connected'}`,
            )
            .join(', ')
        : 'None needed',
  ]);
  return (
    <div className={s.ready}>
      <Panel title="Ready to start" padded>
        <div className={s.readyBody}>
          <p className="type-body">
            Intake is recorded and its credentials are verified and sealed. Nothing has run yet: no
            agent has touched the repository or the {mc.project.platform?.name ?? 'CMS'}{' '}
            environment.
          </p>
          <Facts rows={rows} />
          <div>
            <Button
              kind="primary"
              onClick={() =>
                void run(() => post(`/projects/${projectId}/start`), `Starting ${mc.project.name}`)
              }
            >
              Start project
            </Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/** "Since you were away…", until dismissed. */
export function AwayLine() {
  const { ui, setUi } = useApp();
  if (!ui.awayLine) return null;
  return (
    <div className={s.away} role="status">
      <Icon name="info" />
      <span className="type-body-small">{ui.awayLine}</span>
      <button
        type="button"
        className={`${s.dismiss} type-button`}
        onClick={() => setUi({ awayLine: null })}
      >
        Dismiss
      </button>
    </div>
  );
}
