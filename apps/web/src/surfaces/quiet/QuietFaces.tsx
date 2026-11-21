/*
 * The switches that pick Plan's and Workbench's face. Plan's two faces are in surfaces/plan (the
 * activity list, and the same list distilled); Workbench Bliss is in ./WorkbenchBliss and its
 * Everything face in surfaces/workbench.
 */
import { Mode } from '../../mode/Mode';
import { PlanBliss } from '../plan/PlanBliss';
import { PlanEverything as Plan } from '../plan/PlanEverything';
import { WorkbenchEverything as Workbench } from '../workbench/WorkbenchEverything';
import { WorkbenchBliss } from './WorkbenchBliss';

export function PlanPage() {
  return <Mode bliss={<PlanBliss />} everything={<Plan />} />;
}
export function WorkbenchPage() {
  return <Mode bliss={<WorkbenchBliss />} everything={<Workbench />} />;
}
