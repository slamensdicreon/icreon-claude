/*
 * Your playbooks: the organization's own rules and lessons on top of each playbook it licenses.
 * They apply to its projects only and at once; Icreon's playbook stays as it is (Icreon sees every
 * variant in its admin console). Watchers read them; Directors add, edit, retire and restore.
 */
import type { KnowledgeEntry, RuleView } from '@lw/contracts';
import { useState } from 'react';
import { messageOf, post, postFor, put } from '../../lib/api';
import { isWatching } from '../../lib/role';
import { useApp } from '../../state';
import { Field, Select, TextArea, TextInput } from '../../ui/cypher/forms';
import { Panel } from '../../ui/cypher/parts';
import { Action, Actions, Notice } from '../intake/shared';
import { Lead, Pending, useResource } from './shared';
import s from './manage.module.css';

interface Variants {
  playbooks: { id: string; name: string; platform: { id: string; name: string } }[];
  rules: RuleView[];
  knowledge: KnowledgeEntry[];
}

/** What a rule is about: the kinds of question the Leads meet. */
const CATEGORY: Record<RuleView['category'], string> = {
  naming: 'Naming',
  content: 'Content',
  media: 'Media',
  scope: 'Scope',
  ownership: 'Ownership',
  access: 'Access',
  tool: 'Tools',
  retry: 'Retries',
  release: 'Release',
  other: 'Other',
};
const KIND = { lesson: 'Lesson', procedure: 'Procedure' } as const;
type Kind = keyof typeof KIND;

/** Active first, then retired; newest first within each. */
const byStatus = <T extends { status: string }>(xs: T[]) => [
  ...xs.filter((x) => x.status === 'active'),
  ...xs.filter((x) => x.status !== 'active'),
];

export function Variants() {
  const { data, error, reload } = useResource<Variants>(
    '/organization/variants',
    null,
    'Your playbooks could not be loaded.',
  );
  const [chosen, setChosen] = useState<string | null>(null);
  if (!data) return <Pending error={error} loading="Loading your playbooks…" />;
  if (!data.playbooks.length)
    return (
      <div className={s.page}>
        <Lead>
          Your own rules and lessons go on the playbooks you license. You license none yet.
        </Lead>
      </div>
    );
  const pb = data.playbooks.find((p) => p.id === chosen) ?? data.playbooks[0]!;
  const onIt = (x: { scope: { kind: string; id: string } }) =>
    x.scope.kind === 'playbook' && x.scope.id === pb.id;
  const refresh = () => void reload();
  return (
    <div className={s.page}>
      <Lead>
        Your own rules and lessons on top of each playbook you license. They apply to your projects
        only, from the next decision or task on; Icreon’s playbook stays as it is.
      </Lead>
      {data.playbooks.length > 1 && (
        <Field label="Playbook">
          {({ id }) => (
            <Select id={id} value={pb.id} onChange={(e) => setChosen(e.target.value)}>
              {data.playbooks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.platform.name})
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <RulesPanel playbookId={pb.id} rules={byStatus(data.rules.filter(onIt))} onSaved={refresh} />
      <LessonsPanel
        playbookId={pb.id}
        entries={byStatus(data.knowledge.filter(onIt))}
        onSaved={refresh}
      />
    </div>
  );
}

/** Saves, says so, and reloads; or says what went wrong. */
function useSave(onSaved: () => void) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const save = async (work: () => Promise<unknown>, done: string, failed: string) => {
    setBusy(true);
    try {
      await work();
      toast({ title: done, tone: 'done' });
      onSaved();
      return true;
    } catch (err) {
      toast(messageOf(err, failed));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, save };
}

function RulesPanel({
  playbookId,
  rules,
  onSaved,
}: {
  playbookId: string;
  rules: RuleView[];
  onSaved: () => void;
}) {
  const { busy, save } = useSave(onSaved);
  const [when, setWhen] = useState('');
  const [then, setThen] = useState('');
  const [category, setCategory] = useState<RuleView['category']>('other');
  const [editing, setEditing] = useState<string | null>(null);
  const director = !isWatching();
  const add = async () => {
    const ok = await save(
      () =>
        postFor('/organization/rules', {
          when,
          then,
          category,
          scope: { kind: 'playbook', id: playbookId },
        }),
      'Rule added: it applies from the next decision on',
      'The rule could not be added.',
    );
    if (ok) {
      setWhen('');
      setThen('');
    }
  };
  return (
    <Panel title="Your rules" count={rules.filter((r) => r.status === 'active').length} padded>
      <p className={`${s.quiet} type-body-small`}>
        When this happens, do that: the team follows your rules without asking you again.
      </p>
      {!rules.length && <Notice tone="idle">No rules of your own on this playbook yet.</Notice>}
      <div className={s.entries}>
        {rules.map((r) =>
          editing === r.id ? (
            <RuleEdit
              key={r.id}
              rule={r}
              onDone={() => {
                setEditing(null);
                onSaved();
              }}
            />
          ) : (
            <div key={r.id} className={s.entry} data-status={r.status}>
              <div className={s.entryHead}>
                <span className={`${s.ref} type-meta`}>{r.ref}</span>
                <span className={`${s.tag} type-meta`}>{CATEGORY[r.category]}</span>
                {r.status !== 'active' && <span className={`${s.tag} type-meta`}>Retired</span>}
                {r.applied > 0 && (
                  <span className="type-meta">
                    Applied {r.applied} {r.applied === 1 ? 'time' : 'times'}
                  </span>
                )}
              </div>
              <div className={s.entryBody}>
                <p className={`${s.ruleText} type-body-small`}>
                  <b>When</b> {r.when}, <b>then</b> {r.then}
                </p>
              </div>
              {director && (
                <Actions>
                  <Action kind="quiet" disabled={busy} onClick={() => setEditing(r.id)}>
                    Edit
                  </Action>
                  <Action
                    kind="quiet"
                    disabled={busy}
                    onClick={() =>
                      void save(
                        () =>
                          post(
                            `/organization/rules/${r.id}/${r.status === 'active' ? 'retire' : 'activate'}`,
                          ),
                        r.status === 'active' ? 'Rule retired' : 'Rule restored',
                        'The rule could not be changed.',
                      )
                    }
                  >
                    {r.status === 'active' ? 'Retire' : 'Restore'}
                  </Action>
                </Actions>
              )}
            </div>
          ),
        )}
      </div>
      {director && (
        <form
          className={s.entryEdit}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void add();
          }}
        >
          <h3 className="type-label">Add a rule</h3>
          <Field label="When" hint="What happens: “a page title repeats the brand name”.">
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={2}
                maxLength={600}
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            )}
          </Field>
          <Field label="Then" hint="What the team does: “keep it once, at the end”.">
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={2}
                maxLength={600}
                value={then}
                onChange={(e) => setThen(e.target.value)}
              />
            )}
          </Field>
          <Field label="About">
            {({ id }) => (
              <Select
                id={id}
                value={category}
                onChange={(e) => setCategory(e.target.value as RuleView['category'])}
              >
                {Object.entries(CATEGORY).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Actions>
            <Action
              kind="primary"
              type="submit"
              disabled={busy || when.trim().length < 3 || then.trim().length < 3}
            >
              {busy ? 'Adding…' : 'Add rule'}
            </Action>
          </Actions>
        </form>
      )}
    </Panel>
  );
}

