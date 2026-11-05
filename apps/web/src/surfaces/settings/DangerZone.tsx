/*
 * The danger zone: pause or resume the whole project, roll back the current phase, reset to
 * intake (with or without a new build repository), archive. Everything but Resume asks first in a
 * TypedConfirm; what can't be undone asks for a typed word.
 */
import type { ProjectSummary, SettingsSnapshot } from '@lw/contracts';
import type { ReactNode } from 'react';
import { post } from '../../lib/api';
import { TypedConfirm } from '../../overlays/Dialogs';
import { useApp } from '../../state';
import { Panel } from '../../ui/cypher/parts';
import { Action, Actions } from '../intake/shared';
import s from './settings.module.css';

function Row({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <li className={s.dangerRow}>
      <span className={s.rowText}>
        <span className={s.strong}>{title}</span>
        {note && <span className={`${s.muted} type-meta`}>{note}</span>}
      </span>
      <Actions end>{children}</Actions>
    </li>
  );
}

export function DangerZone({
  project: p,
  rollback,
  running,
}: {
  project: ProjectSummary;
  rollback: SettingsSnapshot['rollback'];
  running: number;
}) {
  const { projectId, run, openOverlay, closeOverlay } = useApp();
  const base = `/projects/${projectId}`;
  const paused = p.status === 'paused';
  const control = (verb: 'pause' | 'resume') =>
    run(
      () => post(`${base}/control`, { verb, scope: { kind: 'project', id: projectId } }),
      verb === 'pause'
        ? { title: `${p.name} paused`, detail: 'Nothing runs until you resume it.' }
        : { title: `${p.name} resumed`, detail: 'The team picks up where it stopped.' },
      verb === 'pause' ? 'Pausing the project' : 'Resuming the project',
    );

  const pause = () =>
    openOverlay(
      <TypedConfirm
        title="Pause the whole project?"
        body={`${running} running task${running === 1 ? '' : 's'} hold at their next checkpoint. Nothing is rolled back. Resume at any time.`}
        confirmLabel="Pause project"
        onConfirm={() => {
          closeOverlay();
          void control('pause');
        }}
      />,
    );

  const rollBack = (r: NonNullable<typeof rollback>) =>
    openOverlay(
      <TypedConfirm
        title={`Roll back phase ${r.phase}?`}
        body={`${r.detail} This cannot be undone.`}
        confirmLabel={`Roll back phase ${r.phase}`}
        typed="ROLL BACK"
        onConfirm={() => {
          closeOverlay();
          void run(() => post(`${base}/phases/${r.phase}/rollback`, { confirmation: 'ROLL BACK' }));
        }}
      />,
    );

  const reset = (newBuildRepo: boolean) =>
    openOverlay(
      <TypedConfirm
        title={
          newBuildRepo
            ? 'Reset this project and start in a new build repository?'
            : 'Reset this project to intake?'
        }
        body={`The run stops now. Its activity, decisions, plan and Workbench documents are deleted. The intake facts, credentials, brief and source site are kept, and Start runs the project again from the beginning on the catalog’s playbook version.${
          newBuildRepo && p.buildRepo
            ? ` The project also lets go of ${p.buildRepo.repo} and its hosting record; the repository itself is left as it is. Create a new build repository in Settings before Start.`
            : ''
        } This cannot be undone.`}
        confirmLabel="Reset project"
        typed={p.name}
        onConfirm={() => {
          closeOverlay();
          void run(
            () => post(`${base}/reset`, { confirmation: p.name, newBuildRepo }),
            `${p.name} reset to intake`,
          );
        }}
      />,
    );

  const archive = () =>
    openOverlay(
      <TypedConfirm
        title="Archive this project?"
        body="The project becomes read-only with its audit trail, artifacts and handover pack. This cannot be undone."
        confirmLabel="Archive project"
        typed={p.name}
        onConfirm={() => {
          closeOverlay();
          void run(() => post(`${base}/archive`, { confirmation: p.name }), `${p.name} archived`);
        }}
      />,
    );

  return (
    <div className={s.danger}>
      <Panel title="Danger zone">
        <p className={`${s.lead} ${s.sentence}`}>
          Each of these asks you to confirm first. Pausing can be undone; nothing else here can.
        </p>
        <ul className={s.dangerRows}>
          <Row
            title={paused ? 'Resume the project' : 'Pause the whole project'}
            note={
              paused
                ? 'Held tasks carry on from their checkpoints.'
                : 'Running tasks hold at their next checkpoint. Nothing is rolled back.'
            }
          >
            {paused ? (
              <Action kind="primary" onClick={() => void control('resume')}>
                Resume project
              </Action>
            ) : (
              <Action onClick={pause}>Pause project</Action>
            )}
          </Row>
          {rollback && (
            <Row title={`Roll back phase ${rollback.phase}`} note={rollback.detail}>
              <Action kind="danger" onClick={() => rollBack(rollback)}>
                Roll back phase
              </Action>
            </Row>
          )}
          {!p.demo && (
            <Row
              title="Reset to intake"
              note="Stops the run, deletes its history and documents, and moves to the catalog’s playbook version."
            >
              <Action kind="danger" onClick={() => reset(false)}>
                Reset
              </Action>
              {p.buildRepo && (
                <Action kind="danger" onClick={() => reset(true)}>
                  Reset with a new build repository
                </Action>
              )}
            </Row>
          )}
          <Row
            title="Archive project"
            note="Read-only from then on, with its audit trail, artifacts and handover pack."
          >
            <Action kind="danger" onClick={archive}>
              Archive
            </Action>
          </Row>
        </ul>
      </Panel>
    </div>
  );
}
