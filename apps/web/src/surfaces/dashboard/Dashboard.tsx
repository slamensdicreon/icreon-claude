import { useOverview } from '../../lib/overview';
import { Mode } from '../../mode/Mode';
import { DashboardBliss } from './DashboardBliss';
import { DashboardEverything } from './DashboardEverything';
import s from './dashboard.module.css';

/** The portfolio, in both faces: Bliss (the eye, what's yours, a tile per project) and Everything (the console). */
export function Dashboard() {
  const { data, error, refresh } = useOverview();
  if (!data)
    return (
      <p className={`${s.waiting} type-body`} role="status">
        {error ? `The overview could not be read: ${error}` : 'Reading the portfolio…'}
      </p>
    );
  const r = () => void refresh();
  return (
    <Mode
      bliss={<DashboardBliss o={data} refresh={r} />}
      everything={<DashboardEverything o={data} refresh={r} />}
    />
  );
}
