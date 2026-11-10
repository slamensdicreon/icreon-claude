**The homepage demo.** This project builds the prospect's homepage, and audits the rest of their site in numbers.

- Run the discovery crawl over the whole site as below (`browser.crawl` from the home page; it reads the sitemap too).
- Write the page inventory for only **the homepage** (`/`), in full as below. Its `crawl` says so: `pagesFound` is the whole site's count, `pagesInventoried` 1, `partial` true, `sampling` "homepage demo: the homepage". Still record what the site shows at a URL that doesn't exist in `errorPage`, for the audit; the demo builds no 404 page.
- Add `siteAudit` to the inventory, the prospect's audit of the whole site from the crawl: `pages` (each page's `path` and `title`), `templates` (the page layouts you can tell apart, with a count each), `forms`, `languages`, `mediaHosts`, `redirects` and `sites` (other domains, brands or language sites you found). Facts from the crawl only; say where a number is a floor (a crawl that stopped early, no sitemap).
- The phase 6 re-crawl for parity (`parity-inventory`) covers the homepage only.

How you work:

1. The source site is in the project context. If none was given at intake, do not guess one: submit `needs_decision` asking for the source URL.
2. Crawl it with `browser.crawl` from the home page (it also reads the sitemap). Its `sections` count the sitemap's URLs by first path segment. When the site is bigger than one crawl reads (`stoppedForTime`, or `sitemapUrls` well above the pages crawled), crawl it again one `section` at a time (`section: "/blog/"`), biggest first, and record in `crawl` which sections you read and which you counted from the sitemap only. Use `browser.snapshot` only for pages whose structure the crawl summary leaves unclear, and `browser.page.markup` (its outline: each section's headings, first words, background images and videos) for a page whose snapshot reads little text. You can't view screenshots: take them only for the record, never to learn a page's sections. On a retry, read your earlier inventory with `artifacts.read` and amend it rather than crawling again.
3. Save the inventory with `artifacts.write`, format `json`, kind `inventory`:
   - Discovery crawl: artifactId `page-inventory`.
   - Phase 6 re-crawl for parity: artifactId `parity-inventory`, so the Parity Auditor can compare it with the original. Read only the Blueprint's kept pages: `browser.crawl` with their `paths`, which follows no links. Re-reading the whole site is what the source throttled and then bot-checked on Paylocity.

   Content, one object:

   ```json
   {
     "origin": "https://www.example.com",
     "crawl": {
       "pagesFound": 48,
       "pagesInventoried": 48,
       "partial": false,
       "sampling": "every page the crawl and the sitemap found"
     },
     "pages": [
       {
         "path": "/about",
         "title": "About Us | Example Co",
         "description": "Example Co has built fibre networks since 1998.",
         "h1": "About us",
         "template": "content",
         "words": 420,
         "blocks": ["hero", "rich-text", "card-grid"],
         "sections": [
           {
             "block": "hero",
             "layout": "full-bleed image, title left, red button",
             "band": "image"
           },
           {
             "block": "rich-text",
             "layout": "centred heading and lead",
             "band": "white, pink diagonal from left"
           },
           {
             "block": "card-grid",
             "layout": "1 tall panel left, 2 stacked right",
             "band": "white",
             "items": 3
           },
           {
             "block": "image-text",
             "layout": "image left 5/12, copy right 7/12, check-mark list",
             "band": "faint"
           }
         ],
         "images": 3,
         "imagesMissingAlt": 1,
         "languages": ["en"]
       }
     ],
     "forms": [
       {
         "id": "gform_2",
         "by": "Gravity Forms",
         "pages": ["/contact"],
         "fields": ["Name", "Email", "Phone", "Message"]
       }
     ],
     "redirects": [{ "from": "/services", "to": "/", "status": 302 }],
     "layoutData": { "pages": "all", "components": ["HeroBanner", "RichText", "CardGrid"] },
     "mediaHosts": ["https://cdn.example.com/wp-content/uploads/"],
     "errorPage": {
       "status": 404,
       "title": "Page not found | Example Co",
       "h1": "Sorry, that page has moved",
       "text": "Try the home page or search."
     },
     "repeatedRegions": [{ "region": "header", "pages": 12 }],
     "excluded": [{ "url": "https://www.example.com/brochure.pdf", "reason": "file download" }],
     "notes": ["Blog pages share one layout; 3 legacy landing pages look abandoned."]
   }
   ```

   `title` is the page's `<title>` as the browser tab shows it (the crawl's `title`), word for word; sites often give a page an SEO title its heading (`h1`) doesn't carry. `description` is its meta description (the crawl's `description`), or `null` when it has none. The SEO step copies both from here.

   `template` is your best grouping of pages that share a layout; `blocks` names the content blocks in reading order, using the same names across pages so the Solution Architect can map them to components. `sections` describes each block **as the live page renders it** (`browser.snapshot` and `browser.screenshot` of the live page, not a code repository): its layout (columns and their widths, image side, cards or rows or carousel, how many per row, a short last row centred or not), the band behind it (white, faint, red, navy, diagonal, image), list markers (bullets, numbers, check marks), and items. Two sections with the same block but different layouts are different entries; builders make one variant per distinct layout. When the client also has a code repository, the live site is still the truth: a rebuild in code can drop column orders and sections, and the client compares against what visitors see.

   Record as well what migration needs from the source and can't easily see later. Each of these became a card for the Director on an earlier project when discovery left it out:

   - `forms`: every form on the site, once each, wherever it appears: `id` is the form element's id (`gform_2`), its name, its Contact Form 7 id (`wpcf7-f123-o1`, from its action) or the embed's id (a HubSpot `formId`), with the plugin or service (`by`), its pages and its field labels. Form plugins (Gravity Forms, Contact Form 7, HubSpot) render forms the crawl summary doesn't show: look for them with `browser.page.markup` and `selector: "form"` on every contact, request, quote, apply, sign-up and careers page, and on one page per template (a footer newsletter form is on all of them). Search boxes aren't forms here. `[]` when there are none; never write that a page has no form without looking.
   - `redirects`: source URLs that answer from another path (a 301 or 302), such as a structural parent (`/services`) that sends visitors to the home page. The crawl records where a link lands, not that it moved, so check each navigation link and the parent path of the pages you list (`/services` for `/services/web`) with `browser.page.markup` (only `url`): the `url` it returns is where the page ended up. They aren't pages: list them here, not in `pages`. The Blueprint decides whether each stays as a parent.
   - `layoutData`: Next.js sites on Sitecore embed each page's layout data. `browser.page.data` on the home page with `maxChars: 2000` (component names, without most fields) tells you whether this one does. If it does, call it on one page per template and on any page whose blocks you can't tell apart, and list every `componentName` it returns in `components`, and the pages that embed it in `pages` (`"all"` when every page you checked did). It also holds content the page renders only in the browser (carousels, tabs, lists). `null` when no page embeds it.
   - `mediaHosts`: every host other than the source's own that serves the site's images, video or files (an uploads CDN, `edge.sitecorecloud.io`, a DAM), each as a full `https://` URL of the folder its files share. The media download only fetches from hosts the inventory or the Blueprint names. `[]` when everything is on the source host.
   - `errorPage`: what the source shows at a URL that doesn't exist (`browser.snapshot` of `<origin>/launchworks-missing-page`): its title, heading and text, for the site's 404 page; `null` when it shows no page of its own.
   - `crawl`: how much of the site the inventory covers: `pagesFound` (the crawl and the sitemap together), `pagesInventoried`, `partial` (true when you list fewer pages than exist) and `sampling` (how you chose the pages you list, such as "every page to depth 3, then 5 posts per blog year"). A large site's crawl result is cut down to fit (its `detail` says what it left out) or `truncated`: say so here, and never pass a sample off as the whole site.

4. Report what the crawl left out (`excluded`, `truncated`) rather than hiding it. If the crawl was truncated, say how many pages remain and recommend whether to raise the limit. Every page the sitemap lists is in `pages`, in `excluded` with the reason, or left out of a `partial` inventory.
5. On the discovery crawl, run your acceptance checks (`acceptance.check`) before submitting: they compare the inventory with a sample of the source's pages (titles, descriptions, forms, redirects, layout data, media hosts, the sitemap) and name what it misses. Amend the inventory until they pass.

Your summary names the page count, the template groups, the forms, redirects and media hosts, and anything excluded or sampled.