function RuleEdit({ rule, onDone }: { rule: RuleView; onDone: () => void }) {
  const { busy, save } = useSave(onDone);
  const [when, setWhen] = useState(rule.when);
  const [then, setThen] = useState(rule.then);
  return (
    <form
      className={s.entryEdit}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy)
          void save(
            () => put(`/organization/rules/${rule.id}`, { when, then }),
            `${rule.ref} saved`,
            'The rule could not be saved.',
          );
      }}
    >
      <Field label={`${rule.ref}: when`}>
        {({ id }) => (
          <TextArea
            id={id}
            rows={2}
            maxLength={600}
            value={when}
            onChange={(e) => setWhen(e.target.value)}
          />
        )}
      </Field>
      <Field label="Then">
        {({ id }) => (
          <TextArea
            id={id}
            rows={2}
            maxLength={600}
            value={then}
            onChange={(e) => setThen(e.target.value)}
          />
        )}
      </Field>
      <Actions>
        <Action kind="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Action>
        <Action kind="quiet" onClick={onDone}>
          Cancel
        </Action>
      </Actions>
    </form>
  );
}

function LessonsPanel({
  playbookId,
  entries,
  onSaved,
}: {
  playbookId: string;
  entries: KnowledgeEntry[];
  onSaved: () => void;
}) {
  const { busy, save } = useSave(onSaved);
  const [kind, setKind] = useState<Kind>('lesson');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const director = !isWatching();
  const add = async () => {
    const ok = await save(
      () =>
        postFor('/organization/knowledge', {
          kind,
          title,
          text,
          scope: { kind: 'playbook', id: playbookId },
        }),
      'Added: the team has it from its next task on',
      'It could not be added.',
    );
    if (ok) {
      setTitle('');
      setText('');
    }
  };
  return (
    <Panel
      title="Your lessons and procedures"
      count={entries.filter((e) => e.status === 'active').length}
      padded
    >
      <p className={`${s.quiet} type-body-small`}>
        What your team should know, or the steps it should follow, on your projects. It goes into
        the briefs of the tasks it fits.
      </p>
      {!entries.length && (
        <Notice tone="idle">No lessons or procedures of your own on this playbook yet.</Notice>
      )}
      <div className={s.entries}>
        {entries.map((e) =>
          editing === e.id ? (
            <EntryEdit
              key={e.id}
              entry={e}
              onDone={() => {
                setEditing(null);
                onSaved();
              }}
            />
          ) : (
            <div key={e.id} className={s.entry} data-status={e.status}>
              <div className={s.entryHead}>
                <span className={`${s.ref} type-meta`}>{e.ref}</span>
                <span className={`${s.tag} type-meta`}>{KIND[e.kind as Kind] ?? e.kind}</span>
                {e.status !== 'active' && <span className={`${s.tag} type-meta`}>Retired</span>}
                {e.used > 0 && (
                  <span className="type-meta">
                    In {e.used} {e.used === 1 ? 'brief' : 'briefs'}
                  </span>
                )}
              </div>
              <div className={s.entryBody}>
                <p className={`${s.entryTitle} type-body-small`}>{e.title}</p>
                <p className={`${s.entryText} type-body-small`}>{e.text}</p>
              </div>
              {director && (
                <Actions>
                  <Action kind="quiet" disabled={busy} onClick={() => setEditing(e.id)}>
                    Edit
                  </Action>
                  <Action
                    kind="quiet"
                    disabled={busy}
                    onClick={() =>
                      void save(
                        () =>
                          post(
                            `/organization/knowledge/${e.id}/${e.status === 'active' ? 'retire' : 'activate'}`,
                          ),
                        e.status === 'active' ? 'Retired' : 'Restored',
                        'It could not be changed.',
                      )
                    }
                  >
                    {e.status === 'active' ? 'Retire' : 'Restore'}
                  </Action>
                </Actions>
              )}
            </div>
          ),
        )}
      </div>
      {director && (
        <form
          className={s.entryEdit}
          onSubmit={(ev) => {
            ev.preventDefault();
            if (!busy) void add();
          }}
        >
          <h3 className="type-label">Add a lesson or procedure</h3>
          <Field label="Kind">
            {({ id }) => (
              <Select id={id} value={kind} onChange={(ev) => setKind(ev.target.value as Kind)}>
                <option value="lesson">Lesson: something to know</option>
                <option value="procedure">Procedure: steps to follow</option>
              </Select>
            )}
          </Field>
          <Field label="Title">
            {({ id }) => (
              <TextInput
                id={id}
                maxLength={200}
                value={title}
                onChange={(ev) => setTitle(ev.target.value)}
              />
            )}
          </Field>
          <Field label={kind === 'procedure' ? 'Steps' : 'What to know'}>
            {({ id }) => (
              <TextArea
                id={id}
                rows={4}
                maxLength={2000}
                value={text}
                onChange={(ev) => setText(ev.target.value)}
              />
            )}
          </Field>
          <Actions>
            <Action
              kind="primary"
              type="submit"
              disabled={busy || title.trim().length < 3 || text.trim().length < 3}
            >
              {busy ? 'Adding…' : 'Add'}
            </Action>
          </Actions>
        </form>
      )}
    </Panel>
  );
}

function EntryEdit({ entry, onDone }: { entry: KnowledgeEntry; onDone: () => void }) {
  const { busy, save } = useSave(onDone);
  const [title, setTitle] = useState(entry.title);
  const [text, setText] = useState(entry.text);
  return (
    <form
      className={s.entryEdit}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!busy)
          void save(
            () => put(`/organization/knowledge/${entry.id}`, { title, text }),
            `${entry.ref} saved`,
            'It could not be saved.',
          );
      }}
    >
      <Field label={`${entry.ref}: title`}>
        {({ id }) => (
          <TextInput
            id={id}
            maxLength={200}
            value={title}
            onChange={(ev) => setTitle(ev.target.value)}
          />
        )}
      </Field>
      <Field label="Text">
        {({ id }) => (
          <TextArea
            id={id}
            rows={4}
            maxLength={2000}
            value={text}
            onChange={(ev) => setText(ev.target.value)}
          />
        )}
      </Field>
      <Actions>
        <Action kind="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Action>
        <Action kind="quiet" onClick={onDone}>
          Cancel
        </Action>
      </Actions>
    </form>
  );
}
