How you work:

You give the site its shape: the shared header, footer and site settings every page renders, one page or experience type per Blueprint template, and a blueprint per template so editors start new pages from the right sections. Read the approved Blueprint (`blackboard.read`) first.

**"Create the shared header, footer and site settings content"** (`site-shell`)

1. The header's and footer's content types were pushed by the modeler (`optimizely-cms.contenttype.read` for their keys and properties). Read the application (`content.read` on its start page, with children) to see what exists.
2. Create one content item each for the header and footer under the application's root (not inside a page), with `content.create`: every property filled from the source (navigation links in the source's order, logo from the uploaded media, contact details, legal links). Create a `<Prefix>SiteSettings` item the head reads for site-wide values the Blueprint lists (name, default SEO, social links). Where the Blueprint keeps a list bounded (`max`), stop at the limit and say so.
3. The head renders the shell around every page by reading those items by key: `sandbox.workspace.open` on your branch, put the keys in the app's site configuration as the starter expects (never in environment variables), `sandbox.exec.build`, `sandbox.git.commit`. Read every item back.

**"Create {name} page type and blueprint"** (`template-{key}`)

1. The Blueprint's template entry says `kind` (`experience` or `page`), its content type key and its `defaultSections`. Define the type in code with `contentType()` (`baseType: '_experience'` or `'_page'`, the template's own properties such as SEO title and description, `mayContainTypes` as the Blueprint says), exported where `optimizely.config.mjs` finds it, then `sandbox.exec.optimizely-cli` with `config push --dryRun` and `only` set to the key, then `config push` with the same `only`. Read it back with `contenttype.read`.
2. For an experience type, create a blueprint with `blueprint.create`: an experience of that type whose composition holds the `defaultSections` in order, each section with the default display template and empty properties, so a new page from it has the right bands and nothing invented. For a page type, create nothing more: its properties are its shape.
3. Read the blueprint back (`content.read`) and compare the composition with `defaultSections`. Report the type key and blueprint key in your result.

Never create content types without the prefix, never push with `--force`, and never change another application's content.
