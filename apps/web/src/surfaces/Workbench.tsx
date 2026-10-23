import type {
  ArtifactDocument,
  ArtifactView,
  BlueprintRow,
  BlueprintSnapshot,
  DecisionView,
  DocBlock,
  DocCell,
  MissionControlSnapshot,
  PullRequestDocument,
  WorkbenchSnapshot,
} from '@lw/contracts';
import { useEffect, useState } from 'react';
import { API, blobUrl } from '../lib/api';
import { clock, shortDay, stamp } from '../lib/fmt';
import { Chip } from '../parts/bits';
import { DataDoc } from '../parts/DataDoc';
import { MarkdownDoc } from '../parts/Doc';
import { useApp, useMission, useProjectResource, useRoster, useTz } from '../state';

const DECISIONS = 'decisions';

export function Workbench() {
  const { ui, setUi } = useApp();
  const wb = useProjectResource<WorkbenchSnapshot>('/workbench').data;
  if (!wb) return <p className="quiet-line">Loading the Workbench…</p>;
  // The Decision Log sits after the reports, before pull requests.
  const docs = wb.artifacts.filter((a) => !['screenshot', 'video'].includes(a.kind));
  const prs = docs
    .filter((a) => a.kind === 'pull_request')
    .sort((a, b) => b.versions[0]!.ts.localeCompare(a.versions[0]!.ts));
  const tabs: { id: string; short: string }[] = [
    ...docs
      .filter((a) => a.kind !== 'pull_request')
      .map((a) => ({ id: a.artifactId, short: a.shortTitle })),
    { id: DECISIONS, short: 'Decision Log' },
    ...prs.map((a) => ({ id: a.artifactId, short: a.shortTitle })),
  ];
  const current = tabs.some((t) => t.id === ui.wbArtifact) ? ui.wbArtifact! : tabs[0]!.id;
  const artifact = wb.artifacts.find((a) => a.artifactId === current);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Workbench</h1>
          <p>
            The artifacts the team produces and the evidence behind each claim. Everything Cypher
            cites links here.
          </p>
        </div>
      </div>
      <nav className="wtabs" aria-label="Artifacts">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`wtab ${current === t.id ? 'on' : ''}`}
            aria-current={current === t.id}
            onClick={() => setUi({ wbArtifact: t.id, bpFilter: 'all' })}
          >
            {t.short}
          </button>
        ))}
      </nav>
      <div className="viewer clean">
        {current === DECISIONS ? (
          <DecisionLog />
        ) : artifact?.kind === 'blueprint' ? (
          <BlueprintViewer />
        ) : artifact ? (
          <ArtifactViewer key={artifact.artifactId} a={artifact} />
        ) : null}
      </div>
    </>
  );
}

const STATUS_CLASS: Record<BlueprintRow['status'], string> = {
  done: 'done',
  in_progress: 'active',
  planned: 'idle',
  merged: 'rolledback',
  dropped: 'inactive',
};

