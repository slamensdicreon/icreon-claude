/*
 * The danger zone: pause or resume the whole project, roll back the current phase, reset to
 * intake (with or without a new build repository), archive and restore. Everything but Resume and
 * Restore asks first in a TypedConfirm; what changes the most asks for a typed word. An archived
 * project shows only Restore: the API refuses everything else while it is archived.
 */
import type { ProjectSummary, SettingsSnapshot } from '@lw/contracts';
import type { ReactNode } from 'react';
import { API, del, post } from '../../lib/api';
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
  const archived = p.status === 'archived';
  const live = p.status === 'running';
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
        body={`${paused ? 'Its open tasks are cancelled first. ' : ''}Nothing runs from then on and nothing can be changed. Its history, documents and handover pack stay, and you can restore it.`}
        confirmLabel="Archive project"
        typed={p.name}
        onConfirm={() => {
          closeOverlay();
          void run(
            () => post(`${base}/archive`, { confirmation: p.name }),
            { title: `${p.name} archived`, detail: 'Read-only. Restore it here at any time.' },
            'Archiving the project',
          );
        }}
      />,
    );
  const restore = () =>
    run(
      () => post(`${base}/restore`, {}),
      {
        title: `${p.name} restored`,
        detail: 'Back as it was before the archive, to read and export.',
      },
      'Restoring the project',
    );

  // What the purge removes outside our stores, by name, so nobody is surprised.
  const created = [
    p.buildRepo && `the build repository ${p.buildRepo.repo}`,
    p.hosting && `the Vercel project ${p.hosting.project}`,
  ].filter(Boolean);
  const outside = created.length
    ? `${created.join(' and ').replace(/^t/, 'T')} ${created.length > 1 ? 'are' : 'is'} deleted too, unless already handed to the client.`
    : '';
  const deleteProject = () =>
    openOverlay(
      <TypedConfirm
        title="Delete this project?"
        body={`After a 30-day grace period, everything held for it is deleted: its history, documents, screenshots, credentials, and its own rules and lessons.${outside ? ` ${outside}` : ''} Lessons it taught other projects stay, without its name. You can cancel until then. Download anything you need first.`}
        confirmLabel="Schedule deletion"
        typed={p.name}
        onConfirm={() => {
          closeOverlay();
          void run(
            () => post(`${base}/deletion`, { confirmation: p.name }),
            {
              title: `${p.name} scheduled for deletion`,
              detail: 'Cancel it here any time before then.',
            },
            'Scheduling the deletion',
          );
        }}
      />,
    );
  const cancelDeletion = () =>
    run(
      () => del(`${base}/deletion`),
      { title: 'Deletion cancelled', detail: `${p.name} stays archived.` },
      'Cancelling the deletion',
    );

  if (archived) {
    const due = p.deletion
      ? new Date(p.deletion.due).toLocaleDateString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        })
      : null;
    return (
      <div className={s.danger}>
        <Panel title="Archived">
          <p className={`${s.lead} ${s.sentence}`}>
            {due
              ? `This project is archived and will be deleted on ${due}.`
              : 'This project is archived and read-only. Nothing runs and nothing can be changed.'}
          </p>
          <ul className={s.dangerRows}>
            <Row
              title="Download everything"
              note="Every document’s latest version and the activity log, in one zip. Do this before deleting."
            >
              <a className={s.download} href={`${API}${base}/documents.zip`} download>
                Documents (.zip)
              </a>
              <a className={s.download} href={`${API}${base}/activity.csv?view=all`} download>
                Activity (.csv)
              </a>
            </Row>
            {due ? (
              <Row
                title={`Deletion scheduled for ${due}`}
                note="Everything held for this project goes on that date. Cancel to keep it archived; then it can be restored."
              >
                <Action kind="primary" onClick={() => void cancelDeletion()}>
                  Cancel deletion
                </Action>
              </Row>
            ) : (
              <>
                <Row
                  title="Restore the project"
                  note="Brings it back as completed or cancelled, to read and export. To do more work, start a new project from it with Remix."
                >
                  <Action kind="primary" onClick={() => void restore()}>
                    Restore project
                  </Action>
                </Row>
                <Row
                  title="Delete the project"
                  note={`After a 30-day grace period, everything held for it is deleted for good${created.length ? ', with its build repository and hosting project' : ''}. You can cancel until then.`}
                >
                  <Action kind="danger" onClick={deleteProject}>
                    Delete project
                  </Action>
                </Row>
              </>
            )}
          </ul>
        </Panel>
      </div>
    );
  }

  return (
    <div className={s.danger}>
      <Panel title="Danger zone">
        <p className={`${s.lead} ${s.sentence}`}>
          Each of these asks you to confirm first. Pausing and archiving can be undone; rolling back
          and resetting can’t.
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
            note={
              live
                ? 'Pause the project first. A project is archived only once nothing is running.'
                : 'Stops it for good and makes it read-only, with its history, documents and handover pack. You can restore it.'
            }
          >
            <Action kind="danger" onClick={archive} disabled={live}>
              Archive
            </Action>
          </Row>
        </ul>
      </Panel>
    </div>
  );
}
