/*
 * The organization's license, as its Directors see it: what it covers, how much is in use, and
 * until when. Icreon needs none, so Icreon sees nothing here.
 */
import { useEffect, useState } from 'react';
import { get } from '../../lib/api';
import { fullDate } from '../../lib/fmt';
import { isWatching } from '../../lib/role';
import { useTz } from '../../state';
import { Facts } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Notice, usePlaybooks } from '../intake/shared';
import s from './settings.module.css';

interface LicenseView {
  standing: 'unlimited' | 'none' | 'upcoming' | 'active' | 'ended';
  used?: number;
  entities?: string[];
  playbooks?: string[];
  projectsIncluded?: number;
  startsAt?: string;
  endsAt?: string;
  exportUntil?: string;
}

export function LicensePanel() {
  const tz = useTz();
  const [l, setL] = useState<LicenseView | null>(null);
  const { playbooks } = usePlaybooks();
  useEffect(() => {
    if (!isWatching()) get<LicenseView>('/organization/license').then(setL, () => {});
  }, []);
  if (!l || l.standing === 'unlimited' || isWatching()) return null;
  const nameOf = (id: string) => playbooks?.find((p) => p.id === id)?.name ?? id;
  const platformOf = (id: string) =>
    playbooks?.find((p) => p.platform.id === id)?.platform.name ?? id;
  return (
    <Panel title="License" padded>
      {l.standing === 'none' ? (
        <Notice tone="waiting">
          No license yet. Icreon sets it up before your first project starts.
        </Notice>
      ) : (
        <div className={s.stack}>
          {l.standing === 'ended' && (
            <Notice tone="bad">
              Ended {fullDate(l.endsAt!, tz)}: your projects are paused and read only. Export stays
              open until {fullDate(l.exportUntil!, tz)}. Ask Icreon to renew.
            </Notice>
          )}
          {l.standing === 'upcoming' && (
            <Notice tone="waiting">Starts {fullDate(l.startsAt!, tz)}.</Notice>
          )}
          <Facts
            rows={[
              ['Platforms', (l.entities ?? []).map(platformOf).join(', ') || 'None'],
              ['Playbooks', (l.playbooks ?? []).map(nameOf).join(', ') || 'None'],
              ['Projects', `${l.used ?? 0} of ${l.projectsIncluded ?? 0} in use`],
              ['Term', `${fullDate(l.startsAt!, tz)} to ${fullDate(l.endsAt!, tz)}`],
            ]}
          />
        </div>
      )}
    </Panel>
  );
}
