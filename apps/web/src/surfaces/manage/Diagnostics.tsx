/*
 * The services the system runs on, what across projects needs attention, and each project's
 * orchestrator. The same poll as the old page (Diagnostics in surfaces/Dashboard.tsx), with every
 * state carried by a word beside its dot.
 */
import type { PortfolioDiagnostics, ProjectStatus } from '@lw/contracts';
import { useState } from 'react';
import { messageOf, postFor } from '../../lib/api';
import { useApp } from '../../state';
import { Status } from '../../ui/cypher/forms';
import { Button, Panel } from '../../ui/cypher/parts';
import { Notice } from '../intake/shared';
import { count, Pending, useResource } from './shared';
import s from './manage.module.css';

type Tone = 'ok' | 'waiting' | 'bad' | 'idle';

const PROJECT_STATUS: Record<ProjectStatus, string> = {
  intake: 'Ready to start',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

const SERVICE: Record<string, [Tone, string]> = {
  ok: ['ok', 'Working'],
  degraded: ['waiting', 'Degraded'],
  down: ['bad', 'Down'],
  unknown: ['idle', 'Unknown'],
};
const ORCHESTRATOR: Record<string, [Tone, string]> = {
  ok: ['ok', 'Running'],
  stalled: ['waiting', 'Stalled'],
  ended: ['idle', 'Ended'],
  unknown: ['idle', 'Unknown'],
};

export function Diagnostics() {
  const { switchProject } = useApp();
  const { data, error } = useResource<PortfolioDiagnostics>(
    '/portfolio/diagnostics',
    30_000,
    'Diagnostics could not be loaded.',
  );
  if (!data) return <Pending error={error} loading="Checking services and projects…" />;
  const attention = data.projects.filter(
    (p) => p.attention.length > 0 || p.orchestrator.status === 'stalled',
  );
  const healthy = data.services.filter((x) => x.status === 'ok').length;
  return (
    <div className={s.page}>
      {error && <Notice tone="bad">{error}</Notice>}
      <div className={s.columns}>
        <Panel title="Services" meta={`${healthy} of ${data.services.length} working`}>
          <ul className={s.rows}>
            {data.services.map((x) => {
              const [tone, word] = SERVICE[x.status] ?? ['idle', x.status];
              return (
                <li key={x.key} className={s.row}>
                  <span className={s.rowText}>
                    <span className={s.strong}>{x.label}</span>
                    <span className={`${s.muted} type-meta`}>{x.detail}</span>
                    {x.key === 'operator' && <TestEmail />}
                  </span>
                  <Status tone={tone}>{word}</Status>
                </li>
              );
            })}
            {!data.services.some((x) => x.key === 'operator') && (
              <li className={s.row}>
                <span className={s.rowText}>
                  <span className={s.strong}>Operator email</span>
                  <span className={`${s.muted} type-meta`}>
                    Check that the Operator&rsquo;s email reaches you.
                  </span>
                  <TestEmail />
                </span>
              </li>
            )}
          </ul>
        </Panel>
        <Panel
          title="Needs attention"
          meta={attention.length ? count(attention.length, 'project') : 'Nothing'}
        >
          {attention.length === 0 ? (
            <p className={`${s.empty} type-body-small`}>Nothing across projects needs attention.</p>
          ) : (
            <ul className={s.rows}>
              {attention.map((p) => {
                const stalled = p.orchestrator.status === 'stalled';
                return (
                  <li key={p.projectId} className={s.row}>
                    <span className={s.rowText}>
                      <button
                        type="button"
                        className={s.linkButton}
                        onClick={() => switchProject(p.projectId)}
                      >
                        {p.name}
                      </button>
                      <span className={`${s.muted} type-meta`}>
                        {p.attention.join('; ') || p.orchestrator.detail}
                      </span>
                    </span>
                    <Status tone="waiting">{stalled ? 'Stalled' : 'Attention'}</Status>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
      <Panel title="Orchestrators" meta={count(data.projects.length, 'project')}>
        <div className={s.tableWrap}>
          <table className={`${s.table} ${s.stackOnPhone} type-table`}>
            <caption className="sr-only">Each project’s orchestrator</caption>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Project status</th>
                <th scope="col">Orchestrator</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p) => {
                const [tone, word] = ORCHESTRATOR[p.orchestrator.status] ?? [
                  'idle',
                  p.orchestrator.status,
                ];
                return (
                  <tr key={p.projectId}>
                    <th scope="row" className={s.strong}>
                      {p.name}
                    </th>
                    <td className={s.muted}>{PROJECT_STATUS[p.status]}</td>
                    <td>
                      <Status tone={tone}>{word}</Status>
                    </td>
                    <td className={s.muted}>{p.orchestrator.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/**
 * Sends the Operator's test email (POST /projects/:id/operator/test-email) to the configured
 * recipients, with a live project's open cards as the example, and says what happened: sent, or
 * Resend's own reason for refusing (an unverified sender domain, a key from another account).
 */
function TestEmail() {
  const { projects, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const project =
    projects.find((p) => p.status === 'running') ??
    projects.find((p) => p.status !== 'archived' && p.status !== 'cancelled') ??
    projects[0];
  if (!project) return null;
  const send = async () => {
    setBusy(true);
    try {
      await postFor<{ sent: boolean; id: string }>(
        `/projects/${encodeURIComponent(project.id)}/operator/test-email`,
        {},
      );
      toast({
        title: 'Test email sent',
        detail: `The Operator wrote to your recipients, with ${project.name}'s open cards as the example.`,
        tone: 'done',
      });
    } catch (err) {
      toast({
        title: 'The test email didn’t go out',
        detail: messageOf(err, 'The Control API could not send it.'),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={s.testEmail}>
      <Button kind="secondary" onClick={() => void send()} disabled={busy}>
        {busy ? 'Sending…' : 'Send a test email'}
      </Button>
    </span>
  );
}
