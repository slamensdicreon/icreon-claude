import { useState, type ReactNode } from 'react';
import ds from './doc.module.css';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (v: Json | undefined): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const str = (v: Json | undefined) => (typeof v === 'string' ? v : '');
const num = (v: Json | undefined) => (typeof v === 'number' ? v : 0);
const fmt = (n: number) => n.toLocaleString('en-US');

/**
 * Documents agents write as JSON, shown for people: the page and repository inventories get
 * purpose-built views, anything else a readable outline with tables. The raw JSON stays one click
 * away.
 */
export function DataDoc({ value }: { value: unknown }) {
  const v = value as Json;
  const [raw, setRaw] = useState(false);
  const view =
    isObj(v) && Array.isArray(v.pages) ? (
      <PageInventory d={v} />
    ) : isObj(v) && Array.isArray(v.components) && (v.repository || v.routes) ? (
      <RepoInventory d={v} />
    ) : (
      <Outline v={v} depth={0} />
    );
  return (
    <div className={ds.doc}>
      {raw ? (
        <pre className={`${ds.pre} ${ds.rawPre}`}>{JSON.stringify(value, null, 2)}</pre>
      ) : (
        view
      )}
      <button type="button" className={ds.toggle} onClick={() => setRaw((r) => !r)}>
        {raw ? 'Show the formatted view' : 'Show raw JSON'}
      </button>
    </div>
  );
}

