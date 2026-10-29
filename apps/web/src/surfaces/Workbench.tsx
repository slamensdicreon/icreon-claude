import type {
  EscalationView,
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
import { useEffect, useRef, useState } from 'react';
import { API, blobUrl, get, post } from '../lib/api';
import { clock, shortDay, stamp } from '../lib/fmt';
import { Chip } from '../parts/bits';
import { DataDoc } from '../parts/DataDoc';
import { MarkdownDoc } from '../parts/Doc';
import { useApp, useMission, useProjectResource, useRoster, useTz } from '../state';

const DECISIONS = 'decisions';

/** Rail sections, in order: which artifact kinds each holds. */
const SECTIONS: { label: string; kinds: string[] | null }[] = [
  { label: 'Blueprint and plans', kinds: ['blueprint', 'platform_notes', 'charter', 'plan'] },
  { label: 'Inventories', kinds: ['inventory'] },
  { label: 'Reports', kinds: ['report'] },
  { label: 'Handover', kinds: ['handover_pack'] },
  { label: 'Decision Log', kinds: [] },
  { label: 'Pull requests', kinds: ['pull_request'] },
  { label: 'Other documents', kinds: null },
];

const updatedAt = (a: ArtifactView) =>
  a.versions.reduce((m, v) => (v.ts > m ? v.ts : m), a.versions[0]?.ts ?? '');

export function Workbench() {
  const { ui, setUi } = useApp();
  const tz = useTz();
  const wb = useProjectResource<WorkbenchSnapshot>('/workbench').data;
  const [query, setQuery] = useState('');
  const page = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<{ id: string; text: string; level: number }[]>([]);
  const docs = (wb?.artifacts ?? []).filter((a) => !['screenshot', 'video'].includes(a.kind));
  const ids = [...docs.map((a) => a.artifactId), DECISIONS];
  const current = ids.includes(ui.wbArtifact ?? '')
    ? ui.wbArtifact!
    : (docs[0]?.artifactId ?? DECISIONS);
  const artifact = docs.find((a) => a.artifactId === current);

  // "On this page": the open document's headings, linked.
  useEffect(() => {
    const el = page.current;
    if (!el) return;
    const read = () => {
      const hs = [...el.querySelectorAll<HTMLElement>('.wiki-doc h2, .wiki-doc h3')].filter(
        (h) => !h.closest('.viewer-head, .vh'),
      );
      setToc(
        hs.map((h, i) => {
          if (!h.id)
            h.id = `s-${i}-${(h.textContent ?? '')
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .slice(0, 40)}`;
          return { id: h.id, text: h.textContent ?? '', level: h.tagName === 'H3' ? 3 : 2 };
        }),
      );
    };
    read();
    const mo = new MutationObserver(read);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [current]);

  if (!wb) return <p className="quiet-line">Loading the Workbench…</p>;
  const q = query.trim().toLowerCase();
  const match = (title: string) => !q || title.toLowerCase().includes(q);
  const placed = new Set<string>();
  const sections = SECTIONS.map((sec) => {
    if (sec.label === 'Decision Log')
      return {
        label: sec.label,
        items: match('Decision Log')
          ? [{ id: DECISIONS, title: 'Decision Log', meta: 'append-only' }]
          : [],
      };
    const list = docs
      .filter((a) => (sec.kinds ? sec.kinds.includes(a.kind) : !placed.has(a.artifactId)))
      .sort((x, y) =>
        sec.label === 'Pull requests'
          ? updatedAt(y).localeCompare(updatedAt(x))
          : x.title.localeCompare(y.title, undefined, { numeric: true }),
      );
    for (const a of list) placed.add(a.artifactId);
    return {
      label: sec.label,
      items: list
        .filter((a) => match(a.title))
        .map((a) => ({
          id: a.artifactId,
          title: a.title,
          meta: `v${a.latest} · ${shortDay(updatedAt(a), tz)}`,
        })),
    };
  }).filter((sec) => sec.items.length);
  const recent = q
    ? []
    : [...docs].sort((x, y) => updatedAt(y).localeCompare(updatedAt(x))).slice(0, 5);
  const sectionOf = (id: string) =>
    sections.find((sec) => sec.items.some((i) => i.id === id))?.label;
  const open = (id: string) => setUi({ wbArtifact: id, bpFilter: 'all' });

  return (
    <div className={`wiki ${toc.length > 2 ? 'has-toc' : ''}`}>
      <aside className="wiki-rail" aria-label="Workbench pages">
        <input
          className="wiki-search"
          type="search"
          placeholder="Search pages"
          aria-label="Search pages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {recent.length > 0 && (
          <div className="wiki-sec">
            <h3>Recently updated</h3>
            <ul>
              {recent.map((a) => (
                <li key={a.artifactId}>
                  <button
                    aria-current={current === a.artifactId}
                    onClick={() => open(a.artifactId)}
                  >
                    <span>{a.title}</span>
                    <small>{shortDay(updatedAt(a), tz)}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {sections.map((sec) => (
          <details className="wiki-sec" key={sec.label} open>
            <summary>
              {sec.label} <small>{sec.items.length}</small>
            </summary>
            <ul>
              {sec.items.map((i) => (
                <li key={i.id}>
                  <button aria-current={current === i.id} onClick={() => open(i.id)}>
                    <span>{i.title}</span>
                    <small>{i.meta}</small>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
        {!sections.length && <p className="quiet-line">No page matches “{query}”.</p>}
      </aside>
      <select
        className="select wiki-pick"
        aria-label="Workbench page"
        value={current}
        onChange={(e) => open(e.target.value)}
      >
        {sections.map((sec) => (
          <optgroup key={sec.label} label={sec.label}>
            {sec.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <main className="wiki-main" ref={page}>
        <nav className="wiki-crumbs" aria-label="Breadcrumb">
          <span>Workbench</span>
          <span>{sectionOf(current) ?? ''}</span>
        </nav>
        <div className="viewer clean wiki-doc">
          {current === DECISIONS ? (
            <DecisionLog />
          ) : artifact?.kind === 'blueprint' ? (
            <BlueprintViewer />
          ) : artifact ? (
            <ArtifactViewer key={artifact.artifactId} a={artifact} />
          ) : null}
        </div>
      </main>
      {toc.length > 2 && (
        <aside className="wiki-toc" aria-label="On this page">
          <h3>On this page</h3>
          <ul>
            {toc.map((t) => (
              <li key={t.id} className={t.level === 3 ? 'sub' : ''}>
                <a
                  href={`#${t.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document
                      .getElementById(t.id)
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {t.text}
                </a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
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

const DECIDED_BY: Record<DecisionView['decidedBy'], string> = {
  director: 'Director',
  chief_of_staff: 'Cypher (convention)',
  default: 'Default action (Cypher)',
  lead: 'Lead (triage)',
  rule: 'Rule',
};

function DecisionLog() {
  const tz = useTz();
  const list = useProjectResource<DecisionView[]>('/decisions').data ?? [];
  const [who, setWho] = useState<'all' | DecisionView['decidedBy']>('all');
  const shown = [...list].reverse().filter((d) => who === 'all' || d.decidedBy === who);
  const present = (Object.keys(DECIDED_BY) as DecisionView['decidedBy'][]).filter((k) =>
    list.some((d) => d.decidedBy === k),
  );
  return (
    <>
      <div className="viewer-head">
        <h2>Decision Log</h2>
        <span className="muted">append-only</span>
      </div>
      {present.length > 1 && (
        <div className="dash-filters" role="group" aria-label="Decided by">
          {(['all', ...present] as const).map((k) => (
            <button
              key={k}
              className={`dash-chip ${who === k ? 'on' : ''}`}
              onClick={() => setWho(k)}
            >
              {k === 'all' ? 'Everyone' : DECIDED_BY[k]}
              <small>
                {k === 'all' ? list.length : list.filter((d) => d.decidedBy === k).length}
              </small>
            </button>
          ))}
        </div>
      )}
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
          {shown.map((d) => (
            <tr key={d.decisionId}>
              <td className="mono">{d.ref}</td>
              <td>{d.question}</td>
              <td>
                {d.answer}
                {(d.decidedBy === 'lead' || d.decidedBy === 'rule') && (
                  <>
                    <small className="muted dl-why">{d.rationale}</small>
                    {d.escalationId && <Override escalationId={d.escalationId} answer={d.answer} />}
                  </>
                )}
              </td>
              <td>{DECIDED_BY[d.decidedBy]}</td>
              <td className="muted">{stamp(d.ts, tz)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/**
 * Overrides a Lead's (or a rule's) answer: the task runs again with the Director's choice. What
 * the task already did with the Lead's answer stays in its history.
 */
function Override({ escalationId, answer }: { escalationId: string; answer: string }) {
  const { projectId, run } = useApp();
  const [card, setCard] = useState<EscalationView | null>(null);
  const [open, setOpen] = useState(false);
  const base = `/projects/${projectId}`;
  const load = async () => {
    setOpen((o) => !o);
    if (!card) setCard(await get<EscalationView>(`${base}/escalations/${escalationId}`));
  };
  const others = card?.options.filter((o) => o.label !== answer) ?? [];
  return (
    <span className="dl-override">
      <button className="link-btn" onClick={() => void load()} aria-expanded={open}>
        Override
      </button>
      {open && card?.sourceTaskId && (
        <span className="dl-options">
          {others.map((o) => (
            <button
              key={o.id}
              className="btn sm"
              onClick={() =>
                void run(() =>
                  post(`${base}/tasks/${card.sourceTaskId}/rerun`, {
                    instructions: `Decision on "${card.title}": ${o.label}. The Director overrode the Lead's answer (${answer}).`,
                    overriding: card.escalationId,
                  }),
                ).then(() => setOpen(false))
              }
            >
              Run again with: {o.label}
            </button>
          ))}
        </span>
      )}
    </span>
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
