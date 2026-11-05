import type { PreviewPage as Page, PreviewSnapshot } from '@lw/contracts';
import { blobUrl } from '../../lib/api';
import { Mode } from '../../mode/Mode';
import { useApp, useProjectResource, usePlatformName } from '../../state';
import { Icon } from '../../theme/icons';
import { Button, Chips, Panel } from '../../ui/cypher/parts';
import s from './preview.module.css';

type Bp = 'desktop' | 'tablet' | 'phone';

/** Parity as a word (Bliss shows a word, not a number). */
const parityWord = (p: Page) =>
  !p.migrated || p.parity === null
    ? 'Not built yet'
    : p.parity >= 95
      ? 'Matches'
      : p.parity >= 85
        ? 'Close'
        : 'Differs';

/** Site preview, in both faces: one page in Bliss; every page, three breakpoints, in Everything. */
export function SitePreview() {
  const snap = useProjectResource<PreviewSnapshot>('/preview').data;
  if (!snap) return <p className="type-body">Reading the preview…</p>;
  if (!snap.pages.length)
    return (
      <p className={`${s.empty} type-body`}>
        No pages yet. They appear here as the Blueprint names them.
      </p>
    );
  return (
    <Mode bliss={<PreviewBliss snap={snap} />} everything={<PreviewEverything snap={snap} />} />
  );
}

function usePage(snap: PreviewSnapshot) {
  const { ui, setUi } = useApp();
  const i = Math.max(
    0,
    snap.pages.findIndex((p) => p.pageKey === ui.previewPage),
  );
  const page = snap.pages[i] ?? snap.pages[0]!;
  const go = (d: number) =>
    setUi({ previewPage: snap.pages[(i + d + snap.pages.length) % snap.pages.length]!.pageKey });
  return { page, i, go, set: (k: string) => setUi({ previewPage: k }) };
}

function Shot({
  page,
  side,
  bp,
  label,
}: {
  page: Page;
  side: 'source' | 'target';
  bp: Bp;
  label: string;
}) {
  const { projectId } = useApp();
  const ref = page.shots[side][bp];
  return (
    <figure className={s.pane}>
      <figcaption className={`${s.paneLabel} type-label`}>{label}</figcaption>
      <div className={s.frame} data-bp={bp}>
        {ref ? (
          <img
            src={blobUrl(projectId!, ref)}
            alt={`${page.name}, ${side === 'source' ? 'the source' : 'the new build'}, ${bp}`}
          />
        ) : (
          <span className={`${s.missing} type-body-small`}>
            {side === 'target' && !page.migrated ? 'Not built yet.' : 'No screenshot yet.'}
          </span>
        )}
      </div>
    </figure>
  );
}

function PreviewBliss({ snap }: { snap: PreviewSnapshot }) {
  const { page, i, go } = usePage(snap);
  const platform = usePlatformName('New build');
  const word = parityWord(page);
  return (
    <div className={s.bliss}>
      <header className={s.blissHead}>
        <span className={s.pageName}>
          <span className="type-heading">{page.name}</span>
          <span className="type-meta">{page.path}</span>
        </span>
        <span
          className={`${s.word} type-card-title`}
          data-tone={word === 'Matches' ? 'done' : word === 'Differs' ? 'yours' : 'quiet'}
        >
          {word}
        </span>
        <span className={s.stepper}>
          <span className="type-meta">
            {i + 1} of {snap.pages.length}
          </span>
          <button
            type="button"
            className={s.round}
            aria-label="Previous page"
            onClick={() => go(-1)}
          >
            <Icon name="chevron" size={18} />
          </button>
          <button type="button" className={s.round} aria-label="Next page" onClick={() => go(1)}>
            <Icon name="chevron" size={18} />
          </button>
        </span>
      </header>
      <div className={s.panes}>
        <Shot page={page} side="source" bp="desktop" label={snap.source?.label ?? 'The source'} />
        <Shot page={page} side="target" bp="desktop" label={snap.target?.label ?? platform} />
      </div>
    </div>
  );
}

function PreviewEverything({ snap }: { snap: PreviewSnapshot }) {
  const { ui, setUi, toast } = useApp();
  const { page, set } = usePage(snap);
  const platform = usePlatformName('New build');
  const bp = ui.breakpoint as Bp;
  const open = (url: string | null, what: string) =>
    url
      ? window.open(url, '_blank', 'noopener')
      : toast(`${what} opens once the page is built on the preview host.`);
  return (
    <div className={s.everything}>
      <Panel
        title="Pages"
        meta={`${snap.pages.filter((p) => p.migrated).length} of ${snap.pages.length} built`}
      >
        <ul className={s.list}>
          {snap.pages.map((p) => (
            <li key={p.pageKey}>
              <button
                type="button"
                className={s.listRow}
                aria-current={p.pageKey === page.pageKey || undefined}
                onClick={() => set(p.pageKey)}
              >
                <span className={s.listText}>
                  <b>{p.name}</b>
                  <span className="type-meta">
                    {p.path}
                    {p.pilot ? ' · pilot' : ''}
                  </span>
                </span>
                <b
                  className={s.parity}
                  data-tone={
                    !p.migrated
                      ? 'quiet'
                      : (p.parity ?? 0) >= 95
                        ? 'done'
                        : (p.parity ?? 0) >= 85
                          ? 'normal'
                          : 'yours'
                  }
                >
                  {p.migrated && p.parity !== null ? `${p.parity}%` : '—'}
                </b>
              </button>
            </li>
          ))}
        </ul>
      </Panel>
      <div className={s.detail}>
        <div className={s.tools}>
          <span className={s.pageName}>
            <span className="type-section">{page.name}</span>
            <span className="type-meta">
              {page.migrated
                ? `Parity ${page.parity ?? '—'}% · visual ${page.visual ?? '—'}%${page.pilot ? ' · pilot slice' : ''}`
                : 'Not built yet'}
            </span>
          </span>
          <Chips<Bp>
            label="Breakpoint"
            value={bp}
            onChange={(v) => setUi({ breakpoint: v })}
            options={[
              { value: 'desktop', label: 'Desktop' },
              { value: 'tablet', label: 'Tablet' },
              { value: 'phone', label: 'Phone' },
            ]}
          />
          <Button kind="secondary" onClick={() => open(page.pageBuilderUrl, 'Page builder')}>
            Open in Page builder
          </Button>
          <Button kind="secondary" onClick={() => open(page.previewUrl, 'The preview')}>
            Open on preview
          </Button>
        </div>
        <div className={s.panes}>
          <Shot page={page} side="source" bp={bp} label={snap.source?.label ?? 'The source'} />
          <Shot page={page} side="target" bp={bp} label={snap.target?.label ?? platform} />
        </div>
      </div>
    </div>
  );
}
