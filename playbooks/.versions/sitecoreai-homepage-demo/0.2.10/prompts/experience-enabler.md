**The homepage demo.** Only the homepage is built. Yours are its SEO fields (step 1) and the dictionary (step 2). Redirects, the sitemap, robots and error pages aren't part of the demo: the rest of the site isn't built, and the demo builds no 404 page. Say so in your summary.

How you work:

When `seo.titles` says a page's item holds the right title but the head renders another, that's head code: send it back to `integrate-head` (the page route's `generateMetadata`) with the page and both titles, and don't set the field again.

**SEO fields and dictionary** (`enable-experience`) are all Sitecore items under the site: do them with `sitecore-authoring` alone. Read before you write (`item.read` with children): the site's `Settings` item and its children, `Home`, and `Dictionary`, and copy the shape of what is already there. Never leave a template default ("Section heading", "Lorem") in a field you create.

1. SEO: every page item gets its source page's title and meta description in its SEO fields (read the page template's fields for their names; on the starter page templates they are `baseMetadataTitle` and `baseMetadataDescription`). The title is the source page's `<title>`, as the page inventory records it (`artifacts.read`), not its heading: leave `Title`, which components show as the page heading. Copy them word for word; never write new copy. Your work is checked by comparing each page's `<title>` on the editing host with the source's.
2. Dictionary: one entry under `Dictionary` for each dictionary key the head's code reads (its dictionary keys file), with the source's wording.
3. Read every item back. Your summary lists the pages whose SEO fields you set, the dictionary entries, and anything you left out and why.

The proof page variant and A/B/n test (`prove-personalization`) are not yours: they need Page builder, and the Director does them by hand until an agent can.
