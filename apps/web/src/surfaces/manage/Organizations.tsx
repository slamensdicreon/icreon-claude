/*
 * Every organization on the product, and starting a new one (Icreon only). Whoever creates an
 * organization is its kickoff Director; the customer's first Director is invited by email.
 */
import { useState } from 'react';
import { messageOf, postFor, put } from '../../lib/api';
import { stamp, usd } from '../../lib/fmt';
import { useApp, useTz } from '../../state';
import { Field, TextInput } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Action, BesideField } from '../intake/shared';
import { Lead, Pending, useResource } from './shared';
import { OrganizationEditor } from './OrganizationEditor';
import s from './manage.module.css';

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  directors: number;
  watchers: number;
  invitations: number;
  projects: number;
  running: number;
  usage: { usd: number; tokens: number; hours: number };
  license: {
    standing: 'unlimited' | 'none' | 'upcoming' | 'active' | 'ended';
    used: number;
    projectsIncluded?: number;
    endsAt?: string;
  };
}

const STANDING: Record<OrganizationRow['license']['standing'], string> = {
  unlimited: 'No license needed',
  none: 'No license',
  upcoming: 'Starts later',
  active: 'Active',
  ended: 'Ended',
};

/** Into another organization: the cookie the API sets, then the app again from the top. */
export async function switchTo(id: string) {
  await put('/me/organization', { id });
  location.assign('/');
}

export function Organizations() {
  const { toast } = useApp();
  const tz = useTz();
  const { data, error, reload } = useResource<OrganizationRow[]>(
    '/admin/organizations',
    30_000,
    'Organizations could not be loaded.',
  );
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    try {
      const r = await postFor<{
        organization: { id: string; name: string };
        invited: { email: string; emailSent: boolean; detail: string | null } | null;
      }>('/admin/organizations', { name: name.trim(), directorEmail: email.trim() || undefined });
      toast({
        title: `${r.organization.name} is ready`,
        detail: r.invited
          ? r.invited.emailSent
            ? `You are its kickoff Director; ${r.invited.email} is invited as its Director.`
            : `You are its kickoff Director. No email went out to ${r.invited.email}${r.invited.detail ? ` (${r.invited.detail})` : ''}; they can sign in with that address.`
          : 'You are its kickoff Director. Switch to it to invite its people.',
        tone: 'done',
      });
      setName('');
      setEmail('');
      await reload();
    } catch (err) {
      toast(messageOf(err, 'Could not create the organization.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.page}>
      <Lead>
        Every organization on Launchworks. Each one sees only its own projects and people; Icreon’s
        Directors run every kickoff.
      </Lead>
      {!data ? (
        <Pending error={error} loading="Loading organizations…" />
      ) : (
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <caption className="sr-only">Organizations</caption>
            <thead>
              <tr>
                <th scope="col">Organization</th>
                <th scope="col" className={s.num}>
                  Directors
                </th>
                <th scope="col" className={s.num}>
                  Watchers
                </th>
                <th scope="col" className={s.num}>
                  Invited
                </th>
                <th scope="col" className={s.num}>
                  Projects
                </th>
                <th scope="col" className={s.num}>
                  Running
                </th>
                <th scope="col" className={s.num}>
                  Agent spend
                </th>
                <th scope="col">License</th>
                <th scope="col">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id}>
                  <th scope="row" className={s.strong}>
                    {o.name}
                    <span className={`${s.under} type-meta`}>
                      {o.slug} · since {stamp(o.createdAt, tz)}
                    </span>
                  </th>
                  <td className={s.num}>{o.directors}</td>
                  <td className={s.num}>{o.watchers}</td>
                  <td className={s.num}>{o.invitations}</td>
                  <td className={s.num}>{o.projects}</td>
                  <td className={s.num}>{o.running}</td>
                  <td className={s.num}>{usd(o.usage.usd)}</td>
                  <td>
                    {STANDING[o.license.standing]}
                    {o.license.projectsIncluded !== undefined && (
                      <span className={`${s.under} type-meta`}>
                        {o.license.used} of {o.license.projectsIncluded} projects
                        {o.license.endsAt ? ` · to ${o.license.endsAt.slice(0, 10)}` : ''}
                      </span>
                    )}
                  </td>
                  <td>
                    {o.id !== 'org-icreon' && (
                      <Action
                        kind="quiet"
                        expanded={open === o.id}
                        onClick={() => setOpen(open === o.id ? null : o.id)}
                      >
                        Manage
                      </Action>
                    )}
                    <Action
                      kind="quiet"
                      onClick={() =>
                        void switchTo(o.id).catch((err) =>
                          toast(messageOf(err, 'You are not a member of it: join it for support.')),
                        )
                      }
                    >
                      Switch to it
                    </Action>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && data?.some((o) => o.id === open) && (
        <Panel title={data.find((o) => o.id === open)!.name} padded>
          <OrganizationEditor
            id={open}
            name={data.find((o) => o.id === open)!.name}
            onSaved={() => void reload()}
          />
        </Panel>
      )}
      <Panel title="New organization" padded>
        <form
          className={s.inline}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && name.trim()) void create();
          }}
        >
          <Field label="Name" hint="The customer, as their people will see it.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={name}
                maxLength={80}
                placeholder="Globex Industries"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Their first Director"
            optional
            hint="Invited by email. You can invite more people once you switch to it."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                type="email"
                aria-describedby={describedBy}
                value={email}
                placeholder="name@company.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
          <BesideField>
            <Action kind="primary" type="submit" disabled={busy || name.trim().length < 2}>
              {busy ? 'Creating…' : 'Create'}
            </Action>
          </BesideField>
        </form>
      </Panel>
    </div>
  );
}
