/*
 * Whether deleting a project will also get its build repository and its Vercel project, asked of
 * GitHub and Vercel read-only (`GET /portfolio/deletion-readiness`). Shown before anyone deletes,
 * so a missing permission is fixed first rather than found as "Refused" in Deleted projects.
 * Nothing shows where deletion isn't wired (local development without a database).
 */
import { usePoll } from '../../lib/poll';
import s from './settings.module.css';

interface Check {
  state: 'ok' | 'missing' | 'off' | 'unknown';
  detail: string;
}
interface Readiness {
  repository: Check;
  hosting: Check;
}

const WORD: Record<Check['state'], string> = {
  ok: 'Can delete',
  missing: 'Can’t delete yet',
  off: 'Not connected',
  unknown: 'Couldn’t check',
};

export function DeletionReady() {
  const { data } = usePoll<Readiness>('/portfolio/deletion-readiness', 10 * 60_000);
  if (!data) return null;
  const rows: [string, Check][] = [
    ['Build repositories (GitHub)', data.repository],
    ['Hosting projects (Vercel)', data.hosting],
  ];
  const fine = rows.every(([, c]) => c.state === 'ok');
  return (
    <div
      className={s.ready}
      role="status"
      aria-label="Deletion readiness"
      data-fine={fine || undefined}
    >
      <span className={`${s.readyLead} type-body-small`}>
        {fine
          ? 'Deleting a project also deletes its build repository and Vercel project.'
          : 'Deleting a project won’t get everything yet:'}
      </span>
      {rows.map(([what, c]) => (
        <span key={what} className={`${s.readyRow} type-meta`} title={c.detail}>
          <i className={s.readyDot} data-state={c.state} aria-hidden="true" />
          <b>{what}:</b> {WORD[c.state]}
          {c.state !== 'ok' && <span className={s.readyDetail}> {c.detail}</span>}
        </span>
      ))}
    </div>
  );
}
