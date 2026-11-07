/*
 * The Implementation Blueprint: each row maps code in the source repository to what a marketer
 * edits in the CMS. Rows fold open to their target, source, fields, parameters, placeholders and
 * variants, and to what a row was in the approved version. Beside them: the filters (`ui.bpFilter`),
 * how complete each collection is, and what changed since the approved version.
 */
import type { BlueprintRow, BlueprintSnapshot } from '@lw/contracts';
import { useState } from 'react';
import { shortDay } from '../../lib/fmt';
import { useApp, useMission, useProjectResource, useTz } from '../../state';
import { Icon } from '../../theme/icons';
import { ChangeSummary, type MetricChange } from '../../ui/change-summary';
import { Bar } from '../../ui/cypher/parts';
import { FilterMenu, type FilterGroup, type FilterValue } from '../../ui/filter-menu';
import {
  DECISIONS,
  STATUSES,
  capital,
  formatFilter,
  parseFilter,
  rowMatches,
  statusLabel,
  type Status,
} from './model';
import { DocHead, Quiet, StateWord, Tag, arrowNav, type StateTone } from './parts';
import s from './doc.module.css';

type Collection = BlueprintSnapshot['collections'][number];

const STATUS_TONE: Record<Status, StateTone> = {
  done: 'done',
  in_progress: 'active',
  planned: 'quiet',
  merged: 'quiet',
  dropped: 'quiet',
  held: 'quiet',
};

