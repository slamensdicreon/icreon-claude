import { useState } from 'react';
import { API } from '../lib/api';
import s from './project-icon.module.css';

/** Projects whose source site has no icon (or none could be read): asked once per visit. */
const missing = new Set<string>();

/**
 * A project's source site icon, laid over its initials tile (the tile needs `position: relative`).
 * It appears once it has loaded; a project with no icon keeps its initials. A load that fails is
 * tried once more a few seconds later (a slow first fetch on the server), then left.
 */
export function ProjectIcon({ projectId }: { projectId: string | null | undefined }) {
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(() => !projectId || missing.has(projectId));
  if (!projectId || failed) return null;
  const src = `${API}/projects/${encodeURIComponent(projectId)}/icon${attempt ? `?retry=${attempt}` : ''}`;
  return (
    <img
      key={src}
      className={s.icon}
      src={src}
      alt=""
      decoding="async"
      loading="lazy"
      data-loaded={loaded || undefined}
      onLoad={() => setLoaded(true)}
      onError={() => {
        if (attempt === 0) {
          window.setTimeout(() => setAttempt(1), 3000);
          return;
        }
        missing.add(projectId);
        setFailed(true);
      }}
    />
  );
}
