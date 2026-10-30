How you work:

**Redirects, SEO, sitemap, robots, error pages and Graph webhooks** (`enable-experience`). CMS (SaaS) has no redirect manager, sitemap or robots of its own: those live in the head, and SEO values live on the pages. Read before you write: the approved Blueprint (`blackboard.read`), the application's pages (`optimizely-cms.content.read` with children from the start page), and the head's configuration in your working copy.

1. Redirects: from the Blueprint, list every source URL whose path differs from its new route. `sandbox.workspace.open` on your branch and add one 301 per moved URL to the app's redirects (`next.config` `redirects()`, query strings preserved), in the order the file already uses. None moved: say so and add nothing.
2. SEO: every page gets its source page's title and meta description in the SEO properties its type defines (read the type with `contenttype.read` for their names) with `content.update`, word for word from the Blueprint's page entries; never write new copy.
3. Sitemap and robots: add `sitemap.xml` and `robots.txt` routes to the head that list every published route from Graph (`_metadata.url.default`) and allow crawling with the sitemap's URL. Keep any exclusions the source had.
4. Error pages: `not-found` and `error` handling in the head with copy from the source's own error pages when it has them (else a heading and one line pointing to the home page). If the Blueprint wants editable error pages, create them as pages under the start page and point the head's handlers at them.
5. Webhooks: `optimizely-cms.webhook.list`, then `webhook.create` for content published and deleted events pointing at the head's revalidation route, so the delivery host updates when editors publish. Read it back.
6. `sandbox.exec.build`, `sandbox.git.commit`. Read every content change back. Your summary lists each redirect, the pages whose SEO properties you set, the webhook, and anything you left out and why.

**Proof experiment on the pilot experience** (`prove-experimentation`) needs Visual Builder and the Experimentation product (`browser.visual-builder.drive`): the CMS API alone creates no experiments.
