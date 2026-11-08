# Paylocity: what a large site taught us (2026-11-07 → 08)

Project `prj-6ad0a7ef`, website playbook 0.11.0, source https://www.paylocity.com/ (AEM, Scene7
images, Vidyard video, Cloudflare). Paused by the Director in Migration on 2026-11-08 to
reconcile what we learned before going on.

## Where it stopped

| | |
| --- | --- |
| Spend | $206 of $2,400 · 75.9M tokens · 8.9 h |
| Source | 2,693 URLs in the sitemap; the crawl read about 150–190; 64 pages in the Blueprint |
| Plan | 156 tasks: 68 done, 49 waiting, 22 ready, 11 planned |
| Pages | 7 of 64 done (2 accepted with differences for UAT), 49 waiting on component fixes |
| Components | 17/17 registered, 7/17 ported, 8/18 integrated, 7/7 templates |
| Reviews | 678: 255 accepted, 423 rejected; 405 of the rejections were page migrations |
| Site refusals | 67 answers of 429, then a Cloudflare bot check on some reads |

Most of the cost after Discovery went to page attempts that could not pass: they failed on shared
parts (footer, header logo, hero) that no page task could fix.

## The lessons, and where each one stands

**Fixed in production** means merged and deployed; it reaches running projects where it is a tool
or check change, and new projects where it is a playbook change.

| # | Lesson | Evidence here | Status |
| --- | --- | --- | --- |
| 1 | **Fill the shared header, footer and navigation once, before any page.** Pages that each edit one shared datasource race and all fail the same way. | 183 page rejections on the Site Footer; a Director note asking for one task did nothing (agents can't create tasks) | Fixed for new builds: [PR #13](https://github.com/slamensdicreon/icreon-claude/pull/13), playbooks 0.12.0 and demo 0.2.1 (`migrate-shared-chrome`, `parity.chrome`, attribution owner `shared`) |
| 2 | **"Content not resolved" is a broken rendering, not missing content.** `isContentResolved: false` means the Component Query or datasource failed. | The footer's columns existed all along; 5 rounds of content and query edits before the query was right | Fixed: [PR #14](https://github.com/slamensdicreon/icreon-claude/pull/14), the checks say so and the fix goes to the rendering registrar |
| 3 | **Allow a media host's sibling CDN.** | `play.vidyard.com` → `cdn.vidyard.com` blocked 12 times | Fixed: PR #14 |
| 4 | **Slow down when the site asks.** Wait the Retry-After and try again rather than fail. | 67 × 429; partial snapshots | Fixed: PR #14 (two retries, capped at 15 s) |
| 5 | **Embedded images and Director files.** Logos written into CSS as `data:` URIs; the Director must be able to hand the team a file. | The logo card stalled the media task | Fixed: [PR #12](https://github.com/slamensdicreon/icreon-claude/pull/12) |
| 6 | **Tool friction costs attempts.** File lists sent as JSON text; Playwright/BeautifulSoup selectors; empty `layout.compose` calls. | 26 `fs.write` refusals, "browser unreachable" for bad selectors, ~10 empty compose calls | Mostly fixed: PR #14 (fs.write, selector message). Empty compose calls: open (#14 below) |
| 7 | **A logo has variants.** The footer's logo is white on dark; the header needs the coloured one. | **178 of the 180 page rejections after the footer fix name the header logo**; the card defaulted to sending the header code back, which can't fix it | **Open, now the top blocker.** Immediate: upload the source header's coloured logo and set it on Main Header. Lasting: the media inventory records each logo by where it appears |
| 8 | **A shared component reworked page by page churns.** Every page failing on the Hero sends it back with its own list. | Hero Banner rejected 4 times, Header and Card Grid twice each, 109 page rejections citing the Hero after the footer fix | Open: gather a round's send-backs to one component into one brief, and re-check waiting pages once, after it lands |
| 9 | **The role that edits a rendering can't see the page.** | Register Site Footer edited the query three times and could not load the page to verify | Open: give the rendering registrar a read of the editing host's layout data |
| 10 | **Decide scope from the sitemap, not the sample the crawl reached.** `blueprint.coverage` compares with the inventory, so the sample silently became the scope. | 64 of 2,693 URLs, approved without anyone seeing the gap | Open: coverage against the sitemap's sections, and a scope decision at intake (bulk content by import) |
| 11 | **Read the source once.** Agents re-read live pages on every attempt, which is what the site throttled and then bot-checked. | 35 snapshot and 27 styles 429s during page migration; a visual comparison ran against the bot-check page | Open: reuse Discovery's snapshots and screenshots in page migration and parity; refuse to compare against a challenge page |
| 12 | **Crawl a big site by section.** One crawl times out; the parity re-crawl re-read the whole site. | Crawl stopped for time; K0 procedure says "crawl the source root" | Open: section crawl from the sitemap; the parity re-crawl reads only the Blueprint's pages (fix K0) |
| 13 | **Shared resources serialize.** | Available Renderings group lock, `page-designs.map` rewrites, 8 integration-branch races | Partly: lessons K-227 and K-230 are proposed (below). Open: batch registrations into one group write |
| 14 | **Director notes are guidance, not tasks.** | The footer note was acknowledged and nothing happened until a task was re-run | Open: a Director "add task" (or a note the Lead turns into one) |
| 15 | **Small tool gaps.** | Item names with punctuation rejected; `item.read` refuses IDs; template IDs from Sitecore's docs that don't exist on the tenant | Open |
| 16 | **The 404 page.** | The head serves its own fallback, so no header or footer; retries can't fix it | Open (queued earlier): the head renders the Sitecore 404 item |
| 17 | **HubSpot forms belong to the client.** | Form IDs unreadable behind the bot check; 3 cards | Settled for this build by Director note: forms placed without IDs, logged as known gaps |

## Knowledge the team proposed (waiting for the Director)

Seven entries from this project wait in Knowledge → Review proposals. My recommendation on each:

| Ref | Proposal | Recommendation |
| --- | --- | --- |
| K-226 | Before submitting, check every read you rely on succeeded (429, 403, partial) | Approve, scoped everywhere: true for every role that reads a source |
| K-227 | Plan Available Renderings additions so registrars don't queue for the group lock | Approve |
| K-228 | Register a component whose rendering needs a shared datasource folder | Approve |
| K-229 | Prove a pilot slice of components is ready for Page builder | Approve |
| K-230 | Keep every page-design mapping entry you didn't write | Approve |
| K-231 | Create the header and footer partial designs and get them onto the pages | Approve |
| K-232 | Validate page templates and page designs | Approve |

## What to add as knowledge from this run

These aren't proposals yet; they are the lessons above that agents (not engineering) act on:

- **Content migrator:** never edit a shared datasource from a page task; its failures wait on the
  shared task (now also in the 0.12.0 prompt).
- **Rendering registrar:** when a component comes back `isContentResolved: false`, check every field
  and fragment its Component Query names against the real templates before anything else.
- **Media migrator:** upload each logo variant the source uses (header, footer, favicon), named by
  where it appears; never put a footer logo in the header.
- **Every role reading the source:** a page that answers 429 or shows a bot check is not the page;
  don't build or compare from it.

## Before resuming Paylocity

1. Fix the header logo (lesson 7): upload the coloured logo from the source header and set it on
   Main Header. This is what most waiting pages fail on now.
2. Let the Hero rework land, then let the waiting pages re-check once.
3. Approve or edit the seven proposals.
4. Consider pacing: the site is bot-checking the team. Fewer pages in flight (a lower batch size)
   means fewer live reads until lesson 11 is built.
