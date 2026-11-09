/*
 * Several projects at once, from the projects table: pause, resume, archive, delete now, or export
 * them as CSV. Each action counts only the projects it applies to (archive and delete skip what's
 * running; pause takes only what runs) and says what it skips. Archive and delete ask for the
 * number typed, the way one project asks for its name; the projects then go one by one through
 * the same calls as their Settings, and anything refused is named in the toast.
 */
import type { PortfolioProject } from '@lw/contracts';
import { useState } from 'react';
import { ApiProblem, messageOf, post } from '../../lib/api';
import { TypedConfirm } from '../../overlays/Dialogs';
import { useApp } from '../../state';
import { Checkbox } from '../../ui/cypher/forms';
import { platformOf, playbookShort } from './projectNames';
import s from './dashboard.module.css';

type Act = 'pause' | 'resume' | 'archive' | 'delete';

const FITS: Record<Act, (p: PortfolioProject) => boolean> = {
  pause: (p) => p.status === 'running',
  resume: (p) => p.status === 'paused',
  archive: (p) => p.status !== 'running' && p.status !== 'archived',
  delete: (p) => p.status !== 'running',
};
const SKIP: Record<Act, string> = {
  pause: 'not running',
  resume: 'not paused',
  archive: 'running or already archived; pause running ones first',
  delete: 'running; pause them first',
};

