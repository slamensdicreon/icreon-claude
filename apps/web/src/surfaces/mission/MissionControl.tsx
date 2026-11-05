import { Mode } from '../../mode/Mode';
import { useApp, useMission } from '../../state';
import { Mission } from '../Mission';
import { MissionBliss } from './MissionBliss';
import { MissionEverything } from './MissionEverything';

/**
 * Mission Control in both faces. A project still in intake keeps the old page (its Start flow),
 * as does presentation mode, until both fold into Bliss.
 */
export function MissionControl() {
  const mc = useMission().data;
  const { layout } = useApp();
  if (!mc) return <p className="type-body">Reading the project…</p>;
  if (mc.project.status === 'intake' || layout.present) return <Mission />;
  return <Mode bliss={<MissionBliss mc={mc} />} everything={<MissionEverything mc={mc} />} />;
}
