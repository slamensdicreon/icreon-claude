import { Mode } from '../../mode/Mode';
import { useApp, useMission } from '../../state';
import { AwayLine, Present, ReadyToStart } from './Extras';
import { MissionBliss } from './MissionBliss';
import { MissionEverything } from './MissionEverything';

/**
 * Mission Control: presentation mode on a big screen, otherwise the Bliss or Everything face. A
 * project the wizard recorded but nobody has started carries Ready to start above its face.
 */
export function MissionControl() {
  const mc = useMission().data;
  const { layout } = useApp();
  if (!mc) return <p className="type-body">Reading the project…</p>;
  if (layout.present) return <Present mc={mc} />;
  return (
    <>
      <AwayLine />
      {mc.project.status === 'intake' && !mc.project.demo && <ReadyToStart mc={mc} />}
      <Mode bliss={<MissionBliss mc={mc} />} everything={<MissionEverything mc={mc} />} />
    </>
  );
}
