/*
 * What the team knows across projects: lessons, procedures and gaps. Retrospectives propose them
 * at each phase's end; the active ones that fit a task go in its brief. The same calls as the old
 * page (surfaces/Knowledge.tsx), on Cypher's parts.
 *
 * Platform names, the export buttons and the scopes a new lesson can take come from the playbook
 * catalog (GET /playbooks, each playbook's platform) rather than a fixed list, joined with any
 * platform an entry is already scoped to.
 */
import type { KnowledgeEffect, KnowledgeEntry, KnowledgeList, PortfolioItem } from '@lw/contracts';
import { useState } from 'react';
import { get, messageOf, post, put } from '../../lib/api';
import { useApp } from '../../state';
import { Field, Select, TextArea, TextInput } from '../../ui/cypher/forms';
import { Chips, Panel } from '../../ui/cypher/parts';
import { Action, Actions, Notice, usePlaybooks } from '../intake/shared';
import { EntryCard } from './EntryCard';
import {
  catalogNames,
  count,
  FoldPanel,
  Lead,
  Pending,
  useResource,
  type CatalogNames,
} from './shared';
import s from './manage.module.css';

export const KIND_LABEL: Record<KnowledgeEntry['kind'], string> = {
  lesson: 'Lesson',
  procedure: 'Procedure',
  gap: 'Needs engineering',
};
const HISTORY: Record<string, string> = {
  created: 'Created',
  edited: 'Edited',
  activated: 'Approved',
  retired: 'Retired',
  proposed: 'Proposed again',
  used: 'Put in a brief',
};

type Kind = 'all' | KnowledgeEntry['kind'];

function scopeLabel(e: KnowledgeEntry, projects: { id: string; name: string }[], n: CatalogNames) {
  const { kind, id } = e.scope;
  if (kind === 'global') return 'Everywhere';
  if (kind === 'platform') return `Every ${n.platform(id)} project`;
  if (kind === 'playbook') return `The ${n.playbook(id)} playbook`;
  if (kind === 'role') return `The ${n.role(id)} role`;
  return `Project: ${projects.find((p) => p.id === id)?.name ?? id}`;
}

/** The platforms knowledge can be scoped to and exported for: the catalog's, then any in use. */
function platformsOf(n: CatalogNames, entries: KnowledgeEntry[]): [string, string][] {
  const out = new Map(n.platforms);
  for (const e of entries)
    if (e.scope.kind === 'platform' && !out.has(e.scope.id)) out.set(e.scope.id, e.scope.id);
  return [...out.entries()];
}