/** "Acme, Globex and Initech"; past six names, "and 4 more". */
export function listNames(ps: PortfolioProject[]): string {
  const n = ps.map((p) => p.name);
  if (n.length > 6) return `${n.slice(0, 5).join(', ')} and ${n.length - 5} more`;
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : (n[0] ?? '');
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The selected projects as a CSV the browser saves. */
function exportCsv(ps: PortfolioProject[]) {
  const cell = (v: string | number) => {
    const t = String(v);
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = [
    'Project',
    'Client',
    'Platform',
    'Playbook',
    'Status',
    'Phase',
    'Progress %',
    'Spend USD',
    'Budget USD',
    'Yours',
    'Last event at',
    'Last event',
  ];
  const rows = ps.map((p) => [
    p.name,
    p.client,
    platformOf(p),
    playbookShort(p),
    p.status,
    p.phaseLabel,
    p.percent,
    p.spentUsd.toFixed(2),
    p.budgetUsd.toFixed(2),
    p.yours,
    p.lastEvent?.at ?? '',
    p.lastEvent?.text ?? '',
  ]);
  const csv = [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `projects-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** One call per project, in order; refusals are collected and named, not stopped on. */
async function each(ps: PortfolioProject[], call: (p: PortfolioProject) => Promise<unknown>) {
  const failed: string[] = [];
  for (const p of ps) {
    try {
      await call(p);
    } catch (err) {
      failed.push(`${p.name}: ${messageOf(err, 'the API could not be reached')}`);
    }
  }
  if (failed.length)
    throw new ApiProblem(
      207,
      'partial',
      `${ps.length - failed.length} of ${ps.length} went through. ${failed.join(' ')}`,
    );
}

/** Delete now for several: the typed count, and what to keep for all of them. */
function BulkDelete({
  ps,
  skipped,
  onConfirm,
}: {
  ps: PortfolioProject[];
  skipped: string;
  onConfirm: (keep: { keepRepository: boolean; keepHosting: boolean }) => void;
}) {
  const [keepRepository, setKeepRepository] = useState(false);
  const [keepHosting, setKeepHosting] = useState(false);
  return (
    <TypedConfirm
      title={`Delete ${plural(ps.length, 'project')} now?`}
      body={`${listNames(ps)}. Everything held for ${ps.length === 1 ? 'it' : 'them'} goes right away, with no grace period: history, documents, screenshots, credentials, and their own rules and lessons. This can’t be undone.${skipped}`}
      confirmLabel={`Delete ${plural(ps.length, 'project')}`}
      typed={String(ps.length)}
      onConfirm={() => onConfirm({ keepRepository, keepHosting })}
    >
      <Checkbox
        label="Keep their build repositories"
        hint="Otherwise each one’s repository in our GitHub organization is deleted."
        checked={keepRepository}
        onChange={setKeepRepository}
      />
      <Checkbox
        label="Keep their Vercel projects"
        hint="Otherwise their preview links stop working."
        checked={keepHosting}
        onChange={setKeepHosting}
      />
    </TypedConfirm>
  );
}

export function BulkBar({
  selected,
  onClear,
  onDone,
}: {
  selected: PortfolioProject[];
  onClear: () => void;
  onDone: () => void;
}) {
  const { run, openOverlay, closeOverlay } = useApp();
  const fits = (a: Act) => selected.filter(FITS[a]);
  const skippedNote = (a: Act) => {
    const out = selected.length - fits(a).length;
    return out
      ? ` ${plural(out, 'selected project is', 'selected projects are')} left out: ${SKIP[a]}.`
      : '';
  };
  const label = (a: Act, verb: string) => {
    const n = fits(a).length;
    return n === selected.length ? verb : `${verb} ${n}`;
  };
  const finish = (ok: boolean) => {
    if (ok) onClear();
    onDone();
  };

  const control = (verb: 'pause' | 'resume') => {
    const ps = fits(verb);
    openOverlay(
      <TypedConfirm
        title={`${verb === 'pause' ? 'Pause' : 'Resume'} ${plural(ps.length, 'project')}?`}
        body={`${listNames(ps)}. ${verb === 'pause' ? 'Running tasks hold at their next checkpoint; nothing is rolled back.' : 'Held tasks carry on from their checkpoints.'}${skippedNote(verb)}`}
        confirmLabel={`${verb === 'pause' ? 'Pause' : 'Resume'} ${plural(ps.length, 'project')}`}
        danger={false}
        onConfirm={() => {
          closeOverlay();
          void run(
            () =>
              each(ps, (p) =>
                post(`/projects/${p.projectId}/control`, {
                  verb,
                  scope: { kind: 'project', id: p.projectId },
                }),
              ),
            `${plural(ps.length, 'project')} ${verb === 'pause' ? 'paused' : 'resumed'}`,
            verb === 'pause' ? 'Pausing projects' : 'Resuming projects',
          ).then(finish);
        }}
      />,
    );
  };

  const archive = () => {
    const ps = fits('archive');
    openOverlay(
      <TypedConfirm
        title={`Archive ${plural(ps.length, 'project')}?`}
        body={`${listNames(ps)}. Paused ones have their open tasks cancelled first. They become read-only, leave the active lists, and keep their history and documents; each can be restored from its Settings.${skippedNote('archive')}`}
        confirmLabel={`Archive ${plural(ps.length, 'project')}`}
        typed={String(ps.length)}
        onConfirm={() => {
          closeOverlay();
          void run(
            () =>
              each(ps, (p) => post(`/projects/${p.projectId}/archive`, { confirmation: p.name })),
            {
              title: `${plural(ps.length, 'project')} archived`,
              detail: 'Under the Archived view.',
            },
            'Archiving projects',
          ).then(finish);
        }}
      />,
    );
  };

  const remove = () => {
    const ps = fits('delete');
    openOverlay(
      <BulkDelete
        ps={ps}
        skipped={skippedNote('delete')}
        onConfirm={(keep) => {
          closeOverlay();
          void run(
            () =>
              each(ps, (p) =>
                post(`/projects/${p.projectId}/delete-now`, { confirmation: p.name, ...keep }),
              ),
            {
              title: `${plural(ps.length, 'project')} deleted`,
              detail: 'Their records are under Archived → Deleted projects.',
            },
            'Deleting projects',
          ).then(finish);
        }}
      />,
    );
  };

  return (
    <div className={s.bulk} role="region" aria-label="Selected projects">
      <span className={`${s.bulkCount} type-body-small`}>
        {plural(selected.length, 'project')} selected
      </span>
      {fits('pause').length > 0 && (
        <button
          type="button"
          className={`${s.bulkButton} type-button`}
          onClick={() => control('pause')}
        >
          {label('pause', 'Pause')}
        </button>
      )}
      {fits('resume').length > 0 && (
        <button
          type="button"
          className={`${s.bulkButton} type-button`}
          onClick={() => control('resume')}
        >
          {label('resume', 'Resume')}
        </button>
      )}
      <button
        type="button"
        className={`${s.bulkButton} type-button`}
        disabled={!fits('archive').length}
        onClick={archive}
      >
        {label('archive', 'Archive')}
      </button>
      <button
        type="button"
        className={`${s.bulkButton} type-button`}
        onClick={() => exportCsv(selected)}
      >
        Export CSV
      </button>
      <button
        type="button"
        className={`${s.bulkButton} ${s.bulkDanger} type-button`}
        disabled={!fits('delete').length}
        onClick={remove}
      >
        {label('delete', 'Delete now')}…
      </button>
      <span className={s.grow} />
      <button type="button" className={`${s.bulkQuiet} type-button`} onClick={onClear}>
        Clear selection
      </button>
    </div>
  );
}
