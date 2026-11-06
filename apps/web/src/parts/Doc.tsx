import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { blobUrl } from '../lib/api';
import { useApp } from '../state';

let hooked = false;
import ds from './doc.module.css';

const CALLOUTS: Record<string, string> = {
  NOTE: 'Note',
  TIP: 'Tip',
  IMPORTANT: 'Important',
  WARNING: 'Warning',
  CAUTION: 'Caution',
};

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/**
 * Agent-written Markdown, rendered for people: GitHub-flavoured Markdown with callouts
 * (> [!NOTE] …), ```mermaid diagrams, screenshots and images from the project's blob store
 * (blob://…), links between documents (artifact://<id>), and a contents list for long documents.
 * Everything is sanitised: an agent's document can't run script in the Control Center.
 */
export function MarkdownDoc({
  text,
  projectId,
  contents = true,
}: {
  text: string;
  projectId: string;
  /** Show the document's own contents list; off where the page beside it already lists the headings. */
  contents?: boolean;
}) {
  const { setUi } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  const { html, toc } = useMemo(() => render(text, projectId), [text, projectId]);

  // Diagrams render after the HTML is in place; mermaid is loaded only when a document has one.
  useEffect(() => {
    const blocks = ref.current?.querySelectorAll<HTMLElement>('[data-mermaid][data-src]');
    if (!blocks?.length) return;
    let stop = false;
    void import('mermaid').then(async ({ default: mermaid }) => {
      const dark = document.documentElement.dataset.theme === 'dark';
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: dark ? 'dark' : 'neutral',
        fontFamily: 'inherit',
      });
      for (const [i, el] of [...blocks].entries()) {
        if (stop) return;
        // Encoded: DOMPurify drops attribute values holding "-->", which every arrow has.
        const src = decodeURIComponent(el.dataset.src!);
        try {
          const { svg } = await mermaid.render(`doc-mermaid-${Date.now()}-${i}`, src);
          el.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject'],
          });
          el.removeAttribute('data-src');
        } catch {
          el.innerHTML = `<pre class="${ds.pre}">${escape(src)}</pre><p class="${ds.quiet}">This diagram could not be drawn.</p>`;
        }
      }
    });
    return () => {
      stop = true;
    };
  }, [html]);

  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const id = a?.dataset.artifact;
    if (id) {
      e.preventDefault();
      setUi({ wbArtifact: id, bpFilter: 'all' });
    }
  };

  const withToc = contents && toc.length >= 3;
  return (
    <div className={ds.doc} data-toc={withToc || undefined}>
      {withToc && (
        <nav className={`${ds.toc} type-meta`} aria-label="Contents">
          <span className={`${ds.tocLabel} type-label`}>Contents</span>
          {toc.map((t) => (
            <a key={t.id} href={`#${t.id}`}>
              {t.text}
            </a>
          ))}
        </nav>
      )}
      <article
        ref={ref}
        className={ds.body}
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

function render(text: string, projectId: string) {
  const toc: { id: string; text: string }[] = [];
  const seen = new Map<string, number>();
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Heading) {
        const inner = this.parser.parseInline(t.tokens);
        const base = slug(inner) || 'section';
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = `h-${n ? `${base}-${n}` : base}`;
        if (t.depth === 2) toc.push({ id, text: inner.replace(/<[^>]+>/g, '') });
        return `<h${t.depth} id="${id}">${inner}</h${t.depth}>`;
      },
      code(t: Tokens.Code) {
        if (t.lang === 'mermaid') {
          return `<figure class="${ds.mermaid}" data-mermaid="" data-src="${encodeURIComponent(t.text)}"><pre class="${ds.pre}">${escape(t.text)}</pre></figure>`;
        }
        const lang = t.lang ? `<span class="${ds.codeLang}">${escape(t.lang)}</span>` : '';
        return `<div class="${ds.code}">${lang}<pre><code>${escape(t.text)}</code></pre></div>`;
      },
      table(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: 'th' | 'td', i: number) => {
          const align = t.align[i];
          return `<${tag}${align ? ` data-align="${align}"` : ''}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        };
        const head = `<tr>${t.header.map((c, i) => cell(c, 'th', i)).join('')}</tr>`;
        const body = t.rows
          .map((r) => `<tr>${r.map((c, i) => cell(c, 'td', i)).join('')}</tr>`)
          .join('');
        return `<div class="${ds.table}"><table><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
      },
      image(t: Tokens.Image) {
        // Only the project's own stored images (and inline data): an outside image would tell its
        // server who opened the document, and when.
        const src = t.href.startsWith('blob://')
          ? blobUrl(projectId, t.href)
          : /^data:image\/(png|jpe?g|gif|webp);/i.test(t.href)
            ? t.href
            : null;
        if (!src)
          return /^https?:\/\//.test(t.href)
            ? `<a href="${escape(t.href)}" target="_blank" rel="noopener noreferrer">${escape(t.text || t.href)}</a>`
            : escape(t.text);
        const caption = t.text ? `<figcaption>${escape(t.text)}</figcaption>` : '';
        return `<figure class="${ds.figure}"><img src="${escape(src)}" alt="${escape(t.text)}" loading="lazy" />${caption}</figure>`;
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, t: Tokens.Link) {
        const inner = this.parser.parseInline(t.tokens);
        const m = /^artifact:\/\/([a-z0-9][a-z0-9-]*)/.exec(t.href);
        if (m) return `<a href="#" data-artifact="${m[1]}">${inner}</a>`;
        if (t.href.startsWith('blob://'))
          return `<a href="${escape(blobUrl(projectId, t.href))}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
        const external = /^https?:\/\//.test(t.href);
        return `<a href="${escape(t.href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`;
      },
    },
  });
  let html = marked.parse(text, { async: false });
  // GitHub-style callouts: a blockquote that opens with [!NOTE], [!WARNING]…
  html = html.replace(
    /<blockquote>\s*<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*/g,
    (_, kind: string) =>
      `<blockquote class="${ds.callout}" data-kind="${kind.toLowerCase()}"><p class="${ds.calloutTitle}">${CALLOUTS[kind]}</p><p>`,
  );
  // A link that opens a new tab never hands that tab a handle back to the app.
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('target'))
        node.setAttribute('rel', 'noopener noreferrer');
    });
  }
  // Agent-written documents come from untrusted sites: no styles that could restyle the app, no
  // forms or fields that could imitate a sign-in, nothing embedded.
  html = DOMPurify.sanitize(html, {
    ADD_ATTR: [
      'target',
      'data-artifact',
      'data-src',
      'data-mermaid',
      'data-kind',
      'data-align',
      'loading',
    ],
    FORBID_TAGS: [
      'style',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'option',
      'iframe',
      'object',
      'embed',
      'link',
      'meta',
      'base',
    ],
    FORBID_ATTR: ['style', 'formaction', 'srcset'],
  });
  return { html, toc };
}
