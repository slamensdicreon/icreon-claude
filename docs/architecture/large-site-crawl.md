# Crawling large sites

Discovery used to read the source site in one tool call (`browser.crawl`): one page at a time,
each in a real browser, within the gateway's 10-minute call limit and capped at 500 pages, with
the whole result in the agent's context. paylocity.com (2,693 URLs in its sitemap) couldn't fit:
the crawl stopped after about 200 pages, and even a complete result would have been too big for
the model. This is the replacement. The old operation stays for small sites and for projects
pinned to older playbook versions.

## What changed

| | Before | Now |
| --- | --- | --- |
| Where the crawl runs | Inside one tool call (7-minute cap) | A background job; tool calls start and follow it |
| Size | 500 pages at most | 5,000 by default, up to 25,000 |
| How pages are read | Each in Chromium, one at a time, settling up to 6 s | Plain HTTP, several at once, parsed offline (about 3 ms a page); Chromium only for pages built by scripts |
| Pace | Fixed | Adaptive: halves on a 429 or 503, honours Retry-After, recovers on success; robots.txt Crawl-delay (up to 2 s) |
| Discovery | `/sitemap.xml` only | robots.txt (rules and sitemaps), sitemap indexes, gzipped sitemaps, the real origin after redirects |
| What the agent gets | Every page, cut down to fit | Progress, templates with examples, redirects, exclusions; pages 200 rows at a time |
| Restarts | The crawl is lost | Resumed from where it was, by the next worker |
| Re-crawl (phase 6) | Everything again | Optionally only what the sitemap says changed |

On a synthetic 3,000-page site shaped like paylocity.com (the test in
`tool-servers/browser/test/crawl.test.ts`), the whole site is read in seconds on a laptop with
about one request per page, versus the old crawl's ~200 pages in 7 minutes. A real site is
slower (network, and the pace it allows), but the crawl now takes as long as it needs.

## Operations (browser tool server)