/** One knowledge entry on the shared card: the Knowledge page and the Workbench's Lessons. */
export function KnowledgeCard({
  e,
  effect,
  projects,
  names,
  onChange,
}: {
  e: KnowledgeEntry;
  effect?: KnowledgeEffect;
  projects: { id: string; name: string }[];
  names: CatalogNames;
  onChange: () => void;
}) {
  const flagged = effect?.flagged ?? false;
  const proposed = e.status === 'proposed';
  const facts =
    e.kind === 'gap'
      ? 'Not put in briefs: it needs a change in code, a tool or a permission.'
      : `In ${count(e.used, 'brief')}${
          effect?.tasks
            ? `; ${effect.failed} of the ${count(effect.tasks, 'task')} that carried it were still rejected or sent back`
            : ''
        }.`;
  return (
    <EntryCard
      refId={e.ref}
      status={e.status}
      pill={KIND_LABEL[e.kind]}
      where={[
        scopeLabel(e, projects, names),
        ...(e.roles.length ? [`For ${e.roles.map(names.role).join(', ')}`] : []),
        ...(e.operations.length ? [e.operations.slice(0, 3).join(', ')] : []),
      ]}
      author={e.author}
      updatedAt={e.updatedAt}
      view={
        <>
          <p className={`${s.entryTitle} type-body-small`}>{e.title}</p>
          <p className={`${s.entryText} type-body-small`}>{e.text}</p>
        </>
      }
      edit={{
        fields: [
          { key: 'title', label: 'The problem', value: e.title },
          { key: 'text', label: 'What to know or do', value: e.text, rows: 3 },
        ],
        save: (v) => put(`/knowledge/${e.id}`, { title: v.title, text: v.text }),
      }}
      facts={`${facts} Version ${e.version}.`}
      flag={
        flagged && e.kind !== 'gap'
          ? 'It isn’t preventing what it’s about: edit it or retire it.'
          : null
      }
      approve={
        proposed
          ? {
              label: 'Approve',
              run: () => post(`/knowledge/${e.id}/approve`),
              done:
                e.kind === 'gap'
                  ? `${e.ref} is on engineering's list.`
                  : `${e.ref} is active: briefs it fits carry it now.`,
            }
          : null
      }
      retire={{
        label: proposed ? 'Reject' : 'Retire',
        run: () => post(`/knowledge/${e.id}/${proposed ? 'reject' : 'retire'}`),
        done: `${e.ref} is ${proposed ? 'rejected' : 'retired'}.`,
      }}
      history={() =>
        get<{ at: string; kind: string }[]>(`/knowledge/${e.id}/history`).then((list) =>
          list.slice(-12).map((h) => ({ at: h.at, text: HISTORY[h.kind] ?? h.kind })),
        )
      }
      evidence={
        e.author === 'seed'
          ? null
          : {
              summary: `What it stands on (${e.evidence.length})`,
              items: e.evidence
                .slice(0, 12)
                .map((x) => ({ key: `${x.projectId}:${x.ref}`, text: x.label })),
            }
      }
      onChange={onChange}
    />
  );
}

/** Entries by status: proposed, active, then retired folded away. */
export function EntryGroups({
  entries,
  render,
  noun = 'entry',
  nouns = 'entries',
}: {
  entries: KnowledgeEntry[];
  render: (e: KnowledgeEntry) => React.ReactNode;
  noun?: string;
  nouns?: string;
}) {
  const of = (status: KnowledgeEntry['status']) => entries.filter((e) => e.status === status);
  const proposed = of('proposed');
  const active = of('active');
  const retired = of('retired');
  return (
    <>
      {proposed.length > 0 && (
        <Panel title="Proposed" count={proposed.length} meta="Waiting for you">
          <div className={s.entries}>{proposed.map(render)}</div>
        </Panel>
      )}
      {active.length > 0 && (
        <Panel title="Active" meta={count(active.length, noun, nouns)}>
          <div className={s.entries}>{active.map(render)}</div>
        </Panel>
      )}
      {retired.length > 0 && (
        <FoldPanel title="Retired" meta={count(retired.length, noun, nouns)}>
          <div className={s.entries}>{retired.map(render)}</div>
        </FoldPanel>
      )}
    </>
  );
}