function Stats({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className={ds.stats}>
      {items.map(([label, value]) => (
        <div key={label} className={ds.stat}>
          <b>{value}</b>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

function Tags({ items }: { items: string[] }) {
  return (
    <span className={ds.tags}>
      {items.map((t, i) => (
        <span key={`${t}-${i}`} className={ds.tag}>
          {t}
        </span>
      ))}
    </span>
  );
}

function Notes({ items, kind = 'note' }: { items: string[]; kind?: 'note' | 'warning' }) {
  if (!items.length) return null;
  return (
    <blockquote className={ds.callout} data-kind={kind}>
      <p className={ds.calloutTitle}>{kind === 'warning' ? 'Warning' : 'Notes'}</p>
      <ul>
        {items.map((n, i) => (
          <li key={i}>{n}</li>
        ))}
      </ul>
    </blockquote>
  );
}

function PageInventory({ d }: { d: Obj }) {
  const origin = str(d.origin).replace(/\/$/, '');
  const pages = arr(d.pages).filter(isObj);
  const templates = new Map<string, number>();
  for (const p of pages)
    templates.set(
      str(p.template) || 'ungrouped',
      (templates.get(str(p.template) || 'ungrouped') ?? 0) + 1,
    );
  const words = pages.reduce((n, p) => n + num(p.words), 0);
  const missingAlt = pages.reduce((n, p) => n + num(p.imagesMissingAlt), 0);
  const excluded = arr(d.excluded).filter(isObj);
  const regions = arr(d.repeatedRegions).filter(isObj);
  return (
    <div className={ds.body}>
      <p className={ds.lede}>
        {fmt(pages.length)} pages crawled from{' '}
        {origin ? (
          <a href={origin} target="_blank" rel="noopener noreferrer">
            {origin.replace(/^https?:\/\//, '')}
          </a>
        ) : (
          'the source site'
        )}
        , in {templates.size} layout group{templates.size === 1 ? '' : 's'}.
      </p>
      <Stats
        items={[
          ['Pages', fmt(pages.length)],
          ['Layout groups', fmt(templates.size)],
          ['Words', fmt(words)],
          ['Images missing alt text', fmt(missingAlt)],
        ]}
      />
      <Notes items={arr(d.notes).map(String)} />
      <h2>Layout groups</h2>
      <div className={ds.table}>
        <table>
          <thead>
            <tr>
              <th>Group</th>
              <th className={ds.num}>Pages</th>
            </tr>
          </thead>
          <tbody>
            {[...templates]
              .sort((a, b) => b[1] - a[1])
              .map(([t, n]) => (
                <tr key={t}>
                  <td>{t}</td>
                  <td className={ds.num}>{n}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <h2>Pages</h2>
      <div className={ds.table}>
        <table>
          <thead>
            <tr>
              <th>Page</th>
              <th>Group</th>
              <th>Content blocks</th>
              <th className={ds.num}>Words</th>
              <th className={ds.num}>Images</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p) => {
              const path = str(p.path) || str(p.url);
              return (
                <tr key={path}>
                  <td>
                    <b>{str(p.title) || str(p.h1) || path}</b>
                    <div className={`${ds.quiet} ${ds.small}`}>
                      {origin ? (
                        <a href={`${origin}${path}`} target="_blank" rel="noopener noreferrer">
                          {path}
                        </a>
                      ) : (
                        path
                      )}
                    </div>
                  </td>
                  <td>{str(p.template)}</td>
                  <td>
                    <Tags items={arr(p.blocks).map(String)} />
                  </td>
                  <td className={ds.num}>{fmt(num(p.words))}</td>
                  <td className={ds.num}>
                    {fmt(num(p.images))}
                    {num(p.imagesMissingAlt) > 0 && (
                      <div className={ds.miss}>{num(p.imagesMissingAlt)} without alt</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {regions.length > 0 && (
        <>
          <h2>Repeated regions</h2>
          <p>
            {regions.map((r, i) => (
              <span key={i}>
                {i > 0 && ', '}
                <b>{str(r.region)}</b> on {num(r.pages)} pages
              </span>
            ))}
            .
          </p>
        </>
      )}
      {excluded.length > 0 && (
        <>
          <h2>Not crawled</h2>
          <ul>
            {excluded.map((x, i) => (
              <li key={i}>
                <span>{str(x.url)}</span> <span className={ds.quiet}>({str(x.reason)})</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

const SEVERITY: Record<string, 'warning' | 'note'> = { high: 'warning', medium: 'warning' };

function RepoInventory({ d }: { d: Obj }) {
  const components = arr(d.components).filter(isObj);
  const routes = arr(d.routes).filter(isObj);
  const deps = arr(d.dependencies).filter(isObj);
  const risks = arr(d.risks).filter(isObj);
  const assets = arr(d.assets).filter(isObj);
  const repo = str(d.repository);
  return (
    <div className={ds.body}>
      <p className={ds.lede}>
        {repo ? (
          <a href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer">
            {repo}
          </a>
        ) : (
          'The repository'
        )}
        {str(d.framework) && <>, {str(d.framework)}</>}.
      </p>
      <Stats
        items={[
          ['Components', fmt(components.length)],
          ['Routes', fmt(routes.length)],
          ['Dependencies', fmt(deps.length)],
          ['Risks', fmt(risks.length)],
          ...(num(d.sizeKb)
            ? ([['Size', `${fmt(Math.round(num(d.sizeKb) / 1024))} MB`]] as [string, ReactNode][])
            : []),
        ]}
      />
      {risks.length > 0 && <h2>Risks</h2>}
      {risks.map((r, i) => (
        <blockquote key={i} className={ds.callout} data-kind={SEVERITY[str(r.severity)] ?? 'note'}>
          <p className={ds.calloutTitle}>
            {str(r.severity)
              ? `${str(r.severity)[0]!.toUpperCase()}${str(r.severity).slice(1)} risk`
              : 'Risk'}
            {str(r.file) && <span> · {str(r.file)}</span>}
          </p>
          <p>{str(r.issue)}</p>
          {str(r.recommendation) && <p className={ds.quiet}>{str(r.recommendation)}</p>}
        </blockquote>
      ))}
      <h2>Components</h2>
      <div className={ds.table}>
        <table>
          <thead>
            <tr>
              <th>Component</th>
              <th>Props</th>
              <th>Used on</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {components.map((c, i) => (
              <tr key={`${str(c.name)}-${i}`}>
                <td>
                  <b>{str(c.name)}</b>
                  <div className={`${ds.quiet} ${ds.small}`}>{str(c.file)}</div>
                </td>
                <td>
                  <Tags items={arr(c.props).map(String)} />
                </td>
                <td>{arr(c.usedOn).map(String).join(', ')}</td>
                <td>
                  {str(c.notes)}
                  {str(c.dataFetching) && str(c.dataFetching) !== 'none' && (
                    <div className={ds.quiet}>Data: {str(c.dataFetching)}</div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {routes.length > 0 && (
        <>
          <h2>Routes</h2>
          <Outline v={routes} depth={1} />
        </>
      )}
      {deps.length > 0 && (
        <>
          <h2>Dependencies</h2>
          <Outline v={deps} depth={1} />
        </>
      )}
      {assets.length > 0 && (
        <>
          <h2>Assets</h2>
          <p className={ds.quiet}>{fmt(assets.length)} files.</p>
          <Outline v={assets.slice(0, 200)} depth={1} />
        </>
      )}
    </div>
  );
}

const label = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

function Cell({ v }: { v: Json | undefined }) {
  if (v === null || v === undefined) return <span className={ds.quiet}>–</span>;
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object'))
    return <Tags items={v.map(String)} />;
  if (typeof v === 'object')
    return <span className={`${ds.quiet} ${ds.small}`}>{JSON.stringify(v).slice(0, 120)}</span>;
  if (typeof v === 'string' && /^https?:\/\//.test(v))
    return (
      <a href={v} target="_blank" rel="noopener noreferrer">
        {v.replace(/^https?:\/\//, '')}
      </a>
    );
  return <>{typeof v === 'number' ? fmt(v) : String(v)}</>;
}

/** Any JSON as an outline: objects as labelled sections, arrays of records as tables. */
function Outline({ v, depth }: { v: Json; depth: number }): ReactNode {
  if (Array.isArray(v)) {
    const records = v.filter(isObj);
    if (records.length && records.length === v.length) {
      const keys = [...new Set(records.flatMap((r) => Object.keys(r)))].slice(0, 8);
      return (
        <div className={ds.table}>
          <table>
            <thead>
              <tr>
                {keys.map((k) => (
                  <th key={k}>{label(k)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r, i) => (
                <tr key={i}>
                  {keys.map((k) => (
                    <td key={k}>
                      <Cell v={r[k]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return (
      <ul>
        {v.map((x, i) => (
          <li key={i}>
            {typeof x === 'object' && x ? <Outline v={x} depth={depth + 1} /> : <Cell v={x} />}
          </li>
        ))}
      </ul>
    );
  }
  if (isObj(v)) {
    const H = depth === 0 ? 'h2' : 'h3';
    return (
      <div className={ds.body}>
        {Object.entries(v).map(([k, x]) =>
          x !== null && typeof x === 'object' ? (
            <section key={k}>
              <H>{label(k)}</H>
              <Outline v={x} depth={depth + 1} />
            </section>
          ) : (
            <p key={k}>
              <b>{label(k)}:</b> <Cell v={x} />
            </p>
          ),
        )}
      </div>
    );
  }
  return <Cell v={v} />;
}