- `crawl.start { url, maxPages?, concurrency?, respectRobots?, fresh?, changedOnly? }` returns
  at once with a `crawlId`. A crawl of the same site that is still running, or finished within a
  day, is returned instead of starting another (`fresh: true` overrides; `changedOnly: true` keeps
  the last crawl's pages whose sitemap `lastmod` is unchanged).
- `crawl.status { crawlId?, waitSeconds? }` waits up to 5 minutes for the crawl to finish, then
  reports progress, pace and time left, how pages were read, redirects, exclusions by reason,
  repeated header/nav/footer regions, and the **templates**.
- `crawl.query { crawlId?, template?, path?, text?, state?, limit?, offset? }` returns pages 200
  rows at a time.
- `crawl.page { crawlId?, url }` returns one page as read, without visiting the site again.
- `crawl.stop { crawlId? }` stops a crawl and keeps what it has read.

Every answer is bounded, whatever the site's size. A crawl belongs to its project: another
project's `crawlId` reads as not found.

## Templates

`crawl/templates.ts` groups pages using two signals: where a page sits (its URL pattern,
`/resources/learn/*`) and how it is built (its layout, the sequence of sections in its main
content, looking through single wrappers; `extractPage` records it as `layout`). Pages under
one parent that are built alike form one template. A parent can hold several templates (a
listing and its articles). Groups under different parents that are built the same way merge
(`/products/hr/*` with `/products/finance/*`). Each template has a stable id (from its main
pattern), its patterns with counts, its page count, average words, layout, and three example
pages (the longest, a typical one and the shortest).

Sitemap URLs are queued round-robin across sections, so every template appears in the first
minutes of a crawl and agents can start on the examples while the rest is read.

## How a page is read

1. `fetchPage` (`crawl/http.ts`): plain HTTP GET with a browser's headers. Redirects are
   followed one hop at a time, each checked against the project's hosts and for private
   addresses, the same rule `fetch.asset` and `page.data` use.
2. `OfflineParser` (`page-load.ts`): the HTML goes into a reused page of an offline browser
   context (scripts off, every request refused), and `extractPage` runs on it. This gives the
   same extract the browser makes, without loading anything.
3. If the page looks built by scripts (an empty `#root`, `#__next` or `#app` container, or almost
   no words and no images), it is read again in a real browser through the egress proxy. The
   crawl learns per URL pattern: after three tries where the browser added nothing, it stops
   rendering that section's pages.
4. A 401 or 403 is retried in a real browser (bot rules often turn away plain clients only). If
   the browser is refused too, the page is excluded as refused. If every page is refused, the
   crawl says so and tells the agent to ask the Director.
5. A 429 or 503 slows the pacer and puts the URL back in the queue (up to 4 tries).

The crawler learns the site's spelling of paths. Pages are kept without a trailing slash, but a
site that serves `/about/` redirects `/about`, so after the first such redirect it asks for
`/about/` directly. Without this, every page would cost two requests.

## Storage and resuming

`CrawlStore` has two implementations: `PostgresCrawlStore` (migration `007_crawls.sql`:
`lw_crawls` for the job, `lw_crawl_urls` for every URL with its state, summary and extract) and
`MemoryCrawlStore` for tests and single-process runs.

The worker makes one crawler for all its stacks (`createCrawler` in `packages/stack`). A crawl is
held by one worker at a time through a lease renewed every 20 seconds. On SIGTERM, the worker puts
its claimed URLs back and releases its leases, and the crawl stays `running`. The next worker
resumes it at start (`resumeAll`), or as soon as an agent asks for its status. Claims use
`FOR UPDATE SKIP LOCKED`, so several workers could later share one crawl's queue.

A crawl runs for at most 3 hours (`maxRunMs`), then stops with what it has read.

## Agents

The Content Analyst (sitecoreai-migration, optimizely-saas-migration) is granted the new
operations, and its prompt says how to use them. For a large site (about 400 pages or more), the
inventory lists every one-off page and the examples of each large template, adds `templates`, and
marks itself `partial` with the `crawlId`, so later tasks can list a template's pages. The
discovery acceptance check already accepts a partial inventory that says how it sampled.

Cypher's heads-up (`sourceNotice` in `packages/stack/src/operator.ts`) reads `crawl.status`
summaries for throttling, refusals and size, since a background crawl's own requests are not
steps.

## Lessons from a dry run against paylocity.com

A read-only crawl of 300 pages (no Sitecore) found two things a synthetic site couldn't:

- **A bot check on every plain request.** Paylocity answers plain HTTP with a challenge page
  (status 200) that a real browser passes. Stored as is, every page would have been the check.
  The crawler recognises challenge pages from the common vendors and titles and reads them in a
  browser. If the browser is challenged too, it excludes them as refused. After 10 such pages and
  no plain success, it goes to the browser directly. Paylocity reads at about 130 pages a minute
  this way, so about 20 minutes for its 2,693 pages.
- **AEM markup defeated the layout fingerprint.** The content sits under seven or more single
  wrappers, and every page reduced to `div`, so the whole site became one template. The
  fingerprint now looks through twelve wrappers, skips grid, container and style classes, and
  names a generic section by the component inside it. Layouts under three tokens never merge URL
  sections. The 300 pages group into the site's real sections.

`crawl.status` also warns when many pages share one title (a challenge, error or consent page
served in place of content).

## Planning per template (large sites only)

A large site is planned and migrated per template; a small site page by page, exactly as before.
The rule is code, not agent judgment: `platforms/sitecoreai/page-templates.ts`.

- **Large** means the discovery crawl found `LARGE_SITE_PAGES` (400) pages or more. Each crawl
  template of `BULK_TEMPLATE_PAGES` (20) pages or more becomes an item of the Blueprint's
  `page-templates` collection: its crawl template, its Sitecore page template, and a field
  mapping (`{ component, field, from }`). Two to five of its example pages go in `pages` with
  `status: "merge"` and `attrs.mergedInto` the template, so they get no tasks of their own.
  Everything else (the home page, landing and one-off pages, templates under 20 pages) stays in
  `pages`, one task per page.
- **Small** sites have no `page-templates` collection. The check `blueprint.page-templates`
  (on `draft-blueprint` in the website playbook) fails a small site's Blueprint that has one,
  and a large site's that leaves a big template unplanned (it may be dropped with a reason).
- The plan template `prove-template-{key}` is `optional: true`: no placeholder before the
  Blueprint, and no tasks (rather than a plan error) when the Blueprint has no such collection.
  A small site's plan is therefore unchanged, task for task.
- `prove-template-{key}` (Content Migrator) builds the template's example pages from the mapping,
  corrects the mapping where real pages differ, and writes it as `template-mapping-<key>`. Its
  acceptance is the page checks, scoped to the example pages (`inScope` maps a `page-templates`
  task to the pages merged into it), and `template.mapping`, which checks the document keeps every
  field and records each example's page item.
- The Solution Architect can read the crawl (`crawl.status`, `crawl.query`, `crawl.page`) and
  layout data (`page.data`) to write mappings. The homepage demo shares the roles but not the
  rule: it builds only the homepage, even of a large site.

## The bulk import

After a template is proven, `import-template-{key}` (Content Migrator) runs `import.start` and
follows it with `import.status`. The importer (`packages/stack/src/import`) runs in the
background:

1. **Preflight**, before anything is written. It reads the page-templates item, the proven
   `template-mapping-<key>` (it must parse: see the mapping language below), and a finished crawl.
   It reads the example page in Sitecore (its item, `__Renderings`, its Data folder and each
   datasource item) and lists the template's other pages from the crawl. It refuses with a
   sentence the agent can act on: no proven mapping, a source it can't read, a component the
   example has no datasource for, or a datasource with child items that isn't copied whole.
2. **Each page** gets the mapped values from its source: plain HTTP, parsed offline (`css:`,
   `title`, `description`, `h1`), or from its embedded layout data (`data:`). The importer then
   creates the page item under its parent, the Data folder, each datasource (mapped fields
   filled, `same` fields copied, others set empty), and the example's layout with its datasource
   IDs pointed at this page's. Images are downloaded through `browser.fetch.asset` and uploaded
   once each to the template's `mediaFolder`.
3. **Every write goes through the gateway** as the task that started the import, with that role's
   grants and scope, write locks and audit trail. Step numbers are unique per page and attempt,
   so a retry reads and writes again.
4. **A page that doesn't fit** is an exception with its reason, for an agent: its parent isn't
   built, a mapped value is missing from its source, its source answers an error, or a write
   is refused. Timeouts and throttling are retried. `import.start` with `retry: true` queues
   exceptions again after a fix.
5. **Imports live in Postgres** (migration `008_imports.sql`), each held by one worker through a
   lease, and resumed after a restart. When an import finishes it writes `template-import-<key>`.

**Canary.** An import writes its first 5 pages, then runs the page checks on the ones written
(`head.pages-render`, `parity.render`). If they fail, or none could be written, it pauses with
the reason. `import.start` with `retry: true` writes those pages again with the fixed mapping,
then the rest. A mapping wrong in a way the examples didn't show costs 5 pages, not 800.

**Revert.** `import.revert` (with `confirm` set to the import's id, and only on the Director's
decision) moves each page the import created to the Recycle Bin, where it can be restored. It
removes the page's copied child items, then its datasources, then its Data folder, then the
page. Pages built before the import, and pages that have gained items the import didn't make,
are left and listed. A fresh import may follow.

**Item names.** A URL segment that isn't a valid Sitecore item name (letters, digits, spaces,
hyphens, underscores and `$`) is an exception, so the page's URL never changes silently.

