/*
 * Everything the project made, to take away: the documents, the activity log, and the build
 * repository's code (GitHub hands over a fresh link each time; it lasts minutes).
 */
import { useState } from 'react';
import { API, get, messageOf } from '../../lib/api';
import { fullDate } from '../../lib/fmt';
import { useApp, useTz } from '../../state';
import { Panel } from '../../ui/cypher/parts';
import { Action, Actions, Notice } from '../intake/shared';
import s from './settings.module.css';

interface ExportView {
  documents: string;
  activity: string;
  repository: { repo: string; branch: string; url: string | null; detail: string | null } | null;
  hostingProject: string | null;
  availableUntil: string | null;
}

export function ExportPanel({ projectId }: { projectId: string }) {
  const { toast } = useApp();
  const tz = useTz();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ExportView | null>(null);
  const prepare = async () => {
    setBusy(true);
    try {
      const v = await get<ExportView>(`/projects/${projectId}/export`);
      setView(v);
      if (v.repository?.url) location.assign(v.repository.url);
      else if (v.repository) toast(v.repository.detail ?? 'The code could not be fetched.');
    } catch (err) {
      toast(messageOf(err, 'The export could not be prepared.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Export" padded>
      <div className={s.stack}>
        <p className={s.lead}>
          Everything this project made is yours: its documents, its activity log and its code.
        </p>
        {view?.availableUntil && (
          <Notice tone="waiting">
            Export stays open until {fullDate(view.availableUntil, tz)}.
          </Notice>
        )}
        <Actions>
          <a className={s.download} href={`${API}/projects/${projectId}/documents.zip`} download>
            Documents (.zip)
          </a>
          <a
            className={s.download}
            href={`${API}/projects/${projectId}/activity.csv?view=all`}
            download
          >
            Activity (.csv)
          </a>
          <Action disabled={busy} onClick={() => void prepare()}>
            {busy ? 'Asking GitHub…' : 'Code (.zip)'}
          </Action>
        </Actions>
        {view?.repository && (
          <p className={`${s.quiet} type-meta`}>
            The code is {view.repository.repo} on {view.repository.branch}
            {view.hostingProject ? `; the site is hosted as ${view.hostingProject} on Vercel` : ''}.
            Icreon can move the repository and the Vercel project to your own accounts.
          </p>
        )}
      </div>
    </Panel>
  );
}
