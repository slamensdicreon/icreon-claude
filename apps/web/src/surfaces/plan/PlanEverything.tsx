/*
 * Plan, Everything face: the activity list, which is the plan (./ActivityList). The same list
 * serves the phone; there is no separate agenda.
 */
import type { ScheduleSnapshot } from '@lw/contracts';
import { useProjectResource } from '../../state';
import { ActivityList } from './ActivityList';

export function PlanEverything() {
  const sched = useProjectResource<ScheduleSnapshot>('/schedule').data;
  if (!sched) return <p className="type-body">Reading the plan…</p>;
  return <ActivityList s={sched} />;
}
