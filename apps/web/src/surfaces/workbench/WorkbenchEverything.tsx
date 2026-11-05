/*
 * Workbench, Everything face (design system §10): the document rail with status tags, the open
 * document, and "On this page". The rail searches every page, lists what changed most recently and
 * folds its sections by kind; on a phone a select stands in for it. The page open is `ui.wbArtifact`,
 * so links from anywhere else (the palette, a card, an artifact:// link) open it here.
 */
import type { WorkbenchSnapshot } from '@lw/contracts';
import { useState } from 'react';
import { shortDay } from '../../lib/fmt';
import { useApp, useProjectResource, useTz } from '../../state';
import { Icon } from '../../theme/icons';
import { Select } from '../../ui/cypher/forms';
import { LessonsLearned } from '../manage/LessonsLearned';
import { ArtifactViewer } from './ArtifactViewer';
import { Blueprint } from './Blueprint';
import { DecisionLog } from './DecisionLog';
import { DECISIONS, FACTS, LESSONS, isDocument, sectionsOf, updatedAt, type Page } from './model';
import { DocHead, Quiet, Tag, arrowNav } from './parts';
import { ProjectFacts } from './ProjectFacts';
import { Toc, useHeadings } from './toc';
import d from './doc.module.css';
import s from './workbench.module.css';

export function WorkbenchEverything() {
  const { ui, setUi, projectId } = useApp();
  const tz = useTz();
  const wb = useProjectResource<WorkbenchSnapshot>('/workbench');
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [docEl, setDocEl] = useState<HTMLElement | null>(null);

  const docs = (wb.data?.artifacts ?? []).filter(isDocument);
  const ids = [...docs.map((a) => a.artifactId), DECISIONS, FACTS, LESSONS];
  const current = ids.includes(ui.wbArtifact ?? '')
    ? ui.wbArtifact!
    : (docs[0]?.artifactId ?? DECISIONS);
  const artifact = docs.find((a) => a.artifactId === current);
  const toc = useHeadings(docEl, current);

  if (!wb.data) return <Quiet>{wb.error ? wb.error.message : 'Loading the Workbench…'}</Quiet>;

  const searching = query.trim() !== '';
  const sections = sectionsOf(docs, query, (a) => `v${a.latest} · ${shortDay(updatedAt(a), tz)}`);
  const recent = searching
    ? []
    : [...docs].sort((x, y) => updatedAt(y).localeCompare(updatedAt(x))).slice(0, 5);
  const all = sectionsOf(docs, '', (a) => `v${a.latest}`);
  const section = all.find((sec) => sec.items.some((i) => i.id === current));
  const page = section?.items.find((i) => i.id === current);
  const open = (id: string) => setUi({ wbArtifact: id, bpFilter: 'all' });
  const fold = (label: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  const withToc = toc.items.length > 2;

  return (
    <div className={s.wb} data-toc={withToc || undefined}>
      <aside className={s.rail} aria-label="Workbench pages" onKeyDown={arrowNav}>
        <label className={s.search}>
          <Icon name="search" size={18} />
          <input
            className="type-body-small"
            type="search"
            placeholder="Search pages"
            aria-label="Search pages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        {recent.length > 0 && (
          <section className={s.sec} aria-labelledby="wb-recent">
            <h3 id="wb-recent" className={`${s.secLabel} type-label`}>
              Recently updated
            </h3>
            <ul className={s.items}>
              {recent.map((a) => (
                <li key={a.artifactId}>
                  <RailItem
                    page={{ id: a.artifactId, title: a.title, meta: shortDay(updatedAt(a), tz) }}
                    current={current === a.artifactId}
                    onOpen={open}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {sections.map((sec) => {
          const shut = folded.has(sec.label) && !searching;
          const id = `wb-sec-${sec.label.replace(/\W+/g, '-').toLowerCase()}`;
          return (
            <section key={sec.label} className={s.sec}>
              <button
                type="button"
                className={s.secHead}
                aria-expanded={!shut}
                aria-controls={id}
                onClick={() => fold(sec.label)}
                data-nav=""
              >
                <Icon name="chevron" size={16} className={s.secChev} />
                <span className="type-label">{sec.label}</span>
                <span className={`${s.secCount} type-meta`}>{sec.items.length}</span>
              </button>
              {!shut && (
                <ul id={id} className={s.items}>
                  {sec.items.map((i) => (
                    <li key={i.id}>
                      <RailItem page={i} current={current === i.id} onOpen={open} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {!sections.length && (
          <p className={`${s.none} type-body-small`}>No page matches “{query}”.</p>
        )}
      </aside>

      <div className={s.pick}>
        <Select aria-label="Workbench page" value={current} onChange={(e) => open(e.target.value)}>
          {all.map((sec) => (
            <optgroup key={sec.label} label={sec.label}>
              {sec.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.title}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </div>

      <div className={s.main}>
        <nav aria-label="Breadcrumb">
          <ol className={`${s.crumbs} type-meta`}>
            <li>Workbench</li>
            {section && section.label !== page?.title && <li>{section.label}</li>}
            {page && <li aria-current="page">{page.title}</li>}
          </ol>
        </nav>
        <article className={d.doc} ref={setDocEl} aria-label={page?.title ?? 'Document'}>
          {current === DECISIONS ? (
            <DecisionLog />
          ) : current === FACTS ? (
            <ProjectFacts />
          ) : current === LESSONS && projectId ? (
            <>
              <DocHead title="Lessons learned" meta="Retrospectives" />
              <div className={`${d.body} ${d.host} ${d.lessons}`}>
                <LessonsLearned projectId={projectId} />
              </div>
            </>
          ) : artifact?.kind === 'blueprint' ? (
            <Blueprint />
          ) : artifact ? (
            <ArtifactViewer key={artifact.artifactId} a={artifact} />
          ) : null}
        </article>
      </div>

      {withToc && (
        <div className={s.tocCol}>
          <Toc items={toc.items} go={toc.go} />
        </div>
      )}
    </div>
  );
}

function RailItem({
  page,
  current,
  onOpen,
}: {
  page: Page;
  current: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={s.item}
      aria-current={current ? 'page' : undefined}
      onClick={() => onOpen(page.id)}
      data-nav=""
    >
      <span className={`${s.itemTitle} type-table`}>{page.title}</span>
      <span className={`${s.itemMeta} type-meta`}>
        <span>{page.meta}</span>
        {page.tag && <Tag tag={page.tag} />}
      </span>
    </button>
  );
}
