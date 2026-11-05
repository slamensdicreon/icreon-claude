/*
 * One document, at the version picked: a pull request (`lw.pull_request/1`), a structured document
 * (`lw.document/1`: paragraphs, headings, notes, lists, tables, score tiles, images), agent-written
 * Markdown (diagrams and artifact:// links included) or any other JSON.
 */
import type {
  ArtifactDocument,
  ArtifactView,
  DocBlock,
  DocCell,
  PullRequestDocument,
} from '@lw/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { blobUrl, get, messageOf } from '../../lib/api';
import { clock, stamp } from '../../lib/fmt';
import { DataDoc } from '../../parts/DataDoc';
import { MarkdownDoc } from '../../parts/Doc';
import { useApp, useRoster, useTz } from '../../state';
import { Select } from '../../ui/cypher/forms';
import { DocHead, Quiet, StateWord, Tag, toneOfState } from './parts';
import s from './doc.module.css';

/** What a version's content is, once fetched: keyed, so another version never shows its body. */
type Loaded = { key: string; body: unknown } | { key: string; error: string };

const isDoc = (body: unknown, doc: string): boolean =>
  !!body && typeof body === 'object' && (body as { doc?: unknown }).doc === doc;

export function ArtifactViewer({ a }: { a: ArtifactView }) {
  const { projectId } = useApp();
  const tz = useTz();
  const { byId } = useRoster();
  const [version, setVersion] = useState(a.latest);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const v = a.versions.find((x) => x.version === version) ?? a.versions[0]!;
  const key = `${a.artifactId}:${v.version}`;

  useEffect(() => {
    if (!v.ref || !projectId) return;
    let stop = false;
    const k = `${a.artifactId}:${v.version}`;
    get<unknown>(`/projects/${projectId}/artifacts/${a.artifactId}/versions/${v.version}/content`)
      .then((body) => !stop && setLoaded({ key: k, body }))
      .catch(
        (err: unknown) =>
          !stop &&
          setLoaded({ key: k, error: messageOf(err, 'This version has no stored content.') }),
      );
    return () => {
      stop = true;
    };
  }, [projectId, a.artifactId, v.version, v.ref]);

  const producer = byId(v.producer)?.name ?? v.producer;
  const approvedAt = a.approved.find((p) => p.version === v.version);
  const tags = (
    <>
      {a.versions.length > 1 && v.version !== a.latest && (
        <Tag tag={{ label: `Older version, v${a.latest} is current`, tone: 'quiet' }} />
      )}
      {approvedAt && <Tag tag={{ label: `Approved at ${approvedAt.gate}`, tone: 'done' }} />}
    </>
  );
  const versions =
    a.versions.length > 1 ? (
      <Select
        value={version}
        onChange={(e) => setVersion(Number(e.target.value))}
        aria-label="Version"
      >
        {a.versions.map((x) => (
          <option key={x.version} value={x.version}>
            Version {x.version}
            {a.approved.some((p) => p.version === x.version) ? ', approved' : ''}
            {x.version === a.latest ? ', current' : ''}
          </option>
        ))}
      </Select>
    ) : null;
  const head = (meta: string, title: ReactNode = a.title, extra?: ReactNode) => (
    <DocHead
      title={title}
      meta={meta}
      tags={
        <>
          {extra}
          {tags}
        </>
      }
      actions={versions}
    />
  );
  const byline = `v${v.version} · ${producer} · ${stamp(v.ts, tz)}`;

  if (!v.ref)
    return (
      <>
        {head(byline)}
        <div className={s.body}>
          <Quiet>This version was recorded without stored content.</Quiet>
        </div>
      </>
    );
  const current = loaded?.key === key ? loaded : null;
  if (!current)
    return (
      <>
        {head(byline)}
        <div className={s.body}>
          <Quiet>Loading {a.title}…</Quiet>
        </div>
      </>
    );
  if ('error' in current)
    return (
      <>
        {head(byline)}
        <div className={s.body}>
          <Quiet>{current.error}</Quiet>
        </div>
      </>
    );

  const body = current.body;
  if (isDoc(body, 'lw.pull_request/1')) {
    const pr = body as PullRequestDocument;
    return (
      <>
        {head(
          byline,
          <>
            <span className={s.prNumber}>#{pr.number}</span> {pr.title}
          </>,
          <PrState state={pr.state} />,
        )}
        <div className={s.body}>
          <PullRequest pr={pr} />
        </div>
      </>
    );
  }
  if (isDoc(body, 'lw.document/1')) {
    const d = body as ArtifactDocument;
    return (
      <>
        {head(d.meta ? `v${v.version} · ${d.meta}` : byline)}
        <div className={`${s.body} ${s.blocks}`}>
          {d.intro && <p className={`${s.intro} type-body`}>{d.intro}</p>}
          {d.blocks.map((blk, i) => (
            <Block key={i} b={blk} projectId={projectId!} />
          ))}
        </div>
      </>
    );
  }
  return (
    <>
      {head(byline)}
      <div className={`${s.body} ${s.host}`}>
        {typeof body === 'string' ? (
          <MarkdownDoc text={body} projectId={projectId!} />
        ) : (
          <DataDoc value={body} />
        )}
      </div>
    </>
  );
}

