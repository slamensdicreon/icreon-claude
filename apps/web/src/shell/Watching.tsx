import { isWatching, role } from '../lib/role';
import s from './watching.module.css';

/** For a Watcher, always in view: they can see everything here, and change nothing. */
export function Watching() {
  if (!isWatching()) return null;
  const { organization } = role();
  return (
    <div className={`${s.badge} type-meta`} role="status">
      <strong>Watching{organization ? ` ${organization}` : ''}</strong> · read only
    </div>
  );
}