function BlueprintViewer() {
  const { ui, setUi } = useApp();
  const tz = useTz();
  const mc = useMission().data as MissionControlSnapshot | undefined;
  const bp = useProjectResource<BlueprintSnapshot>('/blueprint');
  if (bp.error) return <p className="quiet-line">{bp.error.message}</p>;
  if (!bp.data) return <p className="quiet-line">Loading the Blueprint…</p>;
  const b = bp.data;
  const coll = b.collections[0]!;
  const rows = coll.rows;
  const label = (s: BlueprintRow['status']) =>
    s === 'done' ? coll.doneLabel : s === 'in_progress' ? 'in progress' : s;
  const cnt = (s: BlueprintRow['status']) => rows.filter((r) => r.status === s).length;
  const f = ui.bpFilter;
  const shown = rows.filter((r) =>
    f === 'all' ? true : f === 'changed' ? r.changed : r.status === f,
  );
  const repo = mc?.project.source.repo?.split('/').pop() ?? 'the source';
  const intro =
    b.approvedVersion === null
      ? `Version ${b.version}, waiting for your approval at Gate 1.`
      : b.approvedVersion === b.version
        ? `Version ${b.version}, approved at Gate 1${b.approvedAt ? ` on ${shortDay(b.approvedAt, tz)}` : ''}.`
        : `Version ${b.version}. Version ${b.approvedVersion} was approved at Gate 1${b.approvedAt ? ` on ${shortDay(b.approvedAt, tz)}` : ''}${b.updatedBy.length ? `; updated since by ${b.updatedBy.join(', ')}` : ''}.`;
  const kept = rows.filter((r) => r.status !== 'dropped' && r.status !== 'merged').length;
  return (
    <>
      <div className="vh">
        <div>
          <h2>Implementation Blueprint</h2>
          <p className="muted">
            {intro} Each row maps code in {repo} to what a marketer edits in SitecoreAI.
          </p>
        </div>
      </div>
      <div className="filters" style={{ marginBottom: 16 }}>
        {(
          [
            ['all', `All ${rows.length}`],
            [
              'done',
              `${coll.doneLabel[0]!.toUpperCase()}${coll.doneLabel.slice(1)} ${cnt('done')}`,
            ],
            ['in_progress', `In progress ${cnt('in_progress')}`],
            ['planned', `Planned ${cnt('planned')}`],
            ['changed', `Changed in v${b.version} ${rows.filter((r) => r.changed).length}`],
            ['dropped', `Dropped ${cnt('dropped')}`],
          ] as const
        )
          .filter(([k]) => k !== 'changed' || b.approvedVersion !== null)
          .map(([k, t]) => (
            <button key={k} aria-pressed={f === k} onClick={() => setUi({ bpFilter: k })}>
              {t}
            </button>
          ))}
      </div>
      <div className="bp-list">
        {shown.map((r) => (
          <details className={`bp ${r.changed ? 'chg' : ''}`} key={r.key}>
            <summary>
              <span className="bp-t">
                <b>{r.name}</b>
                <span className="mono">{r.source}</span>
              </span>
              <span className="bp-f">{r.fields}</span>
              <span className="bp-s">
                {r.changed && <span className="tagv2">Changed in v{b.version}</span>}
                <Chip state={STATUS_CLASS[r.status]} label={label(r.status)} />
              </span>
            </summary>
            <div className="bp-d">
              <div>
                <span>Parameters</span>
                {r.params}
              </div>
              <div>
                <span>Placeholders</span>
                <code>{r.placeholders}</code>
              </div>
              <div>
                <span>Variants</span>
                {r.variants}
              </div>
              {r.was && (
                <div className="wide">
                  <span>Version {b.approvedVersion ?? 1}</span>
                  {r.was}
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
      <p className="quiet-line" style={{ marginTop: 14 }}>
        {kept} mapped, {cnt('dropped')} dropped, {cnt('merged')} kept as library code. Click a row
        for parameters, placeholders and variants.
      </p>
    </>
  );
}

function DecisionLog() {
  const tz = useTz();
  const list = useProjectResource<DecisionView[]>('/decisions').data ?? [];
  const by = {
    director: 'Director',
    chief_of_staff: 'Cypher (convention)',
    default: 'Default action (Cypher)',
  };
  return (
    <>
      <div className="viewer-head">
        <h2>Decision Log</h2>
        <span className="muted">append-only</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Question</th>
            <th>Answer</th>
            <th>Decided by</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {[...list].reverse().map((d) => (
            <tr key={d.decisionId}>
              <td className="mono">{d.ref}</td>
              <td>{d.question}</td>
              <td>{d.answer}</td>
              <td>{by[d.decidedBy]}</td>
              <td className="muted">{stamp(d.ts, tz)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function ArtifactViewer({ a }: { a: ArtifactView }) {
  const { projectId } = useApp();
  const tz = useTz();
  const { byId } = useRoster();
  const [version, setVersion] = useState(a.latest);
  const [content, setContent] = useState<{ v: number; body: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = a.versions.find((x) => x.version === version) ?? a.versions[0]!;

  useEffect(() => {
    if (!v.ref) return;
    let stop = false;
    fetch(`${API}/projects/${projectId}/artifacts/${a.artifactId}/versions/${v.version}/content`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('This version has no stored content.');
        const body = v.format === 'json' ? await res.json() : await res.text();
        if (!stop) setContent({ v: v.version, body });
      })
      .catch((e: Error) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [projectId, a.artifactId, v.version, v.ref, v.format]);

  const producer = byId(v.producer);
  const versions =
    a.versions.length > 1 ? (
      <select
        className="select"
        value={version}
        onChange={(e) => setVersion(Number(e.target.value))}
        aria-label="Version"
      >
        {a.versions.map((x) => (
          <option key={x.version} value={x.version}>
            v{x.version}
            {a.approved.some((p) => p.version === x.version) ? ' (approved)' : ''}
            {x.version === a.latest ? ' (current)' : ''}
          </option>
        ))}
      </select>
    ) : null;

  if (!v.ref)
    return (
      <>
        <div className="viewer-head">
          <h2>{a.title}</h2>
          <span className="muted">
            v{v.version}, {producer?.name ?? v.producer}, {stamp(v.ts, tz)}
          </span>
        </div>
        <p className="quiet-line">This version was recorded without stored content.</p>
      </>
    );
  if (error) return <p className="quiet-line">{error}</p>;
  if (!content || content.v !== v.version) return <p className="quiet-line">Loading {a.title}…</p>;

  const body = content.body as { doc?: string };
  if (body && typeof body === 'object' && body.doc === 'lw.pull_request/1')
    return <PullRequest pr={body as PullRequestDocument} />;
  if (body && typeof body === 'object' && body.doc === 'lw.document/1') {
    const d = body as ArtifactDocument;
    return (
      <>
        <div className="viewer-head">
          <h2>{a.title}</h2>
          <span className="muted">
            {d.meta ?? `${producer?.name ?? v.producer}, ${stamp(v.ts, tz)}`}
          </span>
          {versions}
        </div>
        {d.intro && <p>{d.intro}</p>}
        {d.blocks.map((blk, i) => (
          <Block key={i} b={blk} projectId={projectId!} />
        ))}
      </>
    );
  }
  return (
    <>
      <div className="viewer-head">
        <h2>{a.title}</h2>
        <span className="muted">
          {producer?.name ?? v.producer}, {stamp(v.ts, tz)}
        </span>
        {versions}
      </div>
      {typeof content.body === 'string' ? (
        <MarkdownDoc text={content.body} projectId={projectId!} />
      ) : (
        <DataDoc value={content.body} />
      )}
    </>
  );
}

function Cell({ c }: { c: DocCell }) {
  if (typeof c === 'string') return <>{c}</>;
  if (c.chip)
    return (
      <>
        <Chip state={c.chip} label={c.text} />
        {c.sub && <span className="muted"> {c.sub}</span>}
      </>
    );
  const text = c.strong ? <b>{c.text}</b> : c.text;
  return <span className={`${c.mono ? 'mono' : ''} ${c.muted ? 'muted' : ''}`}>{text}</span>;
}

function Block({ b, projectId }: { b: DocBlock; projectId: string }) {
  switch (b.type) {
    case 'paragraph':
      return <p style={{ marginTop: 14 }}>{b.text}</p>;
    case 'heading':
      return (
        <h3
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            color: 'var(--web-fg-2)',
            fontWeight: 500,
            margin: '18px 0 6px',
          }}
        >
          {b.text}
        </h3>
      );
    case 'note':
      return (
        <p className="quiet-line" style={{ marginTop: 12 }}>
          {b.text}
        </p>
      );
    case 'list':
      return (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
          {b.items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <table>
          <thead>
            <tr>
              {b.columns.map((c) => (
                <th key={c.label} className={c.align === 'num' ? 'num' : ''}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={b.columns[j]?.align === 'num' ? 'num' : ''}>
                    <Cell c={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'scores':
      return (
        <div className="scores">
          {b.items.map((s) => (
            <div className="score" key={s.label}>
              <b className="tnum">{s.value}</b>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      );
    case 'images':
      return b.layout === 'compare' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {b.items.map((im, i) => (
            <div key={i}>
              <img
                src={blobUrl(projectId, im.ref)}
                alt={im.caption}
                style={{ width: '100%', display: 'block', border: '1px solid var(--web-border)' }}
              />
              <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                {im.caption}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3,1fr)',
            gap: 10,
            margin: '6px 0 16px',
          }}
        >
          {b.items.map((im, i) => (
            <img
              key={i}
              src={blobUrl(projectId, im.ref)}
              alt={im.caption}
              style={{
                width: '100%',
                height: 110,
                objectFit: 'cover',
                display: 'block',
                border: '1px solid var(--web-border)',
              }}
            />
          ))}
        </div>
      );
  }
}

function PullRequest({ pr }: { pr: PullRequestDocument }) {
  const tz = useTz();
  const { byId } = useRoster();
  const author = byId(pr.author)?.name ?? pr.author;
  const merger = pr.mergedBy ? (byId(pr.mergedBy)?.name ?? pr.mergedBy) : null;
  return (
    <>
      <div className="viewer-head">
        <h2>
          {pr.number} {pr.title}
        </h2>
        <Chip
          state={pr.state === 'open' ? 'active' : pr.state === 'merged' ? 'done' : 'inactive'}
          label={pr.state === 'open' ? 'Open' : pr.state === 'merged' ? 'Merged' : 'Closed'}
        />
      </div>
      <p className="muted">
        {pr.state === 'merged' && pr.mergedAt
          ? `Merged ${clock(pr.mergedAt, tz)} by ${merger} after review, ${pr.filesChanged} files changed.`
          : `${pr.head} into ${pr.base}, ${pr.filesChanged} files changed, opened ${clock(pr.openedAt, tz)} by ${author}`}
        {pr.summary ? ` ${pr.summary}` : ''}
      </p>
      {pr.files.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th className="num">+</th>
              <th className="num">−</th>
            </tr>
          </thead>
          <tbody>
            {pr.files.map((f) => (
              <tr key={f.path}>
                <td className="mono">{f.path}</td>
                <td className="num">{f.additions}</td>
                <td className="num">{f.deletions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {pr.url && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <a
            className="btn"
            style={{ borderBottom: '1px solid var(--web-border-strong)' }}
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in GitHub
          </a>
        </div>
      )}
    </>
  );
}