`template.imported` (the task's acceptance) passes when the import is done, no more than 1 in 10
pages were exceptions (more means the mapping is wrong: fix it and retry), every exception page
now exists in Sitecore (the agent built it), and a spread of imported pages passes the page checks:
`parity.render` on 20 and `parity.visual` on 3.

### The mapping language

`{ component, field, from, as?, optional? }`. `component` is `page` or a datasource item's name
under the example's Data folder. `from` is `title`, `description`, `h1`, `path`, `same`,
`css:<selector>` (with ` @html` or ` @<attribute>`), or `data:<Component>.<field>`. `as` is
`text`, `html`, `image` or `link`. Parsed by `platforms/sitecoreai/mapping.ts`, which the Blueprint
check, the proof check and the importer all use.

Lists that differ per page (related links, cards) can't be mapped yet. A datasource whose child
items are the same on every page is copied whole (`field: "*"`, `from: "same"`). A template whose
pages differ in their lists stays page by page.

## Next

- Lists per page in the mapping (repeating source elements into child items).
- Phase 2: external services behind a backend interface. Hosted browsers (Browserbase,
  Browserless) for rendering at scale, and an unblocking service (Firecrawl, Zyte, Bright Data)
  for sites whose bot protection refuses us. Our extractors stay the same. The `fetchPage` and
  `rendered` steps in `Crawler.readOne` are where a backend plugs in.