export function Knowledge({ projects }: { projects: PortfolioItem[] }) {
  const { toast } = useApp();
  const { data, error, reload } = useResource<KnowledgeList>(
    '/knowledge',
    null,
    'Knowledge could not be loaded.',
  );
  const names = catalogNames(usePlaybooks().playbooks);
  const [kind, setKind] = useState<Kind>('all');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  if (!data) return <Pending error={error} loading="Loading knowledge…" />;

  const words = q.trim().toLowerCase();
  const shown = data.entries.filter(
    (e) =>
      (kind === 'all' || e.kind === kind) &&
      (!words || `${e.ref} ${e.title} ${e.text} ${e.tags.join(' ')}`.toLowerCase().includes(words)),
  );
  const effects = new Map(data.effects.map((x) => [x.id, x]));
  const platforms = platformsOf(names, data.entries);
  const exportPlatform = async (platform: string) => {
    try {
      const md = await get<string>(`/knowledge/export?platform=${encodeURIComponent(platform)}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
      a.download = `${platform}-lessons.md`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast(messageOf(err, 'The export did not work.'));
    }
  };

  return (
    <div className={s.page}>
      <Lead>
        What the team knows across projects. The active entries that fit a task go in its brief;
        each phase’s retrospective proposes new ones from what the phase cost, and none apply until
        you approve them.
      </Lead>
      {error && <Notice tone="bad">{error}</Notice>}
      {platforms.length > 0 && (
        <div className={s.exportRow}>
          <span className={`${s.exportLabel} type-meta`}>
            Active lessons as Markdown, with those that apply everywhere
          </span>
          {platforms.map(([id, name]) => (
            <Action key={id} kind="quiet" onClick={() => void exportPlatform(id)}>
              Export {name}
            </Action>
          ))}
        </div>
      )}

      <div className={s.toolbar}>
        <Chips<Kind>
          label="Kind"
          value={kind}
          onChange={setKind}
          options={(['all', 'lesson', 'procedure', 'gap'] as const).map((k) => ({
            value: k,
            label: k === 'all' ? 'All' : KIND_LABEL[k],
            count:
              k === 'all' ? data.entries.length : data.entries.filter((e) => e.kind === k).length,
          }))}
        />
        <span className={s.search}>
          <TextInput
            type="search"
            placeholder="Search knowledge"
            aria-label="Search knowledge"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
        <span className={s.toolbarEnd}>
          <Action
            kind={adding ? 'secondary' : 'primary'}
            expanded={adding}
            controls={adding ? 'write-a-lesson' : undefined}
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? 'Close' : 'Write a lesson'}
          </Action>
        </span>
      </div>

      {adding && (
        <NewLesson
          platforms={platforms}
          onDone={() => {
            setAdding(false);
            void reload();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      <EntryGroups
        entries={shown}
        render={(e) => (
          <KnowledgeCard
            key={e.id}
            e={e}
            effect={effects.get(e.id)}
            projects={projects}
            names={names}
            onChange={() => void reload()}
          />
        )}
      />
      {!shown.length && (
        <p className={`${s.quiet} type-body-small`}>
          {data.entries.length ? 'Nothing matches.' : 'Nothing written down yet.'}
        </p>
      )}
    </div>
  );
}

function NewLesson({
  platforms,
  onDone,
  onCancel,
}: {
  platforms: [string, string][];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { toast } = useApp();
  const scopes = [
    { value: 'global:*', label: 'Everywhere' },
    ...platforms.map(([id, name]) => ({ value: `platform:${id}`, label: `Every ${name} project` })),
  ];
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  // The first platform, as before; everywhere when the catalog names none.
  const [scope, setScope] = useState((scopes[1] ?? scopes[0]!).value);
  const [roles, setRoles] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = title.trim().length >= 3 && text.trim().length >= 3;
  const save = async () => {
    const [kind, id] = scope.split(':') as [string, string];
    setBusy(true);
    try {
      await post('/knowledge', {
        title,
        text,
        scope: { kind, id },
        roles: roles
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
      });
      toast({ title: 'Saved', detail: 'Briefs it fits carry it now.', tone: 'done' });
      onDone();
    } catch (err) {
      toast(messageOf(err, 'It was not saved.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section id="write-a-lesson" aria-label="Write a lesson">
      <Panel title="Write a lesson" meta="Active as soon as it is saved" padded>
        <form
          className={s.stack}
          onSubmit={(e) => {
            e.preventDefault();
            if (ready && !busy) void save();
          }}
        >
          <Field label="The problem, as an agent meets it">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                aria-describedby={describedBy}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </Field>
          <Field label="What to know or do">
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={3}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            )}
          </Field>
          <div className={s.two}>
            <Field label="Where it applies">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  aria-describedby={describedBy}
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                >
                  {scopes.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Only for these roles"
              optional
              hint="Role ids, separated by commas. Leave it empty for every role."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  value={roles}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setRoles(e.target.value)}
                />
              )}
            </Field>
          </div>
          <Actions>
            <Action kind="primary" type="submit" disabled={!ready || busy}>
              {busy ? 'Saving…' : 'Save'}
            </Action>
            <Action onClick={onCancel}>Cancel</Action>
          </Actions>
        </form>
      </Panel>
    </section>
  );
}