function Cell({ c }: { c: DocCell }) {
  if (typeof c === 'string') return <>{c}</>;
  if (c.chip)
    return (
      <span className={s.cellChip}>
        <StateWord tone={toneOfState(c.chip)}>{c.text}</StateWord>
        {c.sub && <span className={s.quietText}>{c.sub}</span>}
      </span>
    );
  return (
    <span
      className={s.cell}
      data-strong={c.strong || undefined}
      data-muted={c.muted || undefined}
      data-code={c.mono || undefined}
    >
      {c.text}
    </span>
  );
}

/** One block of a structured document. */
function Block({ b, projectId }: { b: DocBlock; projectId: string }) {
  switch (b.type) {
    case 'paragraph':
      return <p className={`${s.para} type-body-small`}>{b.text}</p>;
    case 'heading':
      return <h3 className={`${s.blockHeading} type-label`}>{b.text}</h3>;
    case 'note':
      return <p className={`${s.note} type-body-small`}>{b.text}</p>;
    case 'list':
      return (
        <ul className={`${s.list} type-body-small`}>
          {b.items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                {b.columns.map((c, i) => (
                  <th key={`${i}-${c.label}`} data-num={c.align === 'num' || undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} data-num={b.columns[j]?.align === 'num' || undefined}>
                      <Cell c={c} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'scores':
      return (
        <div className={s.scores}>
          {b.items.map((x) => (
            <div className={s.score} key={x.label}>
              <span className="type-number">{x.value}</span>
              <span className={`${s.quietText} type-meta`}>{x.label}</span>
            </div>
          ))}
        </div>
      );
    case 'images':
      return (
        <div className={s.images} data-layout={b.layout}>
          {b.items.map((im, i) => (
            <figure key={i} className={s.figure}>
              <img src={blobUrl(projectId, im.ref)} alt={im.caption} loading="lazy" />
              {im.caption && (
                <figcaption className={`${s.quietText} type-meta`}>{im.caption}</figcaption>
              )}
            </figure>
          ))}
        </div>
      );
  }
}

function PrState({ state }: { state: PullRequestDocument['state'] }) {
  return state === 'merged' ? (
    <Tag tag={{ label: 'Merged', tone: 'done' }} />
  ) : state === 'open' ? (
    <Tag tag={{ label: 'Open', tone: 'moved' }} />
  ) : (
    <Tag tag={{ label: 'Closed', tone: 'quiet' }} />
  );
}

function PullRequest({ pr }: { pr: PullRequestDocument }) {
  const tz = useTz();
  const { byId } = useRoster();
  const author = byId(pr.author)?.name ?? pr.author;
  const merger = pr.mergedBy ? (byId(pr.mergedBy)?.name ?? pr.mergedBy) : null;
  const added = pr.files.reduce((n, f) => n + f.additions, 0);
  const removed = pr.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <div className={s.blocks}>
      <dl className={s.facts}>
        <div>
          <dt className="type-meta">Branch</dt>
          <dd className="type-table">
            {pr.head} into {pr.base}
          </dd>
        </div>
        <div>
          <dt className="type-meta">Opened</dt>
          <dd className="type-table">
            {author}, {clock(pr.openedAt, tz)}
          </dd>
        </div>
        {pr.state === 'merged' && pr.mergedAt && (
          <div>
            <dt className="type-meta">Merged</dt>
            <dd className="type-table">
              {merger ?? 'Unknown'}, {clock(pr.mergedAt, tz)}
            </dd>
          </div>
        )}
        <div>
          <dt className="type-meta">Files changed</dt>
          <dd className="type-table">
            {pr.filesChanged}
            {pr.files.length > 0 && (
              <span className={s.quietText}>
                {' '}
                · +{added} −{removed}
              </span>
            )}
          </dd>
        </div>
      </dl>
      {pr.summary && <p className={`${s.para} type-body-small`}>{pr.summary}</p>}
      {pr.files.length > 0 && (
        <div className={s.tableWrap}>
          <table className={`${s.table} type-table`}>
            <thead>
              <tr>
                <th>File</th>
                <th data-num="">Added</th>
                <th data-num="">Removed</th>
              </tr>
            </thead>
            <tbody>
              {pr.files.map((f) => (
                <tr key={f.path}>
                  <td className={s.path}>{f.path}</td>
                  <td data-num="">+{f.additions}</td>
                  <td data-num="" className={s.quietText}>
                    −{f.deletions}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pr.url && (
        <p>
          <a className={s.button} href={pr.url} target="_blank" rel="noopener noreferrer">
            Open in GitHub
          </a>
        </p>
      )}
    </div>
  );
}
