import type { PreviewPage, PreviewSnapshot } from '@lw/contracts';
import { blobUrl } from '../lib/api';
import { useApp, useProjectResource } from '../state';

const WIDTH = { desktop: '100%', tablet: '70%', phone: '46%' } as const;

/** A wireframe stand-in until a screenshot exists: the page's shape, not a fake of its look. */
function Wireframe({ width, built, note }: { width: string; built: boolean; note?: string }) {
  if (!built)
    return (
      <div className="fake fk missing" style={{ width, minHeight: 300 }}>
        {note ?? 'Not built yet.'}
      </div>
    );
  return (
    <div className="fake" style={{ width }}>
      <div className="fk row w40" />
      <div className="fk hero" />
      <div className="fk accent" />
      <div className="fk row w80" />
      <div className="fk row w60" />
      <div className="fk cards">
        <i />
        <i />
        <i />
      </div>
      <div className="fk row w80" />
      <div className="fk row w40" />
    </div>
  );
}

function Pane({
  title,
  page,
  side,
  bp,
  built,
  note,
}: {
  title: string;
  page: PreviewPage;
  side: 'source' | 'target';
  bp: keyof typeof WIDTH;
  built: boolean;
  note?: string;
}) {
  const { projectId } = useApp();
  const shot = page.shots[side][bp];
  return (
    <div className="pane">
      <h4>{title}</h4>
      {shot ? (
        <img
          src={blobUrl(projectId!, shot)}
          alt={`${page.name}, ${side === 'source' ? 'source' : 'SitecoreAI'} build, ${bp}`}
          style={{
            width: WIDTH[bp],
            display: 'block',
            margin: '0 auto',
            border: '1px solid var(--web-border)',
          }}
        />
      ) : (
        <Wireframe width={WIDTH[bp]} built={built} note={note} />
      )}
    </div>
  );
}

export function Preview() {
  const { ui, setUi, toast } = useApp();
  const p = useProjectResource<PreviewSnapshot>('/preview').data;
  if (!p) return <p className="quiet-line">Loading the preview…</p>;
  if (!p.pages.length)
    return (
      <>
        <div className="page-head">
          <div>
            <h1>Site preview</h1>
            <p>Pages appear here once the source is inventoried in discovery.</p>
          </div>
        </div>
      </>
    );
  const pg =
    p.pages.find((x) => x.path === ui.previewPage || x.pageKey === ui.previewPage) ?? p.pages[0]!;
  const bp = ui.breakpoint;
  const sections = p.pages.every((x) => x.path.startsWith('#'));
  const status = pg.migrated
    ? `${pg.name}: parity ${pg.parity ?? '–'}%, visual ${pg.visual ?? '–'}%${pg.pilot ? ', pilot slice' : ''}`
    : pg.template
      ? `${pg.name}: ${pg.template} template${pg.layout ? `, ${pg.layout} page design` : ''}`
      : `${pg.name}: not yet built`;
  const open = (url: string | null, what: string) =>
    url
      ? window.open(url, '_blank', 'noopener')
      : toast(`${what} opens once the page is built on the preview host.`);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Site preview</h1>
          <p>
            The {p.source?.label ?? 'source'} on the left, the{' '}
            {p.target?.label ?? 'SitecoreAI build'} on the right.
            {sections ? ' The home page is the only route, so the list shows its sections.' : ''}
          </p>
        </div>
      </div>
      <div className="preview">
        <nav className="pages" aria-label={sections ? 'Home page sections' : 'Pages'}>
          {p.pages.map((x) => (
            <button
              key={x.pageKey}
              aria-current={x.pageKey === pg.pageKey}
              onClick={() => setUi({ previewPage: x.path })}
            >
              <span>{x.name}</span>
              <span className="path">{x.path}</span>
              {(x.migrated || x.parity !== null) && (
                <span className={`sc ${x.migrated ? '' : 'muted'}`}>
                  {x.migrated ? `${x.parity}%` : '–'}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="panes">
          <div className="panes-head">
            <div className="seg">
              {(['desktop', 'tablet', 'phone'] as const).map((b) => (
                <button key={b} aria-pressed={bp === b} onClick={() => setUi({ breakpoint: b })}>
                  {b[0]!.toUpperCase() + b.slice(1)}
                </button>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 13 }}>
              {status}
            </span>
            <div className="btn-row" style={{ marginLeft: 'auto' }}>
              <button
                className="btn sm"
                disabled={!pg.migrated}
                onClick={() => open(pg.pageBuilderUrl, 'Page builder')}
              >
                Open in Page builder
              </button>
              <button
                className="btn sm"
                disabled={!pg.migrated}
                onClick={() => open(pg.previewUrl, 'The preview')}
              >
                Open on preview
              </button>
            </div>
          </div>
          <div className="pane-wrap">
            <Pane
              title={`Source: ${p.source?.label ?? 'source'}`}
              page={pg}
              side="source"
              bp={bp}
              built
            />
            <Pane
              title={`Target: ${p.target?.label ?? 'SitecoreAI'}`}
              page={pg}
              side="target"
              bp={bp}
              built={pg.migrated}
              note={
                p.target
                  ? 'Lands in a later batch.'
                  : 'Not built yet. Pages appear here from phase 4, after Gate 1.'
              }
            />
          </div>
        </div>
      </div>
    </>
  );
}
