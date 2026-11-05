/*
 * Project facts: what the team's tasks made (renderings, templates, pages, media with their IDs
 * and paths), as later tasks look it up. A value that changed after other tasks finished on the
 * old one is listed first, with those tasks.
 */
import type { FactsSnapshot, FactView } from '@lw/contracts';
import { useState } from 'react';
import { stamp } from '../../lib/fmt';
import { useProjectResource, useRoster, useTz } from '../../state';
import { Chips } from '../../ui/cypher/parts';
import { DocHead, Quiet, Tag } from './parts';
import s from './doc.module.css';

const LIMIT = 500;

const FACT_KINDS: Record<string, string> = {
  rendering: 'Renderings',
  template: 'Templates',
  page: 'Pages',
  layout: 'Page layouts',
  datasource: 'Datasources',
  media: 'Media',
};

const kindLabel = (k: string, one = false) => {
  const label = FACT_KINDS[k] ?? k.charAt(0).toUpperCase() + k.slice(1);
  return one ? label.replace(/s$/, '') : label;
};

/** A fact's value, one field a line. */
function FactValue({ v }: { v: FactView['value'] }) {
  return (
    <dl className={s.value}>
      {Object.entries(v)
        .filter(([, x]) => x !== null && x !== '')
        .map(([k, x]) => (
          <div key={k}>
            <dt className="type-meta">{k}</dt>
            <dd className="type-meta">{String(x)}</dd>
          </div>
        ))}
    </dl>
  );
}

export function ProjectFacts() {
  const tz = useTz();
  const roster = useRoster();
  const res = useProjectResource<FactsSnapshot>('/facts');
  const snap = res.data;
  const [kind, setKind] = useState('all');
  const [q, setQ] = useState('');
  const head = (
    <DocHead
      title="Project facts"
      meta={snap ? `${snap.facts.length} recorded` : undefined}
      tags={
        snap && snap.changed.length > 0 ? (
          <Tag tag={{ label: `${snap.changed.length} changed after use`, tone: 'warn' }} />
        ) : null
      }
    />
  );
  if (!snap)
    return (
      <>
        {head}
        <div className={s.body}>
          <Quiet>{res.error ? res.error.message : 'Loading facts…'}</Quiet>
        </div>
      </>
    );
  const kinds = [...new Set(snap.facts.map((f) => f.kind))].sort();
  const words = q.trim().toLowerCase();
  const shown = snap.facts.filter(
    (f) =>
      (kind === 'all' || f.kind === kind) &&
      (!words ||
        `${f.key} ${f.summary} ${Object.values(f.value).join(' ')}`.toLowerCase().includes(words)),
  );
  const who = (role: string) => {
    const a = roster.byId(role) ?? roster.agents.find((x) => x.role === role);
    return a?.persona ?? a?.name ?? role;
  };
  return (
    <>
      {head}
      <div className={`${s.body} ${s.blocks}`}>
        <p className={`${s.intro} type-body-small`}>
          What the team&rsquo;s tasks made, with the IDs and paths later tasks look up instead of
          asking. Most are recorded from what Sitecore answered; agents publish the rest.
        </p>

        {snap.changed.length > 0 && (
          <section className={s.section} aria-labelledby="facts-changed">
            <h3 id="facts-changed" className="type-section">
              Changed after use
            </h3>
            <p className={`${s.secondary} type-body-small`}>
              These values changed after other tasks finished with the old one. Those tasks may
              still point at the old value: re-run them from the Plan if they do.
            </p>
            <div className={s.tableWrap}>
              <table className={`${s.table} type-table`} data-stack="">
                <thead>
                  <tr>
                    <th>Fact</th>
                    <th>Was</th>
                    <th>Now</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.changed.map((c) => (
                    <tr key={`${c.kind}:${c.key}`} data-warn="">
                      <td className={s.factCell}>
                        <span className={`${s.quietText} type-meta`}>
                          {kindLabel(c.kind, true)}
                        </span>
                        <b className={s.factKey}>{c.key}</b>
                        <span className={`${s.why} type-meta`}>
                          Changed {stamp(c.at, tz)}. Finished before:{' '}
                          {c.tasks.map((t) => t.title).join(', ')}
                        </span>
                      </td>
                      <td>
                        <FactValue v={c.from} />
                      </td>
                      <td>
                        <FactValue v={c.to} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {snap.facts.length === 0 ? (
          <Quiet>
            Nothing recorded yet. Facts appear as tasks create renderings, templates, pages and
            media.
          </Quiet>
        ) : (
          <section className={s.section} aria-labelledby="facts-all">
            <h3 id="facts-all" className="type-section">
              Every fact
            </h3>
            <div className={s.toolbar}>
              <Chips
                label="Kind"
                value={kind}
                onChange={setKind}
                options={['all', ...kinds].map((k) => ({
                  value: k,
                  label: k === 'all' ? 'Everything' : kindLabel(k),
                  count:
                    k === 'all' ? snap.facts.length : snap.facts.filter((f) => f.kind === k).length,
                }))}
              />
              <input
                className={`${s.search} type-body-small`}
                type="search"
                placeholder="Search facts"
                aria-label="Search facts"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <div className={s.tableWrap}>
              <table className={`${s.table} type-table`} data-stack="">
                <thead>
                  <tr>
                    <th>Fact</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, LIMIT).map((f) => (
                    <tr key={`${f.kind}:${f.key}`}>
                      <td className={s.factCell}>
                        <span className={`${s.quietText} type-meta`}>
                          {kindLabel(f.kind, true)}
                        </span>
                        <b className={s.factKey}>{f.key}</b>
                        <span className={`${s.why} type-meta`}>
                          {who(f.by)}
                          {f.source === 'agent' ? ' published' : ''} · {stamp(f.at, tz)}
                          {f.version > 1 ? ` · version ${f.version}` : ''}
                        </span>
                      </td>
                      <td>
                        <FactValue v={f.value} />
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={2} className={s.quietText}>
                        No fact matches.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {shown.length > LIMIT && (
              <Quiet>
                Showing {LIMIT} of {shown.length}; search to narrow.
              </Quiet>
            )}
          </section>
        )}
      </div>
    </>
  );
}
