/*
 * Plan, Everything face: what every agent is doing, when, and what it waits for. Three views
 * (Today, Engagement, the activity list) picked with chips and remembered as `ui.planView`; the
 * timelines share one zoom; at 640px and under the timelines become an agenda. Any task or agent
 * opens the inspector.
 */
import type { ScheduleSnapshot } from '@lw/contracts';
import { useEffect, useState } from 'react';
import { useApp, useProjectResource } from '../../state';
import { Chips } from '../../ui/cypher/parts';
import { ActivityList } from './ActivityList';
import { Engagement } from './Engagement';
import { VIEWS, type PlanView } from './model';
import { PlanPhone } from './PlanPhone';
import { Today } from './Today';
import { useZoom } from './zoom';
import s from './plan.module.css';

const PHONE = '(max-width: 640px)';

function useIsPhone() {
  const [phone, setPhone] = useState(() => matchMedia(PHONE).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

export function PlanEverything() {
  const { ui, setUi } = useApp();
  const sched = useProjectResource<ScheduleSnapshot>('/schedule').data;
  const phone = useIsPhone();
  const [zoom, setZoom] = useZoom();
  const view: PlanView = ui.planView;
  if (!sched) return <p className="type-body">Reading the plan…</p>;
  return (
    <div className={s.everything}>
      <div className={s.toolbar}>
        <Chips<PlanView>
          label="Plan view"
          value={view}
          onChange={(v) => setUi({ planView: v })}
          options={VIEWS}
        />
        {!phone && (
          <span className={`${s.hint} type-meta`}>Select a task or an agent for detail</span>
        )}
      </div>
      {phone && view !== 'list' ? (
        <PlanPhone s={sched} view={view} />
      ) : view === 'today' ? (
        <Today s={sched} zoom={zoom} setZoom={setZoom} />
      ) : view === 'engagement' ? (
        <Engagement s={sched} zoom={zoom} setZoom={setZoom} />
      ) : (
        <ActivityList s={sched} />
      )}
    </div>
  );
}
