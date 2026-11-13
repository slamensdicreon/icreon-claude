/*
 * One organization, opened from the Organizations page (Icreon only): its license (platforms,
 * playbooks, projects, term) with every change kept, and support access.
 */
import { useEffect, useMemo, useState } from 'react';
import { get, messageOf, postFor, put } from '../../lib/api';
import { fullDate } from '../../lib/fmt';
import { useApp, useTz } from '../../state';
import { Checkbox, Field, Select, TextInput } from '../../ui/cypher/forms';
import { Action, Actions, Notice, usePlaybooks } from '../intake/shared';
import { switchTo } from './Organizations';
import { OrganizationUsage } from './OrganizationUsage';
import s from './manage.module.css';

interface LicenseTerms {
  entities: string[];
  playbooks: string[];
  projectsIncluded: number;
  startsAt: string;
  endsAt: string;
}
interface History {
  license: (LicenseTerms & { suspended: { projects: string[] } | null }) | null;
  history: { at: string; by: string; kind: string; license: LicenseTerms }[];
}

const day = (iso: string) => iso.slice(0, 10);
const inAYear = () => {
  const d = new Date();
  return {
    start: day(d.toISOString()),
    end: day(new Date(d.getTime() + 365 * 86_400_000).toISOString()),
  };
};
const KIND: Record<string, string> = {
  granted: 'Granted',
  changed: 'Changed',
  suspended: 'Paused projects',
  resumed: 'Resumed projects',
};

export function OrganizationEditor({
  id,
  name,
  onSaved,
}: {
  id: string;
  name: string;
  onSaved: () => void;
}) {
  const { toast } = useApp();
  const tz = useTz();
  const { playbooks } = usePlaybooks();
  const [data, setData] = useState<History | null>(null);
  const [entities, setEntities] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [projects, setProjects] = useState('1');
  const [start, setStart] = useState(inAYear().start);
  const [end, setEnd] = useState(inAYear().end);
  const [hours, setHours] = useState('4');
  const [role, setRole] = useState<'watcher' | 'director'>('watcher');
  const [busy, setBusy] = useState(false);

  const load = () =>
    get<History>(`/admin/organizations/${id}/license`).then((d) => {
      setData(d);
      if (d.license) {
        setEntities(d.license.entities);
        setChosen(d.license.playbooks);
        setProjects(String(d.license.projectsIncluded));
        setStart(day(d.license.startsAt));
        setEnd(day(d.license.endsAt));
      }
    });
  useEffect(() => {
    void load().catch(() => {});
  }, [id]);

  // The catalog by platform: what a license can cover.
  const platforms = useMemo(() => {
    const out = new Map<string, { name: string; playbooks: { id: string; name: string }[] }>();
    for (const p of playbooks ?? []) {
      const g = out.get(p.platform.id) ?? { name: p.platform.name, playbooks: [] };
      g.playbooks.push({ id: p.id, name: p.name });
      out.set(p.platform.id, g);
    }
    return [...out.entries()];
  }, [playbooks]);
  const toggle = (list: string[], set: (x: string[]) => void, v: string, on: boolean) =>
    set(on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  const save = async () => {
    setBusy(true);
    try {
      const r = (await put(`/admin/organizations/${id}/license`, {
        entities,
        // A playbook counts only on a licensed platform.
        playbooks: chosen.filter((pb) =>
          platforms.some(
            ([pid, g]) => entities.includes(pid) && g.playbooks.some((x) => x.id === pb),
          ),
        ),
        projectsIncluded: Number(projects),
        startsAt: new Date(`${start}T00:00:00`).toISOString(),
        endsAt: new Date(`${end}T23:59:59`).toISOString(),
      })) as unknown as { reconciled: { action: string; projects: string[] } };
      const r2 = r.reconciled;
      toast({
        title: `${name}'s license is saved`,
        detail:
          r2.action === 'suspended'
            ? `${r2.projects.length} project(s) paused: outside the license now.`
            : r2.action === 'resumed'
              ? `${r2.projects.length} project(s) resumed.`
              : 'Every change is kept below.',
        tone: 'done',
      });
      await load();
      onSaved();
    } catch (err) {
      toast(messageOf(err, 'The license could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const support = async () => {
    try {
      const r = await postFor<{ expiresAt: string }>(`/admin/organizations/${id}/support`, {
        hours: Number(hours),
        role,
      });
      toast({
        title: `You are in ${name} until ${fullDate(r.expiresAt, tz)}`,
        detail: 'Its Directors see it in People. Switching to it now.',
        tone: 'done',
      });
      await switchTo(id);
    } catch (err) {
      toast(messageOf(err, 'Support access could not be given.'));
    }
  };

  return (
    <div className={s.page}>
      <h3 className="type-section">License</h3>
      {data && !data.license && <Notice tone="waiting">No license yet: nothing can start.</Notice>}
      {data?.license?.suspended?.projects.length ? (
        <Notice tone="bad">
          {data.license.suspended.projects.length} project(s) paused by the license.
        </Notice>
      ) : null}
      {platforms.map(([pid, g]) => (
        <div key={pid}>
          <Checkbox
            label={g.name}
            checked={entities.includes(pid)}
            onChange={(on) => toggle(entities, setEntities, pid, on)}
          />
          {entities.includes(pid) &&
            g.playbooks.map((pb) => (
              <Checkbox
                key={pb.id}
                label={pb.name}
                hint={pb.id}
                checked={chosen.includes(pb.id)}
                onChange={(on) => toggle(chosen, setChosen, pb.id, on)}
              />
            ))}
        </div>
      ))}
      <div className={s.inline}>
        <Field label="Projects included">
          {({ id: fid }) => (
            <TextInput
              id={fid}
              type="number"
              min={0}
              value={projects}
              onChange={(e) => setProjects(e.target.value)}
            />
          )}
        </Field>
        <Field label="Starts">
          {({ id: fid }) => (
            <TextInput
              id={fid}
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          )}
        </Field>
        <Field label="Ends">
          {({ id: fid }) => (
            <TextInput id={fid} type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          )}
        </Field>
      </div>
      <Actions>
        <Action kind="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : data?.license ? 'Save license' : 'Grant license'}
        </Action>
      </Actions>
      {!!data?.history.length && (
        <ul className={`${s.quiet} type-meta`}>
          {[...data.history].reverse().map((h, i) => (
            <li key={i}>
              {fullDate(h.at, tz)} · {KIND[h.kind] ?? h.kind} by{' '}
              {h.by.replace(/^(github|workos):/, '')} · {h.license.projectsIncluded} projects,{' '}
              {h.license.playbooks.length} playbook(s), until {fullDate(h.license.endsAt, tz)}
            </li>
          ))}
        </ul>
      )}

      <h3 className="type-section">Usage</h3>
      <OrganizationUsage id={id} />

      <h3 className="type-section">Support access</h3>
      <p className={`${s.quiet} type-body-small`}>
        Join {name} for a few hours to look or to help. Its Directors see it in People, with when it
        ends.
      </p>
      <div className={s.inline}>
        <Field label="Hours">
          {({ id: fid }) => (
            <TextInput
              id={fid}
              type="number"
              min={1}
              max={72}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          )}
        </Field>
        <Field label="As">
          {({ id: fid }) => (
            <Select
              id={fid}
              value={role}
              onChange={(e) => setRole(e.target.value as 'watcher' | 'director')}
            >
              <option value="watcher">Watcher: look only</option>
              <option value="director">Director: help</option>
            </Select>
          )}
        </Field>
      </div>
      <Actions>
        <Action onClick={() => void support()}>Join for {hours} h</Action>
      </Actions>
    </div>
  );
}
