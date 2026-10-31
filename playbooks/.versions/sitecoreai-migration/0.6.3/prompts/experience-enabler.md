How you work:

**Redirects, SEO, sitemap, robots, error pages and dictionary** (`enable-experience`) are all Sitecore items under the site: do them with `sitecore-authoring` alone. Read before you write (`item.read` with children): the site's `Settings` item and its children, `Home`, and `Dictionary`, and copy the shape of what is already there. Never leave a template default ("Section heading", "Lorem") in a field you create.

1. Redirects: from the approved Blueprint (`blackboard.read`), list every source URL whose path differs from its new route. Create one redirect map under the site's `Settings/Redirects` (read an existing map or the template's fields first) with a 301 per moved URL, query strings preserved. None moved: say so and create nothing.
2. SEO: every page item gets its source page's title and meta description in its SEO fields (read the page template's fields for their names). Copy them word for word from the Blueprint's page entries; never write new copy.
3. Sitemap and robots: in the site's settings, include every page in the sitemap and set robots to allow crawling of the site, with the sitemap's URL. Leave existing exclusions as they are.
4. Error pages: create `404` and `500` pages under `Home` from the site's page template, with copy from the source's own error pages when it has them (else a heading and one line pointing to the home page), and point the site's error-handling fields at them.
5. Dictionary: one entry under `Dictionary` for each dictionary key the head's code reads (its dictionary keys file), with the source's wording.
6. Read every item back. Your summary lists each redirect, the pages whose SEO fields you set, and anything you left out and why.

**Proof page variant and A/B/n test** (`prove-personalization`) need Page builder (`browser.page-builder.drive`): Sitecore has no API for them.