export function Blueprint() {
  const { ui, setUi } = useApp();
  const tz = useTz();
  const mc = useMission().data;
  const bp = useProjectResource<BlueprintSnapshot>('/blueprint');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // On a phone the filters start folded, so the rows are on the first screen.
  const [narrow] = useState(() => matchMedia('(max-width: 760px)').matches);

  if (!bp.data)
    return (
      <>
        <DocHead title="Implementation Blueprint" />
        <div className={s.body}>
          <Quiet>{bp.error ? bp.error.message : 'Loading the Blueprint…'}</Quiet>
        </div>
      </>
    );

  const b = bp.data;
  const filter = parseFilter(ui.bpFilter);
  const all = b.collections.flatMap((c) => c.rows.map((r) => ({ c, r })));
  const count = (st: Status) => all.filter((x) => x.r.status === st).length;
  const changed = all.filter((x) => x.r.changed);
  const labels = [...new Set(b.collections.map((c) => c.doneLabel))];
  const doneWord = labels.length === 1 ? labels[0]! : 'done';
  const approvedOn = b.approvedAt ? `, ${shortDay(b.approvedAt, tz)}` : '';
  const repo = mc?.project.source.repo?.split('/').pop() ?? 'the source';
  const platform = mc?.project.platform?.name ?? 'the CMS';
  const toggle = (key: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const groups: FilterGroup[] = [
    {
      id: 'status',
      label: 'Status',
      options: STATUSES.filter((st) => count(st) > 0 || filter.statuses.includes(st)).map((st) => ({
        id: st,
        label: `${capital(statusLabel(st, doneWord))} ${count(st)}`,
      })),
    },
    ...(b.approvedVersion !== null
      ? [
          {
            id: 'changes',
            label: 'Changes',
            options: [{ id: 'changed', label: `Changed in v${b.version} ${changed.length}` }],
          },
        ]
      : []),
    ...(b.collections.length > 1
      ? [
          {
            id: 'collection',
            label: 'Collection',
            options: b.collections.map((c) => ({
              id: c.name,
              label: `${capital(c.name)} ${c.rows.length}`,
            })),
          },
        ]
      : []),
  ];
  const value: FilterValue = {
    status: filter.statuses,
    changes: filter.changed ? ['changed'] : [],
    collection: filter.collections,
  };
  const onFilter = (v: FilterValue) =>
    setUi({
      bpFilter: formatFilter({
        statuses: (v.status ?? []).filter((x): x is Status => (STATUSES as string[]).includes(x)),
        changed: (v.changes ?? []).includes('changed'),
        collections: v.collection ?? [],
      }),
    });

  const moved: MetricChange[] = changed.map(({ r }) => ({
    label: r.name,
    change: r.was ? `Was: ${r.was}` : 'New in this version',
    tone: r.status === 'dropped' ? 'bad' : 'neutral',
  }));
  const shownTotal = all.filter((x) => rowMatches(filter, x.c, x.r)).length;

  return (
    <>
      <DocHead
        title="Implementation Blueprint"
        meta={`Version ${b.version}`}
        tags={
          <>
            {b.approvedVersion === null ? (
              <Tag tag={{ label: 'Waiting for approval at Gate 1', tone: 'yours' }} />
            ) : b.approvedVersion === b.version ? (
              <Tag tag={{ label: `Approved at Gate 1${approvedOn}`, tone: 'done' }} />
            ) : (
              <>
                <Tag
                  tag={{
                    label: `v${b.approvedVersion} approved at Gate 1${approvedOn}`,
                    tone: 'done',
                  }}
                />
                <Tag tag={{ label: `Changed since v${b.approvedVersion}`, tone: 'moved' }} />
              </>
            )}
            {b.updatedBy.map((ref) => (
              <Tag
                key={ref}
                tag={{ label: `Updated by ${ref}`, tone: 'moved' }}
                onClick={() => setUi({ wbArtifact: DECISIONS })}
              />
            ))}
          </>
        }
      />
      <div className={`${s.body} ${s.bpBody}`}>
        <p className={`${s.intro} type-body-small`}>
          Each row maps code in {repo} to what a marketer edits in {platform}. Open a row for its
          parameters, placeholders and variants.
        </p>
        <div className={s.bp}>
          <div className={s.bpMain}>
            {b.collections.length === 0 && <Quiet>The Blueprint has no rows yet.</Quiet>}
            {b.collections.map((c) => (
              <Rows
                key={c.name}
                c={c}
                titled={b.collections.length > 1}
                rows={c.rows.filter((r) => rowMatches(filter, c, r))}
                version={b.version}
                approvedVersion={b.approvedVersion}
                open={open}
                toggle={toggle}
              />
            ))}
            {all.length > 0 && shownTotal === 0 && (
              <p className={`${s.quiet} type-body-small`}>
                No row matches these filters.{' '}
                <button
                  type="button"
                  className={`${s.link} type-body-small`}
                  onClick={() => setUi({ bpFilter: 'all' })}
                >
                  Show every row
                </button>
              </p>
            )}
          </div>
          <aside className={s.bpAside} aria-label="Filters and progress">
            <div className={s.bpFilters}>
              <FilterMenu
                title={
                  shownTotal === all.length ? 'Filters' : `Filters · ${shownTotal} of ${all.length}`
                }
                groups={groups}
                value={value}
                onChange={onFilter}
                defaultOpen={narrow ? [] : ['status', 'changes']}
                hints={false}
              />
            </div>
            <div className={s.bpExtra}>
              <Completeness collections={b.collections} />
              {b.approvedVersion !== null && b.approvedVersion !== b.version && (
                <ChangeSummary
                  title={`Since v${b.approvedVersion} was approved`}
                  period={moved.length ? `Version ${b.version}` : 'No row changed'}
                  changes={moved}
                />
              )}
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

/** One collection's rows, each folding open to its detail. */
function Rows({
  c,
  titled,
  rows,
  version,
  approvedVersion,
  open,
  toggle,
}: {
  c: Collection;
  titled: boolean;
  rows: BlueprintRow[];
  version: number;
  approvedVersion: number | null;
  open: Set<string>;
  toggle: (key: string) => void;
}) {
  if (!rows.length) return null;
  return (
    <section className={s.section} aria-label={capital(c.name)}>
      {titled && <h3 className="type-section">{capital(c.name)}</h3>}
      <div className={s.rows} onKeyDown={arrowNav}>
        {rows.map((r) => {
          const key = `${c.name}:${r.key}`;
          const isOpen = open.has(key);
          const id = `bp-${c.name}-${r.key}`.replace(/[^a-zA-Z0-9_-]/g, '-');
          return (
            <div key={r.key} className={s.row} data-open={isOpen || undefined}>
              <button
                type="button"
                className={`${s.rowHead} type-table`}
                aria-expanded={isOpen}
                aria-controls={id}
                onClick={() => toggle(key)}
                data-nav=""
              >
                <span className={s.rowText}>
                  <span className={s.rowName}>{r.name}</span>
                  <span className={`${s.rowSub} type-meta`}>
                    {r.source}
                    {r.fields && r.fields !== '–' ? ` · ${r.fields}` : ''}
                  </span>
                </span>
                {r.changed && <Tag tag={{ label: `Changed in v${version}`, tone: 'moved' }} />}
                <StateWord tone={STATUS_TONE[r.status]}>
                  {statusLabel(r.status, c.doneLabel)}
                </StateWord>
                <Icon name="chevron" size={18} className={s.chev} />
              </button>
              {isOpen && (
                <div id={id} className={s.rowBody}>
                  <dl className={s.facts}>
                    {(
                      [
                        ['Target', r.name],
                        ['Source', r.source],
                        ['Fields', r.fields],
                        ['Parameters', r.params],
                        ['Placeholders', r.placeholders],
                        ['Variants', r.variants],
                      ] as const
                    ).map(([k, v]) => (
                      <div key={k}>
                        <dt className="type-meta">{k}</dt>
                        <dd className="type-table">{v || '–'}</dd>
                      </div>
                    ))}
                  </dl>
                  {r.changed && (
                    <div className={s.was}>
                      <span className={`${s.quietText} type-label`}>
                        Changed in v{version}
                        {r.was ? ` · in version ${approvedVersion ?? 1} it was` : ''}
                      </span>
                      {r.was && <p className="type-body-small">{r.was}</p>}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** How complete each collection is: what is done of what is kept, and the rest in words. */
function Completeness({ collections }: { collections: Collection[] }) {
  if (!collections.length) return null;
  return (
    <section className={s.tray} aria-label="Completeness">
      <h3 className={`${s.trayTitle} type-body-small`}>Completeness</h3>
      <div className={s.trayCard}>
        {collections.map((c) => {
          const n = (st: Status) => c.rows.filter((r) => r.status === st).length;
          const kept = c.rows.filter(
            (r) => r.status !== 'dropped' && r.status !== 'merged' && r.status !== 'held',
          ).length;
          const done = n('done');
          const pct = kept ? Math.round((done / kept) * 100) : 0;
          const rest = (['in_progress', 'planned', 'held', 'dropped', 'merged'] as const)
            .filter((st) => n(st) > 0)
            .map((st) => `${capital(statusLabel(st, c.doneLabel))} ${n(st)}`);
          return (
            <div key={c.name} className={s.complete}>
              <span className={`${s.quietText} type-label`}>{c.name}</span>
              <span className={s.completeNumber}>
                <span className="type-number">{done}</span>
                <span className="type-number-unit">
                  {' '}
                  of {kept} {c.doneLabel}
                </span>
              </span>
              <Bar percent={pct} hue="var(--green)" />
              {rest.length > 0 && (
                <span className={`${s.quietText} type-meta`}>{rest.join(' · ')}</span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
