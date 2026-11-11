/*
 * The organization's people, in Global settings: who belongs and in which role, who is invited,
 * and a Director's way to invite, change and remove. Watchers don't see it: they change nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { del, get, messageOf, postFor, put } from '../../lib/api';
import { stamp } from '../../lib/fmt';
import { isWatching } from '../../lib/role';
import { useApp, useTz } from '../../state';
import { Field, Select, TextInput } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Action, BesideField, Notice } from '../intake/shared';
import s from './settings.module.css';

type Role = 'director' | 'watcher';
interface People {
  organization: { id: string; name: string; slug: string };
  /** Until when Icreon's Director can't be removed or demoted; null once they can. */
  kickoffUntil: string | null;
  emailInvitations: boolean;
  members: {
    subject: string;
    label: string;
    via: 'email' | 'github' | 'local';
    role: Role;
    since: string;
    you: boolean;
    icreon: boolean;
    /** Icreon's support access: when it ends. */
    until: string | null;
  }[];
  invitations: { id: string; email: string; role: Role; invitedBy: string; expiresAt: string }[];
}

const ROLE: Record<Role, string> = {
  director: 'Director: decides and changes everything',
  watcher: 'Watcher: sees everything, changes nothing',
};
const roleName = (r: Role) => (r === 'director' ? 'Director' : 'Watcher');

export function PeoplePanel() {
  const { toast } = useApp();
  const tz = useTz();
  const [people, setPeople] = useState<People | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('watcher');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      get<People>('/organization/people')
        .then((p) => {
          setPeople(p);
          setProblem(null);
        })
        .catch((err) => setProblem(messageOf(err, 'Could not load the people here.'))),
    [],
  );
  useEffect(() => {
    if (!isWatching()) void load();
  }, [load]);
  if (isWatching()) return null;

  const invite = async () => {
    setBusy(true);
    try {
      const r = await postFor<{ emailSent: boolean; detail: string | null }>(
        '/organization/invitations',
        { email: email.trim(), role },
      );
      toast({
        title: `${email.trim()} is invited`,
        detail: r.emailSent
          ? 'WorkOS sent the invitation email. It is open for 7 days.'
          : `No email went out${r.detail ? ` (${r.detail})` : ''}. They can sign in with that address within 7 days.`,
        tone: 'done',
      });
      setEmail('');
      await load();
    } catch (err) {
      toast(messageOf(err, 'Could not send the invitation.'));
    } finally {
      setBusy(false);
    }
  };
  const act = async (fn: () => Promise<unknown>, failed: string) => {
    try {
      await fn();
      await load();
    } catch (err) {
      toast(messageOf(err, failed));
    }
  };
  const member = (subject: string) => `/organization/members/${encodeURIComponent(subject)}`;

  return (
    <Panel title="People" meta={people?.organization.name ?? ''} padded>
      {problem ? (
        <Notice tone="bad">{problem}</Notice>
      ) : !people ? (
        <p className={s.quiet}>Loading…</p>
      ) : (
        <div className={s.stack}>
          <p className={s.lead}>
            Directors decide and change everything in {people.organization.name}’s projects.
            Watchers see every plan, the team at work and every decision, and change nothing.
          </p>
          <ul className={s.rows}>
            {people.members.map((m) => (
              <li key={m.subject} className={s.row}>
                <span className={s.rowText}>
                  <span className={s.strong}>
                    {m.label}
                    {m.you && <span className={s.quietInline}> (you)</span>}
                  </span>
                  <span className={`${s.quiet} type-meta`}>
                    {roleName(m.role)}
                    {m.icreon ? ' · Icreon' : ''}
                    {m.until ? ` · Icreon support until ${stamp(m.until, tz)}` : ''} ·{' '}
                    {m.via === 'github' ? 'GitHub' : m.via === 'email' ? 'Email' : 'Local run'} ·
                    since {stamp(m.since, tz)}
                  </span>
                </span>
                {!m.you && !(m.icreon && people.kickoffUntil) && (
                  <>
                    <Action
                      kind="quiet"
                      onClick={() =>
                        void act(
                          () =>
                            put(member(m.subject), {
                              role: m.role === 'director' ? 'watcher' : 'director',
                            }),
                          'Could not change the role.',
                        )
                      }
                    >
                      Make {m.role === 'director' ? 'Watcher' : 'Director'}
                    </Action>
                    <Action
                      kind="danger"
                      onClick={() =>
                        void act(() => del(member(m.subject)), 'Could not remove them.')
                      }
                    >
                      Remove
                    </Action>
                  </>
                )}
              </li>
            ))}
            {people.invitations.map((i) => (
              <li key={i.id} className={s.row}>
                <span className={s.rowText}>
                  <span className={s.strong}>{i.email}</span>
                  <span className={`${s.quiet} type-meta`}>
                    Invited as {roleName(i.role)} by {i.invitedBy} · open until{' '}
                    {stamp(i.expiresAt, tz)}
                  </span>
                </span>
                <Action
                  kind="quiet"
                  onClick={() =>
                    void act(
                      () => del(`/organization/invitations/${i.id}`),
                      'Could not withdraw the invitation.',
                    )
                  }
                >
                  Withdraw
                </Action>
              </li>
            ))}
          </ul>
          <form
            className={s.inline}
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && email.trim()) void invite();
            }}
          >
            <Field
              label="Invite by email"
              hint={
                people.emailInvitations
                  ? 'WorkOS emails them a link to sign in.'
                  : 'They sign in with this address; email invitations start once WorkOS is set up.'
              }
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
            <Field label="Role">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  {(['watcher', 'director'] as const).map((r) => (
                    <option key={r} value={r}>
                      {ROLE[r]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <BesideField>
              <Action kind="primary" type="submit" disabled={busy || !email.trim()}>
                {busy ? 'Inviting…' : 'Invite'}
              </Action>
            </BesideField>
          </form>
        </div>
      )}
    </Panel>
  );
}
