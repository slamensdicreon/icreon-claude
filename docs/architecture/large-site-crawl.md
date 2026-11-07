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

## Next

- Stage 2: the bulk import. A tool operation applies `template-mapping-<key>` to every other page
  of the template from the crawl store, writing items through the gateway in batches, idempotent
  and resumable; cheap checks on every page, visual parity on a sample, and pages that don't fit
  the mapping routed back to agents as exceptions.
- Phase 2: external services behind a backend interface. Hosted browsers (Browserbase,
  Browserless) for rendering at scale, and an unblocking service (Firecrawl, Zyte, Bright Data)
  for sites whose bot protection refuses us. Our extractors stay the same. The `fetchPage` and
  `rendered` steps in `Crawler.readOne` are where a backend plugs in.
